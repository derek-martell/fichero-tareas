/* Independent Pomodoro: no task writes, Calendar calls or notification permissions. */
(function (global) {
  'use strict';
  var DEFAULTS = { focus: 25, short: 5, long: 15 };
  var LABELS = { focus: 'Concentración', short: 'Descanso corto', long: 'Descanso largo' };
  var PREFIX = 'fichero-pomodoro:v1:';
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function validConfig(c) {
    return c && Object.keys(DEFAULTS).every(function (k) { return Number.isInteger(c[k]) && c[k] >= 1 && c[k] <= 180; });
  }
  function fresh() {
    return { version: 1, config: copy(DEFAULTS), phase: 'focus', status: 'idle',
      remaining: 1500000, duration: 1500000, deadline: null, rounds: 0, sound: false };
  }
  function valid(s) {
    return s && s.version === 1 && validConfig(s.config) && Object.hasOwn(DEFAULTS, s.phase) &&
      ['idle', 'running', 'paused', 'complete'].includes(s.status) &&
      Number.isInteger(s.rounds) && s.rounds >= 0 && Number.isFinite(s.duration) &&
      s.duration >= 60000 && s.duration <= 10800000 && Number.isFinite(s.remaining) &&
      s.remaining >= 0 && s.remaining <= s.duration && typeof s.sound === 'boolean' &&
      (s.status === 'running' ? Number.isFinite(s.deadline) && s.remaining > 0 : s.deadline === null) &&
      (s.status === 'complete' ? s.remaining === 0 : s.remaining > 0);
  }
  // Inject storage, clock and scope for deterministic Node tests. State returned is a copy.
  function createEngine(options) {
    options = options || {};
    var now = options.now || Date.now, storage = options.storage;
    var getScope = options.scope || function () { return 'local'; };
    var uid, state, storageError = false;
    function key() { return PREFIX + encodeURIComponent(uid); }
    function save() {
      if (!storage) return;
      try { storage.setItem(key(), JSON.stringify(state)); storageError = false; }
      catch (_) { storageError = true; }
    }
    function load() {
      state = fresh();
      if (!storage) return;
      try { var s = JSON.parse(storage.getItem(key())); if (valid(s)) state = s; storageError = false; }
      catch (_) { storageError = true; }
    }
    function syncScope() {
      var value = getScope(), next = value == null || value === '' ? 'local' : String(value);
      if (uid !== next) { uid = next; load(); }
    }
    function sync() {
      syncScope();
      if (state.status === 'running' && state.deadline <= now()) {
        state.remaining = 0; state.deadline = null; state.status = 'complete';
        if (state.phase === 'focus') state.rounds++;
        save();
      }
    }
    function nextPhase() { return state.phase === 'focus' ? (state.rounds > 0 && state.rounds % 4 === 0 ? 'long' : 'short') : 'focus'; }
    function resetPhase(phase) {
      state.phase = phase; state.duration = state.config[phase] * 60000;
      state.remaining = state.duration; state.deadline = null; state.status = 'idle';
    }
    function snapshot() {
      sync(); var s = copy(state);
      if (s.status === 'running') s.remaining = Math.max(0, Math.min(s.duration, s.deadline - now()));
      s.scope = uid; s.nextPhase = nextPhase(); s.storageError = storageError;
      return s;
    }
    return {
      snapshot: snapshot,
      start: function () {
        sync(); if (state.status === 'running') return snapshot();
        if (state.status === 'complete') resetPhase(nextPhase());
        state.deadline = now() + state.remaining; state.status = 'running'; save(); return snapshot();
      },
      pause: function () {
        sync(); if (state.status === 'running') {
          state.remaining = Math.min(state.duration, state.deadline - now());
          state.deadline = null; state.status = 'paused'; save();
        } return snapshot();
      },
      reset: function () { sync(); resetPhase(state.phase); save(); return snapshot(); },
      skip: function () { sync(); resetPhase(nextPhase()); save(); return snapshot(); },
      configure: function (config) {
        if (!validConfig(config)) throw new RangeError('Cada duración debe ser un entero entre 1 y 180 minutos.');
        sync(); state.config = { focus: config.focus, short: config.short, long: config.long };
        // Current phase retains its original duration while running, paused or complete.
        if (state.status === 'idle') resetPhase(state.phase);
        save(); return snapshot();
      },
      setSound: function (enabled) { sync(); state.sound = !!enabled; save(); return snapshot(); },
      reload: function () { syncScope(); load(); return snapshot(); }
    };
  }

  var dispose = null, refreshCurrent = function () {};
  function mount(options) {
    if (!options || !options.root || options.root.nodeType !== 1) throw new TypeError('root debe ser un elemento DOM.');
    if (dispose) dispose();
    var root = options.root, doc = root.ownerDocument, win = doc.defaultView;
    var storage; try { storage = win.localStorage; } catch (_) {}
    var engine = createEngine({ storage: storage, scope: options.scope });
    var audio = null, audioScope = null, previous = null, inputs = {};
    function node(tag, text, cls) {
      var el = doc.createElement(tag); if (text != null) el.textContent = text;
      if (cls) el.className = cls; return el;
    }
    function button(text, action, cls) {
      var el = node('button', text, cls); el.type = 'button';
      el.addEventListener('click', function () { action(); paint(); }); return el;
    }
    root.classList.add('fp-pomodoro'); root.replaceChildren();
    var heading = node('h2', 'Sesión Pomodoro');
    var phase = node('p', '', 'fp-phase'), clock = node('div', '', 'fp-clock');
    clock.setAttribute('role', 'timer'); clock.setAttribute('aria-live', 'off');
    var progress = node('progress'); progress.max = 100; progress.setAttribute('aria-label', 'Progreso de la sesión');
    var context = node('p', '', 'fp-context'), rounds = node('p', '', 'fp-rounds');
    var status = node('p', '', 'fp-status'); status.setAttribute('role', 'status');
    var start = button('Iniciar', function () {
      var s = engine.snapshot(); if (s.sound) unlockSound(s.scope);
      if (s.status === 'running') engine.pause(); else engine.start();
    }, 'fp-primary');
    var reset = button('Reiniciar', function () { engine.reset(); });
    var skip = button('Omitir fase', function () { engine.skip(); });
    var actions = node('div', null, 'fp-actions'); actions.append(start, reset);
    var details = node('details', null, 'fp-settings'), summary = node('summary', 'Ajustes');
    var form = node('form');
    Object.keys(DEFAULTS).forEach(function (k) {
      var label = node('label', LABELS[k] + ' (min)'), input = node('input');
      input.type = 'number'; input.min = '1'; input.max = '180'; input.step = '1'; input.required = true;
      input.name = k; inputs[k] = input; label.append(input); form.append(label);
    });
    var apply = node('button', 'Guardar duraciones'); apply.type = 'submit'; form.append(apply);
    var settingStatus = node('p', '', 'fp-setting-status'); settingStatus.setAttribute('role', 'status');
    form.addEventListener('submit', function (event) {
      event.preventDefault(); var config = {};
      Object.keys(inputs).forEach(function (k) { config[k] = Number(inputs[k].value); });
      try {
        engine.configure(config); settingStatus.textContent = 'Guardado. Se aplica al próximo inicio o reinicio.';
        if (options.toast) options.toast('Duraciones del Pomodoro guardadas.');
      } catch (e) { settingStatus.textContent = e.message; } paint();
    });
    var soundLabel = node('label', null, 'fp-sound'), sound = node('input'); sound.type = 'checkbox';
    soundLabel.append(sound, node('span', 'Sonido al terminar'));
    sound.addEventListener('change', function () {
      var s = engine.setSound(sound.checked); if (s.sound) unlockSound(s.scope); paint();
    });
    details.append(summary, form, settingStatus, soundLabel, skip,
      node('p', 'Independiente del cronómetro de tareas: al descansar, pausa tu tarea si no quieres seguir registrando tiempo. No crea eventos en Calendar.', 'fp-note'));
    root.append(heading, phase, clock, progress, context, rounds, actions, status, details);
    function unlockSound(scope) {
      try {
        var Audio = win.AudioContext || win.webkitAudioContext;
        if (!Audio) { settingStatus.textContent = 'El sonido no está disponible en este navegador.'; return; }
        if (!audio) audio = new Audio();
        audioScope = scope;
        if (audio.state === 'suspended') audio.resume().catch(function () {});
      } catch (_) { settingStatus.textContent = 'El sonido no está disponible en este navegador.'; }
    }
    function beep() {
      if (!audio || audio.state !== 'running') return;
      try {
        var tone = audio.createOscillator(), gain = audio.createGain(), time = audio.currentTime;
        tone.frequency.value = 660; gain.gain.setValueAtTime(0.12, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);
        tone.connect(gain); gain.connect(audio.destination); tone.start(); tone.stop(time + 0.5);
        tone.onended = function () { tone.disconnect(); gain.disconnect(); };
      } catch (_) {}
    }
    function paint() {
      var s = engine.snapshot(), changedScope = !previous || previous.scope !== s.scope;
      root.dataset.status=s.status; root.dataset.rounds=String(s.rounds);
      if (changedScope) {
        audioScope = null; settingStatus.textContent = ''; details.open = false;
        Object.keys(inputs).forEach(function (k) { inputs[k].value = s.config[k]; });
      }
      if (previous && !changedScope && previous.status === 'running' && s.status === 'complete' && s.sound && audioScope === s.scope) beep();
      phase.textContent = LABELS[s.phase];
      var seconds = Math.ceil(s.remaining / 1000);
      clock.textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
      clock.setAttribute('aria-label', LABELS[s.phase] + ': ' + clock.textContent);
      progress.value = Math.round(100 * (1 - s.remaining / s.duration));
      rounds.textContent = s.rounds + (s.rounds === 1 ? ' ronda completada' : ' rondas completadas');
      start.textContent = s.status === 'running' ? 'Pausar' : s.status === 'paused' ? 'Reanudar' : s.status === 'complete' ? 'Iniciar ' + LABELS[s.nextPhase].toLowerCase() : 'Iniciar';
      status.textContent = s.status === 'complete' ? LABELS[s.phase] + ' terminada. La siguiente fase espera tu inicio.' : s.status === 'paused' ? 'En pausa.' : s.status === 'running' ? 'Sesión en marcha.' : 'Listo para empezar.';
      if (!storage || s.storageError) status.textContent += ' Sin guardado local: mantén esta página abierta.';
      sound.checked = s.sound;
      var tasks = options.tasks ? options.tasks() : [], active = Array.isArray(tasks) && tasks.find(function (t) {
        return t.estado === 'curso' && !t.pausada && Number.isFinite(Number(t.cursoDesde)) && Number(t.cursoDesde) > 0;
      });
      context.textContent = active ? 'En foco: ' + (active.titulo || 'Tarea en curso') : 'Un momento para concentrarte.';
      previous = s;
    }
    function onStorage(event) { if (event.key === null || event.key.startsWith(PREFIX)) { engine.reload(); paint(); } }
    var timer = win.setInterval(paint, 500);
    doc.addEventListener('visibilitychange', paint); win.addEventListener('pageshow', paint); win.addEventListener('storage', onStorage);
    dispose = function () {
      win.clearInterval(timer); doc.removeEventListener('visibilitychange', paint);
      win.removeEventListener('pageshow', paint); win.removeEventListener('storage', onStorage);
      if (audio) audio.close().catch(function () {});
    };
    refreshCurrent = paint; paint();
    return api;
  }
  var api = { mount: mount, refresh: function () { refreshCurrent(); }, createEngine: createEngine };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.FicheroPomodoro = api;
})(typeof window !== 'undefined' ? window : globalThis);
