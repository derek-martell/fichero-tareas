/* Bridge for config/plan-nocturno. No timers, OAuth, DOM or automatic activation.
 * read/save operate on this document; save merges a top-level patch.
 * All asynchronous public methods return the persisted config; Google failures
 * reject AFTER retaining pending work. Offline enable/disable/sync resolve with
 * pending work; offline finish rejects with code 'nightly_pending' when work
 * remains, so the planning UI can show its saved-decision/pending-alert message.
 * call receives the adapter tool name and input, and returns raw Google payloads:
 * create_event -> {id}, delete_event -> any successful payload,
 * list_event_instances({eventId,startTime,endTime,pageSize,pageToken})
 *   -> {events:[{id,recurringEventId,start:{dateTime},status?}],nextPageToken?}.
 * Errors must reject (HTTP status in status/code/response.status or message).
 * getDay('YYYY-MM-DD') reads config/plan-YYYY-MM-DD
 *   -> {estado:'guardado'|'omitido',items:[{id,minutes}],orden:[ids],capacity}
 * or an empty record/null. Cancellation uses estado only.
 * connected() is synchronous. changed(message,error?) is optional.
 * Owned config fields: version:1, namespace:null|32 hexadecimal characters,
 * enabled:boolean (desired state), series:{[hour]:deterministicId},
 * pending:[{type:'create'|'delete',hour}|{type:'finish',day}], lastError:null|string.
 * completed:{namespace:null|string,evenings:[YYYY-MM-DD]} caches successful
 * cancellations for this generation (at most 31 nights, no older than 30 days).
 * Empty pending + no rejection means synchronization completed; enabled alone
 * does not promise all four series exist. save must resolve after durable storage.
 * Other config fields are preserved by the bridge's merge. Only enable activates.
 * Recurrences run on Google's servers; finish/sync need a live connection to
 * cancel instances. Offline calls only persist intent, without cancelling alerts.
 */
(function (global) {
  'use strict';
  var bridge, serial = Promise.resolve(), savedStates = new WeakMap();
  var TZ = 'America/Lima', HOURS = [20, 21, 22, 23];
  var formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  });
  function shift(day, n) {
    return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  }
  function dates(now) {
    var parts = {};
    formatter.formatToParts(new Date(now === undefined ? Date.now() : now)).forEach(function (p) { parts[p.type] = p.value; });
    var today = parts.year + '-' + parts.month + '-' + parts.day;
    return { today: today, tomorrow: shift(today, 1), hour: Number(parts.hour) };
  }
  function validDay(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(Date.parse(day + 'T12:00:00Z')) || shift(day, 0) !== day) throw new Error('Día inválido');
    return day;
  }
  function at(day, hour) { return day + 'T' + String(hour).padStart(2, '0') + ':00:00-05:00'; }
  function namespace() {
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function id(config, hour) { return 'f1' + config.namespace + hour.toString(16); }
  function status(error) {
    return Number(error && (error.status || error.code || (error.response && error.response.status))) ||
      Number((String(error && error.message).match(/\b(404|409|410)\b/) || [])[1]);
  }
  function notify(message, error) {
    if (bridge.changed) { try { bridge.changed(message, error); } catch (_) { /* UI cannot break persistence. */ } }
  }
  function patch(config) {
    return { version: 1, namespace: config.namespace, enabled: config.enabled,
      series: config.series, pending: config.pending, completed: config.completed,
      lastError: config.lastError || null };
  }
  async function persist(config) {
    var value = patch(config), signature = JSON.stringify(value);
    if (savedStates.get(config) === signature) return false;
    await bridge.save(value);
    savedStates.set(config, signature);
    return true;
  }
  async function read() {
    var raw = await bridge.read() || {};
    var config = Object.assign({ version: 1, namespace: null, enabled: false, series: {}, pending: [], lastError: null }, raw);
    config.series = Object.assign({}, config.series);
    config.pending = (config.pending || []).map(function (job) { return Object.assign({}, job); });
    config.completed = raw.completed ? { namespace: raw.completed.namespace,
      evenings: (raw.completed.evenings || []).slice() } : { namespace: null, evenings: [] };
    if (config.namespace && !/^[0-9a-f]{32}$/.test(config.namespace)) throw new Error('Namespace nocturno inválido');
    savedStates.set(config, JSON.stringify(patch(config)));
    return config;
  }
  function resetCompleted(config) {
    config.completed = { namespace: config.namespace, evenings: [] };
  }
  function completed(config, day) {
    return config.completed.namespace === config.namespace &&
      !config.pending.some(function (j) { return j.type === 'create'; }) &&
      config.completed.evenings.includes(shift(day, -1));
  }
  function remember(config, day) {
    if (config.completed.namespace !== config.namespace) resetCompleted(config);
    var evening = shift(day, -1), cutoff = shift(dates().today, -30);
    config.completed.evenings = Array.from(new Set(config.completed.evenings.concat(evening)))
      .filter(function (d) { return d >= cutoff; }).sort().slice(-31);
  }
  function enqueue(config, job) {
    if (job.type === 'finish' && completed(config, job.day)) return;
    if (!config.pending.some(function (j) { return j.type === job.type && j.day === job.day && j.hour === job.hour; })) config.pending.push(job);
  }
  function ownIDs(config) {
    if (!config.namespace) return [];
    return HOURS.map(function (h) {
      var expected = id(config, h);
      // Never accept arbitrary event IDs from persisted data.
      if (config.series[h] && config.series[h] !== expected) throw new Error('ID de serie nocturna inválido');
      return expected;
    });
  }
  async function cancelEvening(config, day) {
    var evening = shift(validDay(day), -1), end = at(shift(evening, 1), 0);
    if (Date.parse(end) <= Date.now()) return;
    for (var eventId of ownIDs(config)) {
      var token, seen = new Set();
      do {
        var page;
        try {
          page = await bridge.call('list_event_instances', { eventId: eventId,
            startTime: at(evening, 20), endTime: end, pageSize: 100, pageToken: token });
        } catch (error) {
          if ([404, 410].includes(status(error))) break;
          throw error;
        }
        if (!page || !Array.isArray(page.events)) throw new Error('Respuesta de instancias inválida');
        for (var event of page.events) {
          var start = event.start && event.start.dateTime;
          var stamp = Date.parse(start);
          if (!event.id || event.id === eventId || event.recurringEventId !== eventId ||
              event.status === 'cancelled' || !Number.isFinite(stamp) || stamp <= Date.now() ||
              stamp < Date.parse(at(evening, 20)) || stamp >= Date.parse(end) || dates(stamp).today !== evening) continue;
          try { await bridge.call('delete_event', { eventId: event.id }); }
          catch (error) { if (![404, 410].includes(status(error))) throw error; }
        }
        token = page.nextPageToken;
        if (token && seen.has(token)) throw new Error('Paginación de instancias repetida');
        if (token) seen.add(token);
      } while (token);
    }
  }
  async function create(config, hour) {
    var now = Date.now(), day = dates(now).today;
    if (Date.parse(at(day, hour)) <= now) day = shift(day, 1);
    var eventId = id(config, hour);
    try {
      var event = await bridge.call('create_event', {
        id: eventId, summary: 'Planificar mañana',
        description: global.location.origin + global.location.pathname + '#planificar-manana',
        startTime: at(day, hour), endTime: at(day, hour).replace(':00:00', ':05:00'),
        timeZone: TZ, recurrence: ['RRULE:FREQ=DAILY'], availability: 'AVAILABILITY_FREE',
        overrideReminders: [{ method: 'email', minutes: 0 }, { method: 'popup', minutes: 0 }]
      });
      if (!event || event.id !== eventId) throw new Error('Respuesta de creación inválida');
    } catch (error) { if (status(error) !== 409) throw error; }
    config.series[hour] = eventId;
  }
  async function drain(config) {
    if (!config.pending.length) return config;
    if (!bridge.connected()) { notify('Calendar pendiente de conexión'); return config; }
    var firstError = null;
    // One finite snapshot per sync. Newly queued jobs wait for the next invocation.
    for (var job of config.pending.slice()) {
      if (job.type === 'finish' && config.pending.some(function (j) { return j.type === 'create'; })) continue;
      try {
        if (job.type === 'create') {
          if (!config.enabled || !HOURS.includes(job.hour)) throw new Error('Creación pendiente inválida');
          await create(config, job.hour);
        } else if (job.type === 'delete') {
          if (!HOURS.includes(job.hour)) throw new Error('Eliminación pendiente inválida');
          ownIDs(config);
          try { await bridge.call('delete_event', { eventId: id(config, job.hour) }); }
          catch (error) { if (![404, 410].includes(status(error))) throw error; }
          delete config.series[job.hour];
        } else if (job.type === 'finish') {
          if (!completed(config, job.day)) await cancelEvening(config, job.day);
          remember(config, job.day);
        }
        else throw new Error('Trabajo nocturno desconocido');
      } catch (error) { firstError = firstError || error; continue; }
      config.pending.splice(config.pending.indexOf(job), 1);
      // Persist each success; uncertain remote outcomes safely retry by ID.
      await persist(config);
    }
    if (!config.enabled && !config.pending.length) {
      config.namespace = null; config.series = {}; resetCompleted(config);
    }
    config.lastError = firstError ? String(firstError.message || firstError) : null;
    await persist(config);
    notify(firstError ? 'Calendar conserva operaciones pendientes' : (config.pending.length ? 'Calendar pendiente' : 'Calendar sincronizado'), firstError || undefined);
    if (firstError) throw firstError;
    return config;
  }
  function run(operation) {
    var task = serial.then(async function () {
      if (!bridge) throw new Error('FicheroNightly requiere mount(api)');
      return operation(await read());
    });
    serial = task.catch(function () {});
    return task;
  }
  function mount(api) {
    if (!api || ['read', 'save', 'getDay', 'connected', 'call'].some(function (key) { return typeof api[key] !== 'function'; })) throw new Error('Bridge nocturno incompleto');
    if (bridge && bridge !== api) throw new Error('Bridge nocturno ya montado');
    bridge = api;
    return global.FicheroNightly;
  }
  function enable() { return run(async function (config) {
    if (config.pending.some(function (j) { return j.type === 'delete'; })) {
      config = await drain(config);
      if (config.pending.length) return config;
    }
    if (!config.namespace) config.namespace = namespace();
    ownIDs(config);
    config.enabled = true;
    if (config.completed.namespace !== config.namespace || HOURS.some(function (h) { return !config.series[h]; })) resetCompleted(config);
    HOURS.forEach(function (h) { if (!config.series[h]) enqueue(config, { type: 'create', hour: h }); });
    await persist(config);
    return reconcile(config);
  }); }
  function disable() { return run(async function (config) {
    ownIDs(config);
    config.enabled = false;
    config.pending = [];
    if (config.namespace) HOURS.forEach(function (h) { enqueue(config, { type: 'delete', hour: h }); });
    await persist(config);
    return drain(config);
  }); }
  function finish(day) { validDay(day); return run(async function (config) {
    if (!config.enabled && !config.pending.length) return config;
    if (config.enabled && config.namespace && Date.parse(at(day, 0)) > Date.now()) enqueue(config, { type: 'finish', day: day });
    await persist(config);
    if (!bridge.connected() && config.pending.length) {
      var error = Object.assign(new Error('Tu decisión está guardada; conecta Google para cancelar los avisos pendientes.'), { code: 'nightly_pending' });
      config.lastError = error.message;
      await persist(config);
      notify('Calendar pendiente de conexión', error);
      throw error;
    }
    return drain(config);
  }); }
  async function reconcile(config) {
    // Periodic UI refresh must not overwrite the saved-plan status or write an
    // idle config document every minute. Mount/sync never activate reminders.
    if (!config.enabled && !config.pending.length) return config;
    if (config.pending.some(function (j) { return j.type === 'create'; })) resetCompleted(config);
    var error;
    if (config.enabled && config.namespace) {
      var tomorrow = dates().tomorrow;
      for (var day of [tomorrow, shift(tomorrow, 1)]) {
        if (completed(config, day)) continue;
        try {
          var plan = await bridge.getDay(day);
          if (plan && ['guardado', 'omitido'].includes(plan.estado)) enqueue(config, { type: 'finish', day: day });
        } catch (e) { error = error || e; }
      }
    }
    await persist(config);
    var result = await drain(config);
    if (error) { config.lastError = String(error.message || error); await persist(config); notify('No se pudo consultar el plan', error); throw error; }
    return result;
  }
  function sync() { return run(reconcile); }
  global.FicheroNightly = { mount: mount, enable: enable, disable: disable, finish: finish, sync: sync, dates: dates };
})(window);
