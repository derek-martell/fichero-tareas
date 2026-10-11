/* Plan diario elegido por la persona. No ordena ni borra las fichas del tablero. */
(function (global) {
  'use strict';
  var api, root, dialog, ui = {}, draft = [], target, todayPlan = {}, tomorrowPlan = {};
  var working = false, refreshing = false, lastNotice = '', opener, lastSync = 0;
  function node(tag, text, cls) {
    var n = document.createElement(tag); if (text != null) n.textContent = text;
    if (cls) n.className = cls; return n;
  }
  function button(label, fn) { var b = node('button', label, 'btn'); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function field(label, input) { var l = node('label', null, 'dp-field'); l.append(node('span', label), input); return l; }
  function input(type, value) { var n = node('input'); n.type = type; n.value = value; return n; }
  function dates() { return global.FicheroNightly.dates(); }
  function tasks() { return api.tasks().filter(function (t) { return t.estado !== 'hecho'; }); }
  function done(plan) { return plan.estado === 'guardado' || plan.estado === 'omitido'; }
  function message(text, error) { ui.status.textContent = text; ui.status.classList.toggle('dp-error', !!error); if(dialog && dialog.open && error) ui.dialogStatus.textContent = text; }
  async function action(fn) {
    if (working) return;
    if (!api.ready()) { message('Espera a que carguen tus tareas.', true); return; }
    working = true; controls();
    try { await fn(); } catch (e) { message(e.message || 'No se pudo guardar. Inténtalo de nuevo.', true); }
    finally { working = false; controls(); await refresh(); }
  }
  function controls() { root.querySelectorAll('button').forEach(function (b) { b.disabled = working || !api.ready(); }); dialog.querySelectorAll('button,input').forEach(function (b) { b.disabled = working; }); }
  function mount(bridge) {
    api = bridge; root = document.getElementById('daily-planning');
    api.nightly.changed = function (text, error) { message(text, error); };
    global.FicheroNightly.mount(api.nightly);
    ui.status = node('p', '', 'dp-status'); ui.status.setAttribute('role', 'status'); ui.status.setAttribute('aria-live', 'polite');
    ui.route = node('div', null, 'dp-route'); ui.email = node('p', 'Los correos aún no están activados.', 'dp-note');
    var heading = node('div', null, 'dp-heading');
    heading.append(node('h2', 'Tu día, en el orden que tú eliges'), button('Preparar mañana', function () { open(); }));
    var settings = node('details', null, 'dp-settings');
    settings.append(node('summary', 'Recordatorio nocturno por correo'), ui.email,
      node('p', 'A las 8, 9, 10 y 11 p. m. (Lima). El correo de Calendar incluye el enlace al planificador. Al guardar o elegir «Hoy no», se cancelan los restantes de esa noche. No hace falta mantener la página abierta para recibirlos.', 'dp-note'),
      button('Activar correos con Google Calendar', function () { action(async function () { var s=await global.FicheroNightly.enable(); message(s.pending.length ? 'Activación pendiente: conecta Google y reintenta.' : 'Recordatorios configurados en Calendar.', !!s.pending.length); }); }),
      button('Desactivar correos', function () { action(async function () { var s=await global.FicheroNightly.disable(); message(s.pending.length ? 'Desactivación pendiente: los correos pueden seguir llegando hasta que conectes Google.' : 'Recordatorios desactivados.', !!s.pending.length); }); }),
      button('Reintentar sincronización', function () { action(async function () { var s=await global.FicheroNightly.sync(); message(s.pending.length ? 'Quedan operaciones pendientes. Conecta Google para completarlas.' : 'Sincronización revisada.', !!s.pending.length); }); }),
      node('p', 'Para cancelar avisos, abre el enlace y guarda tu decisión con Google conectado. Responder directamente al correo no modifica el plan. Si falla la conexión, te lo indicaremos y reintentaremos al volver.', 'dp-note'));
    root.append(heading, ui.route, ui.status, settings);
    buildDialog();
    global.addEventListener('hashchange', deepLink);
    setInterval(function () { refresh(); }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    refresh(); deepLink();
  }
  function buildDialog() {
    dialog = node('dialog', null, 'dp-dialog'); dialog.setAttribute('aria-labelledby', 'dp-title');
    ui.title = node('h2', '¿Qué haremos mañana?'); ui.title.id = 'dp-title';
    ui.capacity = input('number', '4'); ui.capacity.min = '0.25'; ui.capacity.max = '24'; ui.capacity.step = '0.25';
    ui.capacity.addEventListener('input', paintSummary);
    ui.summary = node('p', '', 'dp-note'); ui.summary.setAttribute('aria-live', 'polite');
    ui.queue = node('ol', null, 'dp-queue'); ui.candidates = node('div', null, 'dp-candidates');
    ui.search = input('search', ''); ui.search.placeholder = 'Buscar entre tus pendientes'; ui.search.addEventListener('input', paintCandidates);
    var actions = node('div', null, 'dp-actions');
    actions.append(button('Guardar mi plan', save), button('Hoy no voy a planificar', skip), button('Cerrar sin guardar', close));
    ui.dialogStatus = node('p', '', 'dp-status'); ui.dialogStatus.setAttribute('role', 'status');
    dialog.append(ui.title, node('p', 'Elige pocas tareas y ordénalas. La primera será tu punto de partida. Esto no cambia sus vencimientos ni agenda bloques automáticamente.', 'dp-note'),
      field('Horas que tú tienes disponibles', ui.capacity), ui.summary, ui.queue,
      button('Sugerir orden: vencimiento y prioridad', suggest),
      field('Añadir una tarea al plan', ui.search), ui.candidates, ui.dialogStatus, actions);
    dialog.addEventListener('cancel', function (e) { if (working) e.preventDefault(); else cleanupHash(); });
    dialog.addEventListener('close', function () { if (opener && opener.isConnected) opener.focus(); });
    document.body.append(dialog);
  }
  function cleanupHash() { if (location.hash === '#planificar-manana') history.replaceState(null, '', location.pathname + location.search); }
  function close() { if (working) return; dialog.close(); cleanupHash(); }
  function deepLink() {
    if (location.hash !== '#planificar-manana' || !api) return;
    if (!api.ready()) { setTimeout(deepLink, 500); return; }
    if (!dialog.open) open();
  }
  async function open() {
    if (!api.ready()) { message('Espera a que carguen tus tareas.', true); return; }
    target = dates().tomorrow; opener = document.activeElement;
    try {
      var plan = await api.getDay(target), available = tasks();
      draft = (plan.items || []).filter(function (item) { return available.some(function (t) { return t.id === item.id; }); }).map(function (item) { return Object.assign({}, item); });
      // Una asignación semanal previa es una propuesta editable, no un plan confirmado.
      if (!done(plan) && !draft.length) draft = available.filter(function (t) { return t.fechaHacer === target; }).map(itemFromTask);
      ui.title.textContent = '¿Qué haremos mañana? · ' + target;
      ui.capacity.value = plan.capacity || '4'; ui.search.value = ''; ui.dialogStatus.textContent = '';
      paintDraft(); paintCandidates(); dialog.showModal(); ui.capacity.focus();
    } catch (e) { message('No pude abrir tu plan. ' + (e.message || ''), true); }
  }
  function itemFromTask(t) { return { id: t.id, minutes: Number(t.estimadoMin) > 0 ? Number(t.estimadoMin) : 0 }; }
  function paintSummary() {
    var total = draft.reduce(function (sum, item) { return sum + (Number(item.minutes) || 0); }, 0);
    var capacity = Number(ui.capacity.value) * 60, missing = draft.filter(function (i) { return !(i.minutes > 0); }).length;
    ui.summary.textContent = draft.length + ' tareas · ' + total + ' min de carga. ' +
      (missing ? missing + ' sin duración: completa el tiempo que dedicarás. ' : '') +
      (capacity > 0 && total > capacity ? 'Tu plan supera en ' + Math.round(total - capacity) + ' min las horas disponibles. Puedes quitar tareas o reducir bloques.' : 'Deja margen para pausas e imprevistos.');
  }
  function paintDraft(focusId, direction) {
    ui.queue.replaceChildren(); var all = api.tasks();
    draft.forEach(function (item, i) {
      var t = all.find(function (t) { return t.id === item.id; }); if (!t) return;
      var row = node('li', null, 'dp-item'); row.dataset.id = item.id;
      row.append(node('strong', (i === 0 ? 'Empezar por aquí: ' : '') + t.titulo));
      var minutes = input('number', item.minutes || ''); minutes.min = '1'; minutes.max = '1440'; minutes.step = '1';
      minutes.addEventListener('input', function () { item.minutes = Number(minutes.value); paintSummary(); });
      row.append(field('Minutos que dedicarás', minutes));
      var actions = node('div', null, 'dp-actions');
      [-1, 1].forEach(function (delta) {
        var b = button(delta < 0 ? 'Subir' : 'Bajar', function () {
          var next = i + delta; if (next < 0 || next >= draft.length) return;
          draft.splice(i, 1); draft.splice(next, 0, item); paintDraft(item.id, delta);
        });
        b.disabled = i + delta < 0 || i + delta >= draft.length; b.dataset.move = delta;
        b.setAttribute('aria-label', (delta < 0 ? 'Subir ' : 'Bajar ') + t.titulo); actions.append(b);
      });
      actions.append(button('Quitar del plan', function () { draft = draft.filter(function (x) { return x !== item; }); paintDraft(); paintCandidates(); }));
      row.append(actions); ui.queue.append(row);
    });
    paintSummary();
    if (focusId) {
      var row = Array.from(ui.queue.children).find(function (n) { return n.dataset.id === focusId; });
      if (row) { var b = row.querySelector('[data-move="' + direction + '"]'); (b && !b.disabled ? b : row.querySelector('input')).focus(); }
    }
  }
  function reason(t) { return (t.fecha && t.fecha <= target ? 'Vence pronto · ' : '') + 'Prioridad ' + (t.prioridad || 'media'); }
  function paintCandidates() {
    var search = ui.search.value.trim().toLocaleLowerCase('es');
    ui.candidates.replaceChildren();
    tasks().filter(function (t) { return !draft.some(function (i) { return i.id === t.id; }) && (t.titulo + ' ' + t.proyecto).toLocaleLowerCase('es').includes(search); }).forEach(function (t) {
      var row = node('div', null, 'dp-candidate');
      row.append(node('span', t.titulo + ' — ' + reason(t)), button('Añadir al plan', function () { draft.push(itemFromTask(t)); paintDraft(); paintCandidates(); }));
      ui.candidates.append(row);
    });
    if (!ui.candidates.children.length) ui.candidates.append(node('p', 'No hay más tareas que coincidan.', 'dp-note'));
  }
  function suggest() {
    var all = api.tasks(), weights = { alta: 0, media: 1, baja: 2 };
    draft.sort(function (a, b) {
      var ta = all.find(function (t) { return t.id === a.id; }) || {}, tb = all.find(function (t) { return t.id === b.id; }) || {};
      var da = ta.fecha || '9999', db = tb.fecha || '9999';
      return da.localeCompare(db) || (weights[ta.prioridad] == null ? 1 : weights[ta.prioridad]) - (weights[tb.prioridad] == null ? 1 : weights[tb.prioridad]);
    });
    paintDraft(); ui.dialogStatus.textContent = 'Sugerencia aplicada: primero lo que vence antes; a igual fecha, la prioridad. Puedes cambiar el orden.';
  }
  async function finishPlan(state) {
    if (target !== dates().tomorrow) { ui.dialogStatus.textContent = 'Cambió el día. Cierra y vuelve a abrir para planificar mañana.'; return; }
    if (state === 'guardado') {
      if (!draft.length) { ui.dialogStatus.textContent = 'Elige al menos una tarea o pulsa «Hoy no voy a planificar».'; return; }
      if (!ui.capacity.reportValidity() || draft.some(function (i) { return !Number.isInteger(i.minutes) || i.minutes <= 0 || i.minutes > 1440; })) {
        ui.dialogStatus.textContent = 'Completa las horas disponibles y una duración de 1 a 1440 minutos por tarea.'; return;
      }
      if (draft.some(function (i) { return !tasks().some(function (t) { return t.id === i.id; }); })) { ui.dialogStatus.textContent = 'Una tarea fue terminada o eliminada. Quítala del plan antes de guardar.'; return; }
    }
    await action(async function () {
      var data = { estado: state, items: state === 'guardado' ? draft : [], orden: state === 'guardado' ? draft.map(function (i) { return i.id; }) : [], capacity: Number(ui.capacity.value) || 4, actualizado: Date.now() };
      await api.saveDay(target, data);
      dialog.close(); cleanupHash();
      message(state === 'guardado' ? 'Tu plan está guardado. Tú elegiste el orden.' : 'Hoy no planificarás. Mañana vuelve el recordatorio.');
      try { var s=await global.FicheroNightly.finish(target); if(s.pending.length) message('Tu decisión está guardada. La cancelación de correos está pendiente: conecta Google y reintenta.',true); }
      catch (e) { message('Tu decisión está guardada, pero no pude cancelar todos los correos. Conecta Google y pulsa «Reintentar sincronización».', true); }
    });
  }
  function save() { finishPlan('guardado'); }
  function skip() { finishPlan('omitido'); }
  async function refresh() {
    if (!api || !api.ready() || refreshing) { if (api && !api.ready()) setTimeout(refresh, 500); return; }
    refreshing = true;
    try {
      var now = dates(), plans = await Promise.all([api.getDay(now.today), api.getDay(now.tomorrow), api.nightly.read()]);
      todayPlan = plans[0]; tomorrowPlan = plans[1];
      var pending = (plans[2].pending || []).length;
      ui.email.textContent = pending ? 'Hay operaciones pendientes con Calendar: revisa la conexión y reintenta.' : plans[2].enabled ? 'Recordatorios activados. Último aviso: 11 p. m. (Lima).' : 'Los correos están desactivados.';
      ui.route.replaceChildren();
      var remaining = (todayPlan.items || []).map(function (i) { return { item: i, task: tasks().find(function (t) { return t.id === i.id; }) }; }).filter(function (x) { return x.task; });
      if (remaining.length) {
        var first = remaining[0].task;
        ui.route.append(node('p', 'Empezar por aquí', 'dp-note'), node('h3', first.titulo), button(first.estado === 'curso' && !first.pausada ? 'Ver tarea en curso' : 'Empezar', function () {
          action(async function () { if (first.estado === 'curso' && !first.pausada) api.openTask(first.id); else await api.start(first.id); });
        }));
        var sequence = node('ol'); remaining.forEach(function (x) { sequence.append(node('li', x.task.titulo + ' · ' + x.item.minutes + ' min previstos')); });
        var details = node('details'); details.append(node('summary', 'Ver mi secuencia de hoy (' + remaining.length + ')'), sequence); ui.route.append(details);
      } else ui.route.append(node('p', todayPlan.estado === 'guardado' ? 'Completaste las tareas de tu plan. Puedes seguir con tu tablero.' : 'Aún no tienes una secuencia para hoy. Prepara mañana para empezar con un primer paso claro.', 'dp-note'));
      ui.route.append(node('p', done(tomorrowPlan) ? (tomorrowPlan.estado === 'guardado' ? 'El plan de mañana está preparado.' : 'Elegiste no planificar esta noche.') : 'Mañana aún está por preparar.', 'dp-note'));
      controls();
      // Un aviso local por hora; no pide permisos ni suplanta el correo de Calendar.
      if (plans[2].enabled && now.hour >= 20 && now.hour <= 23 && !done(tomorrowPlan) && !document.hidden && !dialog.open) {
        var key = now.today + ':' + now.hour;
        if (lastNotice !== key) { lastNotice = key; open(); }
      }
      if (api.nightly.connected() && (plans[2].enabled || pending) && Date.now()-lastSync >= 60000) {
        lastSync=Date.now();
        global.FicheroNightly.sync().catch(function () { message('Revisa la conexión de Google: quedan avisos pendientes de sincronizar.', true); });
      }
    } catch (e) { message('No pude cargar el plan diario. ' + (e.message || ''), true); }
    finally { refreshing = false; }
  }
  global.FicheroPlanning = { mount: mount, refresh: refresh, open: open };
})(window);
