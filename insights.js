/* Fichero Insights: interfaz sin persistencia propia. El bridge controla los datos.
 * Cargar antes del script principal; montar después de crear #workspace-insights.
 * refresh() toma una instantánea; no instala intervalos ni cambia root.hidden.
 */
(function (global) {
  'use strict';
  var api, root, ui = {}, week, selectedDay, editingId = null, busy = new Set();
  var view = 'analitica', snapshot = { tasks: [], sessions: [], templates: [] };
  var states = { sincronizado: 'Sincronizado', pendiente: 'Pendiente', error: 'Error', desactivado: 'Desactivado', breve: 'Bloque breve' };
  var dayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  var HOUR = 3600000;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'className') node.className = attrs[key];
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== false && attrs[key] != null) node.setAttribute(key, attrs[key] === true ? '' : String(attrs[key]));
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }
  function text(tag, value, cls) { return el(tag, { text: value, className: cls || '' }); }
  function button(label, action, attrs) { return el('button', Object.assign({ type: 'button', text: label, 'data-action': action, className: 'fi-button' }, attrs)); }
  function field(label, control) { return el('label', { className: 'fi-field' }, [text('span', label), control]); }
  function number(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }
  function stamp(value) {
    if (!value || typeof value === 'boolean') return NaN;
    if (typeof value === 'number') return value;
    return new Date(value).getTime();
  }
  function iso(date) { return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
  function localDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    var parts = value.split('-').map(Number), date = new Date(parts[0], parts[1] - 1, parts[2]);
    return iso(date) === value ? date : null;
  }
  function addDays(date, n) { var result = new Date(date); result.setDate(result.getDate() + n); return result; }
  function monday(date) { return addDays(date, -((date.getDay() + 6) % 7)); }
  function today() { return localDate(api.today()) || localDate(iso(new Date())); }
  function fmtDate(date) { return date.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtStamp(value) { var n = stamp(value); return Number.isFinite(n) ? new Date(n).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : 'Sin fecha válida'; }
  function hours(ms) { var m = Math.floor(number(ms) / 60000); return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min' : m + ' min'; }
  function duration(ms) { var s = Math.round(number(ms) / 1000); return Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function overlap(start, end, from, to) { return Math.max(0, Math.min(end, to) - Math.max(start, from)) || 0; }
  function project(t) { return String(t.proyecto || 'Sin proyecto'); }
  function sessionDuration(s) { return Number.isFinite(Number(s.duracionMs)) ? number(s.duracionMs) : Math.max(0, stamp(s.fin) - stamp(s.inicio)) || 0; }
  function validSession(s) { return Number.isFinite(stamp(s.inicio)) && stamp(s.fin) > stamp(s.inicio); }
  function activeStart(t) {
    if (t.estado !== 'curso' || t.pausada || !t.cursoDesde) return NaN;
    // Los bloques cerrados ya contabilizados no se vuelven a sumar como tramo activo.
    return snapshot.sessions.reduce(function (start, s) {
      return String(s.tareaId) === String(t.id) && validSession(s) ? Math.max(start, stamp(s.fin)) : start;
    }, stamp(t.cursoDesde));
  }
  function totalReal(t, now) {
    var closed = snapshot.sessions.filter(function (s) { return String(s.tareaId) === String(t.id); }).reduce(function (sum, s) { return sum + sessionDuration(s); }, 0);
    var start = activeStart(t);
    var accumulated = Number.isFinite(Number(t.msEnCurso)) ? number(t.msEnCurso) : closed;
    return accumulated + (Number.isFinite(start) ? Math.max(0, now - start) : 0);
  }
  function eventURL(s) {
    try {
      var url = new URL(s.eventoLink);
      if (url.protocol === 'https:' && !url.username && !url.password &&
          (url.hostname === 'calendar.google.com' || url.hostname === 'www.google.com') &&
          /^\/calendar(?:\/|$)/.test(url.pathname) && (/event/.test(url.pathname) || url.searchParams.has('eid'))) return url.href;
    } catch (_) { /* El enlace alternativo no intenta inventar el eid de Google. */ }
    return s.eventoId ? 'https://calendar.google.com/calendar/u/0/r?search=' + encodeURIComponent(String(s.eventoId)) : '';
  }
  function notify(message, error) {
    ui.status.textContent = message;
    ui.status.classList.toggle('fi-error', !!error);
    if (api.toast) api.toast(message);
  }
  function ready() { return !!api && api.isReady(); }
  async function run(key, control, work, success) {
    if (!ready()) { notify('Los datos todavía están cargando. Inténtalo cuando termine la carga.', true); return; }
    if (busy.has(key)) return;
    busy.add(key);
    if (control) { control.disabled = true; control.setAttribute('aria-busy', 'true'); }
    try { await work(); if (success) notify(success); }
    catch (error) { notify('No se pudo completar la acción. ' + (error && error.message ? error.message : 'Inténtalo de nuevo.'), true); }
    finally { busy.delete(key); if (control) { control.disabled = false; control.removeAttribute('aria-busy'); } refresh(); }
  }

  /* Reconciliación por clave: conserva nodos, foco y valores de formularios.
   * Los formularios principales son estáticos y nunca se reconstruyen al refrescar.
   */
  function patch(oldNode, newNode) {
    if (oldNode.nodeType === 3) { if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue; return; }
    var isControl = /^(INPUT|SELECT|TEXTAREA)$/.test(oldNode.tagName), value = isControl ? oldNode.value : null;
    var preserveValue = isControl && (oldNode.tagName === 'SELECT' || value !== oldNode.defaultValue);
    Array.from(oldNode.attributes).forEach(function (attr) { if (!newNode.hasAttribute(attr.name)) oldNode.removeAttribute(attr.name); });
    Array.from(newNode.attributes).forEach(function (attr) {
      if (oldNode.getAttribute(attr.name) !== attr.value) oldNode.setAttribute(attr.name, attr.value);
    });
    var available = Array.from(oldNode.childNodes), keyed = new Map();
    available.forEach(function (child) { if (child.nodeType === 1 && child.dataset.key) keyed.set(child.dataset.key, child); });
    var used = new Set();
    Array.from(newNode.childNodes).forEach(function (child, i) {
      var key = child.nodeType === 1 && child.dataset.key;
      var match = key ? keyed.get(key) : available[i];
      if (match && (used.has(match) || match.nodeType !== child.nodeType || match.nodeName !== child.nodeName ||
          (!key && match.nodeType === 1 && match.dataset.key))) match = null;
      if (!match) match = child.cloneNode(true);
      else patch(match, child);
      used.add(match);
      if (oldNode.childNodes[i] !== match) oldNode.insertBefore(match, oldNode.childNodes[i] || null);
    });
    Array.from(oldNode.childNodes).forEach(function (child) { if (!used.has(child)) child.remove(); });
    if (isControl) {
      var nextValue = preserveValue ? value : newNode.value;
      if (oldNode.value !== nextValue) oldNode.value = nextValue;
    }
  }
  function paint(target, children) { patch(target, el(target.tagName.toLowerCase(), { className: target.className }, children)); }

  function mount(bridge) {
    api = bridge;
    var nextRoot = document.getElementById('workspace-insights');
    if (!nextRoot) throw new Error('Falta #workspace-insights.');
    if (root === nextRoot && ui.nav) { refresh(); return; }
    root = nextRoot;
    week = monday(today()); selectedDay = iso(today());
    ui = {};
    ui.status = el('p', { className: 'fi-status', role: 'status', 'aria-live': 'polite' });
    ui.loading = text('p', 'Cargando datos…', 'fi-notice');
    ui.nav = el('nav', { className: 'fi-tabs', 'aria-label': 'Vistas de trabajo' }, [
      button('Analítica', 'view', { 'data-view': 'analitica', 'aria-controls': 'fi-analitica' }),
      button('Plan semanal', 'view', { 'data-view': 'plan', 'aria-controls': 'fi-plan' })
    ]);
    ui.weekLabel = el('h2', { id: 'fi-week-title', className: 'fi-week-title' });
    var weekNav = el('header', { className: 'fi-week-nav' }, [ui.weekLabel, el('div', { className: 'fi-actions' }, [
      button('Anterior', 'previous', { 'aria-label': 'Semana anterior' }), button('Esta semana', 'current'), button('Siguiente', 'next', { 'aria-label': 'Semana siguiente' })
    ])]);
    ui.metrics = el('div', { className: 'fi-metrics' });
    ui.projects = el('div', { className: 'fi-projects' });
    ui.precision = el('div', { className: 'fi-precision' });
    ui.historyBody = el('tbody');
    ui.search = el('input', { type: 'search', placeholder: 'Título, proyecto o subproyecto', 'aria-label': 'Buscar sesiones' });
    ui.project = el('select', { 'aria-label': 'Filtrar sesiones por proyecto' }, [el('option', { value: '', text: 'Todos los proyectos' })]);
    ui.from = el('input', { type: 'date', value: iso(week), required: true });
    ui.to = el('input', { type: 'date', value: iso(addDays(week, 6)), required: true });
    ui.historySummary = el('p', { className: 'fi-note', role: 'status' });
    var filters = el('div', { className: 'fi-filters' }, [field('Buscar sesiones', ui.search), field('Proyecto', ui.project), field('Desde', ui.from), field('Hasta, inclusive', ui.to), button('Usar semana visible', 'range')]);
    var table = el('table', { className: 'fi-table' }, [
      el('caption', { text: 'Bloques cerrados. Las horas se muestran en tu zona local; las sesiones que cruzan el rango se incluyen completas en el historial.' }),
      el('thead', {}, [el('tr', {}, ['Tarea / proyecto', 'Inicio', 'Fin', 'Duración del bloque', 'Estimación de tarea', 'Calendar'].map(function (title) { return el('th', { scope: 'col', text: title }); }))]), ui.historyBody
    ]);
    ui.analytic = el('section', { id: 'fi-analitica', className: 'fi-panel', 'aria-label': 'Analítica' }, [
      ui.metrics,
      el('section', { className: 'fi-sheet' }, [text('h3', 'Tiempo real por proyecto'), ui.projects, text('p', 'Incluye el tiempo trabajado dentro de esta semana y las sesiones activas. Las subtareas se cuentan una sola vez.', 'fi-note')]),
      el('section', { className: 'fi-sheet' }, [text('h3', 'Estimación y realidad'), ui.precision, el('details', {className:'fi-method'}, [text('summary','Cómo se calcula la precisión'), text('p', 'Se comparan las tareas terminadas esta semana que tengan estimación y tiempo registrado. Precisión = 100 × menor(estimado, real) / mayor(estimado, real); mostramos el promedio. La desviación es el tiempo real menos el estimado. Cada comparación usa el total de la tarea, incluido su histórico anterior.', 'fi-note')])]),
      el('section', { className: 'fi-sheet' }, [text('h3', 'Historial de sesiones'), filters, ui.historySummary,
        el('div', { className: 'fi-actions' }, [button('Descargar CSV', 'csv'), button('Descargar Excel', 'xlsx'), button('Descargar PDF', 'pdf')]),
        el('div', { className: 'fi-table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Historial de sesiones, tabla desplazable' }, [table])])
    ]);
    ui.days = el('div', { className: 'fi-days' });
    ui.unplanned = el('div', { className: 'fi-task-list' });
    ui.assignDay = el('input', { type: 'date', required: true, value: selectedDay });
    ui.templates = el('div', { className: 'fi-template-list' });
    ui.templateHeading = text('h4', 'Nueva plantilla');
    ui.title = el('input', { type: 'text', required: true, maxlength: '240', name: 'titulo' });
    ui.templateProject = el('input', { type: 'text', maxlength: '120', name: 'proyecto' });
    ui.minutes = el('input', { type: 'number', min: '1', step: '1', required: true, value: '30', name: 'estimadoMin' });
    ui.priority = el('select', { name: 'prioridad' }, ['alta', 'media', 'baja'].map(function (value) { return el('option', { value: value, text: value[0].toUpperCase() + value.slice(1), selected: value === 'media' }); }));
    ui.templateForm = el('form', { className: 'fi-template-form' }, [ui.templateHeading,
      field('Título de la tarea', ui.title), field('Proyecto', ui.templateProject), field('Duración estimada (minutos)', ui.minutes), field('Prioridad', ui.priority),
      el('div', { className: 'fi-actions' }, [el('button', { type: 'submit', className: 'fi-button fi-primary', text: 'Guardar plantilla' }), button('Nueva / cancelar edición', 'reset-template')])
    ]);
    ui.templateForm.addEventListener('submit', saveTemplate);
    ui.plan = el('section', { id: 'fi-plan', className: 'fi-panel', 'aria-label': 'Plan semanal' }, [
      text('p', 'Elige cuándo trabajar en cada tarea, además de su fecha límite. Puedes agendarla en Calendar desde su ficha.', 'fi-note'), ui.days,
      el('section', { className: 'fi-sheet' }, [text('h3', 'Sin día de plan'), field('Día para asignar tareas y usar plantillas', ui.assignDay), ui.unplanned]),
      el('section', { className: 'fi-sheet' }, [text('h3', 'Tus plantillas'), text('p', 'Personaliza una tarea recurrente y úsala en el día seleccionado. Se guarda en el fichero; puedes agendarla después.', 'fi-note'), ui.templates, ui.templateForm])
    ]);
    root.replaceChildren(ui.nav, weekNav, ui.loading, ui.status, ui.analytic, ui.plan);
    root.addEventListener('click', onClick);
    [ui.search, ui.from, ui.to].forEach(function (input) { input.addEventListener('input', renderHistory); });
    ui.project.addEventListener('change', renderHistory);
    ui.assignDay.addEventListener('change', function () { if (localDate(ui.assignDay.value)) selectedDay = ui.assignDay.value; });
    show(view); refresh();
  }
  function show(nextView) {
    if (nextView !== 'plan' && nextView !== 'analitica') return;
    view = nextView;
    if (!root) return;
    ui.analytic.hidden = view !== 'analitica'; ui.plan.hidden = view !== 'plan';
    ui.nav.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
  }
  function refresh() {
    if (!root || !api) return;
    var isReady;
    try { isReady = ready(); } catch (error) { notify('No se pudo consultar el estado de los datos.', true); return; }
    ui.loading.hidden = isReady;
    root.querySelectorAll('[data-write], .fi-template-form button[type="submit"]').forEach(function (control) { control.disabled = !isReady || busy.has('templates'); });
    if (!isReady) { ui.loading.textContent = 'Cargando datos… Las acciones de guardado estarán disponibles al terminar.'; return; }
    try {
      snapshot = { tasks: api.getTasks() || [], sessions: api.getSessions() || [], templates: api.getTemplates() || [] };
      ui.weekLabel.textContent = fmtDate(week) + ' — ' + fmtDate(addDays(week, 6));
      renderAnalytics(); renderProjectsFilter(); renderHistory(); renderPlan();
    } catch (error) { notify('No se pudieron actualizar los datos. ' + (error.message || 'Inténtalo de nuevo.'), true); }
  }
  function renderAnalytics() {
    var now = Date.now(), from = week.getTime(), to = addDays(week, 7).getTime(), totals = new Map(), weekly = 0, historical = 0, corrected = 0, invalid = 0;
    snapshot.sessions.forEach(function (s) {
      if (!validSession(s)) { invalid++; return; }
      var ms = overlap(stamp(s.inicio), Math.min(stamp(s.fin), now), from, to);
      weekly += ms; totals.set(project(s), (totals.get(project(s)) || 0) + ms);
    });
    snapshot.tasks.forEach(function (t) {
      var start = activeStart(t), ms = Number.isFinite(start) ? overlap(start, now, from, to) : 0;
      weekly += ms; totals.set(project(t), (totals.get(project(t)) || 0) + ms);
      var recorded = snapshot.sessions.filter(function (s) { return String(s.tareaId) === String(t.id); }).reduce(function (sum, s) { return sum + sessionDuration(s); }, 0);
      historical += Math.max(0, number(t.msEnCurso) - recorded);
      corrected += Math.max(0, recorded - number(t.msEnCurso));
    });
    var complete = snapshot.tasks.filter(function (t) { var done = stamp(t.completado); return t.estado === 'hecho' && done >= from && done < to && done <= now; });
    var precise = complete.filter(function (t) { return number(t.estimadoMin) > 0 && totalReal(t, now) > 0; });
    var accuracy = precise.reduce(function (sum, t) { var est = number(t.estimadoMin) * 60000, real = totalReal(t, now); return sum + 100 * Math.min(est, real) / Math.max(est, real); }, 0);
    var current = today(), days = week > current ? 0 : iso(monday(current)) === iso(week) ? ((current.getDay() + 6) % 7) + 1 : 7;
    paint(ui.metrics, [
      metric('Trabajo esta semana', hours(weekly), 'Sesiones y tramos activos con fecha'),
      metric('Media diaria', days ? hours(weekly / days) : '—', days ? 'Dividido entre ' + days + ' días' : 'Semana futura: 0 días transcurridos'),
      metric('Tareas completadas', String(complete.length), 'Según su fecha de finalización'),
      metric('Precisión media', precise.length ? (accuracy / precise.length).toLocaleString('es', { maximumFractionDigits: 1 }) + ' %' : '—', precise.length + ' tareas con estimación y tiempo')
    ]);
    var entries = Array.from(totals).filter(function (pair) { return pair[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; });
    var children = entries.map(function (pair) {
      return el('div', { className: 'fi-project', 'data-key': pair[0] }, [
        el('div', { className: 'fi-project-label' }, [text('span', pair[0]), text('strong', hours(pair[1]))]),
        el('progress', { max: weekly || 1, value: pair[1], 'aria-label': pair[0] + ': ' + hours(pair[1]) }),
        text('span', (100 * pair[1] / weekly).toLocaleString('es', { maximumFractionDigits: 1 }) + ' % del tiempo semanal', 'fi-note')
      ]);
    });
    if (!entries.length) children.push(text('p', 'Todavía no hay tiempo fechado en esta semana.', 'fi-empty'));
    if (historical) children.push(text('p', 'Dato histórico sin fecha: ' + hours(historical) + ' acumuladas. No se asignan a ninguna semana.', 'fi-notice'));
    if (corrected) children.push(text('p', 'El total de las tareas tiene ' + hours(corrected) + ' menos que sus sesiones por correcciones manuales. Las horas semanales conservan los intervalos registrados.', 'fi-notice'));
    if (invalid) children.push(text('p', invalid + ' bloques sin intervalo válido no se incluyen en las horas semanales.', 'fi-notice'));
    paint(ui.projects, children);
    paint(ui.precision, precise.length ? precise.map(function (t) {
      var real = totalReal(t, now), est = number(t.estimadoMin) * 60000, delta = real - est;
      return el('div', { className: 'fi-comparison', 'data-key': String(t.id) }, [
        button(t.titulo || 'Sin título', 'open', { 'data-id': t.id, className: 'fi-link-button' }),
        text('span', 'Estimado ' + hours(est) + ' / real total ' + hours(real)),
        text('strong', 'Desviación ' + (delta >= 0 ? '+' : '−') + hours(Math.abs(delta)) + ' (' + (delta >= 0 ? '+' : '') + (100 * delta / est).toLocaleString('es', { maximumFractionDigits: 1 }) + ' %)')
      ]);
    }) : [text('p', 'Sin tareas completadas con estimación y tiempo real para comparar esta semana.', 'fi-empty')]);
  }
  function metric(label, value, note) { return el('article', { className: 'fi-metric', 'data-key': label }, [text('h3', label), text('strong', value), text('p', note, 'fi-note')]); }
  function renderProjectsFilter() {
    var names = Array.from(new Set(snapshot.sessions.map(project))).sort(function (a, b) { return a.localeCompare(b, 'es'); });
    var value = ui.project.value;
    if (value && names.indexOf(value) < 0) names.push(value);
    var next = el('select', { 'aria-label': 'Filtrar sesiones por proyecto' }, [el('option', { value: '', text: 'Todos los proyectos' })].concat(names.map(function (p) { return el('option', { value: p, text: p, 'data-key': p }); })));
    patch(ui.project, next);
  }
  function historyRange() {
    var from = localDate(ui.from.value), to = localDate(ui.to.value);
    return from && to && from <= to ? { from: from.getTime(), to: addDays(to, 1).getTime() } : null;
  }
  function filteredSessions() {
    var range = historyRange();
    if (!range) return [];
    var q = ui.search.value.trim().toLocaleLowerCase('es'), p = ui.project.value;
    return snapshot.sessions.filter(function (s) {
      return validSession(s) && overlap(stamp(s.inicio), stamp(s.fin), range.from, range.to) > 0 &&
        (!p || project(s) === p) && (!q || [s.titulo, project(s), s.subproyecto].join(' ').toLocaleLowerCase('es').includes(q));
    }).sort(function (a, b) { return stamp(b.inicio) - stamp(a.inicio); });
  }
  function taskEstimate(s) {
    var task = snapshot.tasks.find(function (t) { return String(t.id) === String(s.tareaId); });
    return number(task ? task.estimadoMin : s.estimadoMin);
  }
  function renderHistory() {
    if (!root || !ready()) return;
    var rows = filteredSessions(), range = historyRange();
    ui.from.setCustomValidity(range ? '' : 'Selecciona un rango válido.');
    ui.to.setCustomValidity(range ? '' : 'La fecha final debe ser igual o posterior a la inicial.');
    var sum = rows.reduce(function (total, s) { return total + overlap(stamp(s.inicio), stamp(s.fin), range.from, range.to); }, 0);
    ui.historySummary.textContent = range ? rows.length + ' sesiones · ' + hours(sum) + ' dentro del rango. La estimación corresponde a la tarea completa; no se suma por bloque.' : 'Selecciona un rango válido (desde ≤ hasta).';
    paint(ui.historyBody, rows.length ? rows.map(function (s) {
      var status = s.calendarEstado || '', link = eventURL(s), actions = [text('span', states[status] || 'Estado desconocido', 'fi-calendar-state')];
      if (s.calendarError) actions.push(text('small', String(s.calendarError), 'fi-error'));
      if (link) actions.push(el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', className: 'fi-event-link', text: link.includes('/r?search=') ? 'Buscar evento en Calendar' : 'Abrir evento' }));
      if (status === 'pendiente' || status === 'error') actions.push(button(busy.has('retry:' + s.id) ? 'Reintentando…' : 'Reintentar', 'retry', { 'data-id': s.id, 'data-write': true, disabled: busy.has('retry:' + s.id) }));
      return el('tr', { 'data-key': String(s.id) }, [
        el('td', {}, [button(s.titulo || 'Sin título', 'open', { 'data-id': s.tareaId, className: 'fi-link-button' }), text('small', project(s) + (s.subproyecto ? ' / ' + s.subproyecto : ''))]),
        text('td', fmtStamp(s.inicio)), text('td', fmtStamp(s.fin)), text('td', duration(sessionDuration(s))),
        text('td', taskEstimate(s) ? taskEstimate(s).toLocaleString('es') + ' min (tarea)' : 'Sin estimación'), el('td', {}, actions)
      ]);
    }) : [el('tr', {}, [el('td', { colspan: '6', text: range ? 'No hay sesiones cerradas con estos filtros.' : 'Revisa las fechas del filtro.', className: 'fi-empty' })])]);
  }
  function taskRow(t, unplanned) {
    var date = el('input', { type: 'date', value: unplanned ? selectedDay : t.fechaHacer, 'data-task-date': t.id, 'aria-label': 'Día de plan de ' + (t.titulo || 'tarea') });
    return el('article', { className: 'fi-task', 'data-key': String(t.id) }, [
      button(t.titulo || 'Sin título', 'open', { 'data-id': t.id, className: 'fi-link-button' }),
      text('p', project(t) + (t.subproyecto ? ' / ' + t.subproyecto : ''), 'fi-note'),
      text('p', (number(t.estimadoMin) ? t.estimadoMin + ' min estimados · ' : '') + (t.estado === 'hecho' ? 'Completada' : t.estado === 'curso' ? 'En curso' : 'Pendiente') + (t.fecha ? ' · Límite: ' + t.fecha : ''), 'fi-note'),
      field('Día de plan', date),
      el('div', { className: 'fi-actions' }, [button(unplanned ? 'Asignar día' : 'Cambiar día', 'plan-task', { 'data-id': t.id, 'data-write': true, disabled: busy.has('plan:' + t.id) }), button('Agendar', 'schedule', { 'data-id': t.id, 'data-write': true })])
    ]);
  }
  function renderPlan() {
    paint(ui.days, dayNames.map(function (name, i) {
      var date = addDays(week, i), day = iso(date), tasks = snapshot.tasks.filter(function (t) { return t.fechaHacer === day; });
      var minutes = tasks.reduce(function (sum, t) { return sum + number(t.estimadoMin); }, 0);
      return el('section', { className: 'fi-day' + (day === iso(today()) ? ' fi-today' : ''), 'data-key': day, 'aria-label': name + ' ' + fmtDate(date) }, [
        el('header', { className: 'fi-day-heading' }, [button(name + ' ' + date.getDate(), 'select-day', { 'data-day': day, 'aria-pressed': String(day === selectedDay) }), text('p', tasks.length + ' tareas · ' + hours(minutes * 60000), 'fi-note')]),
        el('div', { className: 'fi-task-list' }, tasks.length ? tasks.map(function (t) { return taskRow(t, false); }) : [text('p', 'Sin tareas planificadas', 'fi-empty')])
      ]);
    }));
    var unplanned = snapshot.tasks.filter(function (t) { return !localDate(t.fechaHacer) && t.estado !== 'hecho'; });
    paint(ui.unplanned, unplanned.length ? unplanned.map(function (t) { return taskRow(t, true); }) : [text('p', 'Todas las tareas pendientes tienen un día de plan.', 'fi-empty')]);
    paint(ui.templates, snapshot.templates.length ? snapshot.templates.map(function (t) {
      var deleting = busy.has('templates');
      return el('article', { className: 'fi-template', 'data-key': String(t.id) }, [text('h4', t.titulo || 'Sin título'), text('p', project(t) + ' · ' + number(t.estimadoMin) + ' min · Prioridad ' + (t.prioridad || 'media'), 'fi-note'),
        el('div', { className: 'fi-actions' }, [button('Usar en día seleccionado', 'use-template', { 'data-id': t.id, 'data-write': true, disabled: busy.has('use:' + t.id) }), button('Editar', 'edit-template', { 'data-id': t.id }), button('Eliminar', 'delete-template', { 'data-id': t.id, 'data-write': true, disabled: deleting, className: 'fi-button fi-danger' })])
      ]);
    }) : [text('p', 'Aún no tienes plantillas. Crea la primera con tus propios datos.', 'fi-empty')]);
  }
  function resetTemplate() { editingId = null; ui.templateForm.reset(); ui.templateHeading.textContent = 'Nueva plantilla'; }
  function saveTemplate(event) {
    event.preventDefault();
    if (!ui.templateForm.reportValidity()) return;
    var title = ui.title.value.trim(), minutes = Number(ui.minutes.value);
    if (!title || !Number.isSafeInteger(minutes) || minutes <= 0) { notify('Escribe un título y una duración entera mayor que cero.', true); return; }
    var id = editingId;
    run('templates', ui.templateForm.querySelector('[type="submit"]'), async function () {
      var templates = (api.getTemplates() || []).map(function (t) { return Object.assign({}, t); });
      if (id != null && !templates.some(function (t) { return String(t.id) === String(id); })) throw new Error('La plantilla ya no existe. Crea una nueva.');
      var next = { id: id != null ? id : global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : 'fi-' + Date.now() + '-' + Math.random().toString(36).slice(2), titulo: title, proyecto: ui.templateProject.value.trim(), estimadoMin: minutes, prioridad: ui.priority.value };
      if (id == null) templates.push(next);
      else templates = templates.map(function (t) { return String(t.id) === String(id) ? next : t; });
      await api.saveTemplates(templates); resetTemplate();
    }, 'Plantilla guardada.');
  }
  function changeWeek(next) { week = monday(next); ui.from.value = iso(week); ui.to.value = iso(addDays(week, 6)); refresh(); }
  function onClick(event) {
    var b = event.target.closest('[data-action]');
    if (!b || !root.contains(b) || b.disabled) return;
    var action = b.dataset.action, id = b.dataset.id;
    if (action === 'view') { if(api.navigate) api.navigate(b.dataset.view); else show(b.dataset.view); return; }
    if (action === 'previous') { changeWeek(addDays(week, -7)); return; }
    if (action === 'next') { changeWeek(addDays(week, 7)); return; }
    if (action === 'current') { changeWeek(today()); return; }
    if (action === 'range') { ui.from.value = iso(week); ui.to.value = iso(addDays(week, 6)); renderHistory(); return; }
    if (action === 'select-day') { selectedDay = b.dataset.day; ui.assignDay.value = selectedDay; renderPlan(); return; }
    if (action === 'reset-template') { resetTemplate(); return; }
    if (action === 'open' || action === 'schedule') {
      run(action + ':' + id, b, function () {
        var t = snapshot.tasks.find(function (item) { return String(item.id) === id; });
        if (!t) throw new Error('La tarea ya no está disponible.');
        return action === 'open' ? api.openTask(t.id) : api.scheduleTask(t.id);
      }); return;
    }
    if (action === 'plan-task') {
      var input = b.closest('.fi-task').querySelector('[data-task-date]'), date = input.value;
      if (!localDate(date)) { notify('Selecciona un día válido para la tarea.', true); input.focus(); return; }
      run('plan:' + id, b, function () { var task = snapshot.tasks.find(function (t) { return String(t.id) === id; }); if (!task) throw new Error('La tarea ya no existe.'); return api.planTask(task.id, date); }, 'Día de plan actualizado.'); return;
    }
    if (action === 'retry') { var session = snapshot.sessions.find(function (s) { return String(s.id) === id; }); if (session) run('retry:' + id, b, function () { return api.retrySession(session.id); }, 'Reintento terminado. Revisa el estado de Calendar.'); return; }
    if (action === 'csv' || action === 'xlsx' || action === 'pdf') { run('export:' + action, b, function () { return exportSessions(action); }, 'Archivo descargado.'); return; }
    var template = snapshot.templates.find(function (t) { return String(t.id) === id; });
    if (!template) return;
    if (action === 'edit-template') {
      editingId = template.id; ui.title.value = template.titulo || ''; ui.templateProject.value = template.proyecto || ''; ui.minutes.value = number(template.estimadoMin) || ''; ui.priority.value = template.prioridad || 'media';
      ui.templateHeading.textContent = 'Editar plantilla'; ui.title.focus(); return;
    }
    if (action === 'delete-template') {
      run('templates', b, async function () { await api.saveTemplates((api.getTemplates() || []).filter(function (t) { return String(t.id) !== id; })); if (String(editingId) === id) resetTemplate(); }, 'Plantilla eliminada.'); return;
    }
    if (action === 'use-template') {
      var day = ui.assignDay.value;
      if (!localDate(day)) { notify('Selecciona el día en el que quieres crear la tarea.', true); ui.assignDay.focus(); return; }
      run('use:' + id, b, function () { return api.createTask({ titulo: template.titulo, proyecto: template.proyecto || '', estimadoMin: number(template.estimadoMin), prioridad: template.prioridad || 'media', fechaHacer: day }); }, 'Tarea guardada para ' + fmtDate(localDate(day)) + '. Puedes agendarla desde su ficha.');
    }
  }
  function csvCell(value) {
    if (typeof value === 'number') return String(value);
    var str = String(value == null ? '' : value);
    // También bloquea fórmulas ocultas detrás de espacios o controles.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(str) || /^[\t\r\n]/.test(str)) str = "'" + str;
    return '"' + str.replace(/"/g, '""') + '"';
  }
  async function exportSessions(type) {
    var sessions = filteredSessions(), range = historyRange();
    if (!range) throw new Error('Selecciona un rango válido.');
    if (!sessions.length) throw new Error('No hay sesiones para exportar con estos filtros.');
    var headers = ['ID sesión', 'ID tarea', 'Título', 'Proyecto', 'Subproyecto', 'Inicio UTC (ISO)', 'Fin UTC (ISO)', 'Duración bloque (ms)', 'Duración bloque (min)', 'Tiempo en rango (ms)', 'Estimación tarea (min, no sumable por bloque)', 'Calendar', 'Error Calendar', 'Enlace evento'];
    var data = sessions.map(function (s) { return [String(s.id), String(s.tareaId || ''), String(s.titulo || ''), project(s), String(s.subproyecto || ''), new Date(stamp(s.inicio)).toISOString(), new Date(stamp(s.fin)).toISOString(), sessionDuration(s), sessionDuration(s) / 60000, overlap(stamp(s.inicio), stamp(s.fin), range.from, range.to), taskEstimate(s), states[s.calendarEstado] || 'Estado desconocido', String(s.calendarError || ''), eventURL(s)]; });
    var filename = 'sesiones-' + ui.from.value + '-a-' + ui.to.value + '.' + type, output;
    if (type === 'csv') output = '\uFEFF' + [headers].concat(data).map(function (row) { return row.map(csvCell).join(';'); }).join('\r\n');
    else if (type === 'xlsx') {
      if (!global.XLSX) throw new Error('Excel no está disponible. Usa CSV.');
      var sheet = global.XLSX.utils.aoa_to_sheet([headers].concat(data));
      // Las celdas de usuario son texto explícito; nunca fórmulas ni hipervínculos automáticos.
      Object.keys(sheet).forEach(function (key) { if (key[0] !== '!' && typeof sheet[key].v === 'string') { sheet[key].t = 's'; delete sheet[key].f; delete sheet[key].l; } });
      sheet['!cols'] = headers.map(function (_, i) { return { wch: i === 2 || i === 12 || i === 13 ? 44 : 25 }; });
      var book = global.XLSX.utils.book_new(); global.XLSX.utils.book_append_sheet(book, sheet, 'Sesiones');
      var meta = global.XLSX.utils.aoa_to_sheet([['Desde local', ui.from.value], ['Hasta local inclusive', ui.to.value], ['Búsqueda', ui.search.value], ['Proyecto', ui.project.value || 'Todos'], ['Zona horaria', Intl.DateTimeFormat().resolvedOptions().timeZone], ['Nota', 'Duración del bloque completa; tiempo en rango recortado por fechas locales. Estimación de tarea: no sumar por bloques.']]);
      Object.keys(meta).forEach(function (key) { if (key[0] !== '!' && typeof meta[key].v === 'string') { meta[key].t = 's'; delete meta[key].f; delete meta[key].l; } });
      global.XLSX.utils.book_append_sheet(book, meta, 'Filtros');
      output = global.XLSX.write(book, { bookType: 'xlsx', type: 'array' });
    } else {
      if (!global.jspdf || !global.jspdf.jsPDF) throw new Error('PDF no está disponible. Usa CSV.');
      var pdf = new global.jspdf.jsPDF(), y = 18;
      function line(value, size) {
        pdf.setFontSize(size || 10);
        pdf.splitTextToSize(String(value), 178).forEach(function (part) { if (y > 278) { pdf.addPage(); y = 18; } pdf.text(part, 16, y); y += (size || 10) * 0.5; });
      }
      line('Historial de sesiones', 17);
      line('Rango local: ' + ui.from.value + ' a ' + ui.to.value + ' (inclusive).');
      line('Proyecto: ' + (ui.project.value || 'Todos') + ' | Búsqueda: ' + (ui.search.value || 'Sin filtro'));
      line('Fechas de bloques en UTC (ISO). La estimación es de tarea, no de sesión.');
      data.forEach(function (row, i) { y += 5; line('Sesión ' + (i + 1), 12); headers.forEach(function (header, j) { line(header + ': ' + row[j]); }); });
      output = pdf.output('arraybuffer');
    }
    await api.download(filename, output);
  }
  global.FicheroInsights = { mount: mount, show: show, refresh: refresh };
})(window);
