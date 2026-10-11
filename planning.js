/* Plan diario elegido por la persona. No ordena ni borra las fichas del tablero. */
(function (global) {
  'use strict';
  var api, root, dialog, ui = {}, draft = [], target, todayPlan = {}, tomorrowPlan = {};
  var working = false, refreshing = false, lastNotice = '', opener, lastSync = 0, previewTomorrow = false;
  function timeMinutes(value) { if(!/^\d{2}:\d{2}$/.test(value || '')) return null; var p=value.split(':').map(Number); return p[0]<24 && p[1]<60 ? p[0]*60+p[1] : null; }
  function clockTime(value) { return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0'); }
  function timeRange(item) { var start=timeMinutes(item.startTime); return start == null ? 'Sin horario' : item.startTime+' – '+clockTime(start+Number(item.minutes || 0)); }
  function minutesLabel(value) { var m=Math.round(value); return m>=60 ? Math.floor(m/60)+' h'+(m%60 ? ' '+m%60+' min' : '') : m+' min'; }
  function isBreak(item) { return item.kind === 'break'; }
  function itemTitle(item, all) { var t=all.find(function(t){return t.id===item.id;}); return isBreak(item) ? item.title || 'Descanso' : t ? t.titulo : 'Tarea no disponible'; }
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
  function controls() { root.querySelectorAll('button').forEach(function (b) { b.disabled = working || !api.ready(); }); dialog.querySelectorAll('button,input').forEach(function (b) { b.disabled = working || b.dataset.boundary === 'true'; }); }
  function mount(bridge) {
    api = bridge; root = document.getElementById('daily-planning');
    api.nightly.changed = function (text, error) { message(text, error); };
    global.FicheroNightly.mount(api.nightly);
    ui.status = node('p', '', 'dp-status'); ui.status.setAttribute('role', 'status'); ui.status.setAttribute('aria-live', 'polite');
    ui.route = node('div', null, 'dp-route'); ui.email = node('p', 'Los correos aún no están activados.', 'dp-note');
    var heading = node('div', null, 'dp-heading');
    var identity=node('div',null,'dp-identity'), titles=node('div',null,'dp-heading-copy'), titleRow=node('div',null,'dp-title-row');
    var symbol=node('span','⚑','dp-symbol'); symbol.setAttribute('aria-hidden','true');
    ui.headingTitle=node('h2','Tu ruta guiada de hoy'); ui.badge=node('span','Por preparar','dp-plan-badge');
    titleRow.append(ui.headingTitle,ui.badge);
    titles.append(titleRow,node('p','Tus tareas, tus horarios. Un bloque a la vez, sin decidir de nuevo qué viene después.','dp-subtitle'));
    identity.append(symbol,titles);
    var headingActions=node('div',null,'dp-heading-actions');
    ui.editToday=button('Editar hoy',function(){open(dates().today);});
    headingActions.append(ui.editToday,button('Preparar mañana',function(){open();}));
    heading.append(identity,headingActions);
    var footer=node('div',null,'dp-route-footer');
    ui.planState=node('p','','dp-note');
    ui.preview=button('Ver ruta de mañana',function(){previewTomorrow=!previewTomorrow;paintRoute();});
    footer.append(ui.planState,ui.preview);
    var settings = node('details', null, 'dp-settings');
    settings.append(node('summary', 'Recordatorio nocturno por correo'), ui.email,
      node('p', 'A las 8, 9, 10 y 11 p. m. (Lima). El correo de Calendar incluye el enlace al planificador. Al guardar o elegir «Hoy no», se cancelan los restantes de esa noche. No hace falta mantener la página abierta para recibirlos.', 'dp-note'),
      button('Activar correos con Google Calendar', function () { action(async function () { var s=await global.FicheroNightly.enable(); message(s.pending.length ? 'Activación pendiente: conecta Google y reintenta.' : 'Recordatorios configurados en Calendar.', !!s.pending.length); }); }),
      button('Desactivar correos', function () { action(async function () { var s=await global.FicheroNightly.disable(); message(s.pending.length ? 'Desactivación pendiente: los correos pueden seguir llegando hasta que conectes Google.' : 'Recordatorios desactivados.', !!s.pending.length); }); }),
      button('Reintentar sincronización', function () { action(async function () { var s=await global.FicheroNightly.sync(); message(s.pending.length ? 'Quedan operaciones pendientes. Conecta Google para completarlas.' : 'Sincronización revisada.', !!s.pending.length); }); }),
      node('p', 'Para cancelar avisos, abre el enlace y guarda tu decisión con Google conectado. Responder directamente al correo no modifica el plan. Si falla la conexión, te lo indicaremos y reintentaremos al volver.', 'dp-note'));
    footer.prepend(settings);
    root.append(heading, ui.route, footer, ui.status);
    buildDialog();
    global.addEventListener('hashchange', deepLink);
    setInterval(function () { refresh(); }, 60000);
    setInterval(tickRoute,1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    refresh(); deepLink();
  }
  function buildDialog() {
    dialog = node('dialog', null, 'dp-dialog'); dialog.setAttribute('aria-labelledby', 'dp-title');
    ui.title = node('h2', '¿Qué haremos mañana?'); ui.title.id = 'dp-title';
    ui.capacity = input('number', '4'); ui.capacity.min = '0.25'; ui.capacity.max = '24'; ui.capacity.step = '0.25';
    ui.capacity.addEventListener('input', paintSummary);
    ui.begin=input('time','09:00'); ui.begin.step='60';
    var scheduleControls=node('div',null,'dp-schedule-controls');
    scheduleControls.append(field('Hora de inicio (Lima)',ui.begin),button('Distribuir mis bloques',distribute),button('+ Añadir descanso',function(){
      draft.push({id:'break-'+(global.crypto.randomUUID ? global.crypto.randomUUID() : Date.now().toString(36)),kind:'break',title:'Almuerzo y descanso',minutes:30,startTime:''});paintDraft();
    }));
    ui.summary = node('p', '', 'dp-note'); ui.summary.setAttribute('aria-live', 'polite');
    ui.queue = node('ol', null, 'dp-queue'); ui.candidates = node('div', null, 'dp-candidates');
    ui.search = input('search', ''); ui.search.placeholder = 'Buscar entre tus pendientes'; ui.search.addEventListener('input', paintCandidates);
    var actions = node('div', null, 'dp-actions');
    actions.append(button('Guardar mi plan', save), button('Hoy no voy a planificar', skip), button('Cerrar sin guardar', close));
    ui.dialogStatus = node('p', '', 'dp-status'); ui.dialogStatus.setAttribute('role', 'status');
    dialog.append(ui.title, node('p', 'Elige pocas tareas y ordénalas. La primera será tu punto de partida. Esto no cambia sus vencimientos ni agenda bloques automáticamente.', 'dp-note'),
      field('Horas que tú tienes disponibles', ui.capacity), scheduleControls, ui.summary, ui.queue,
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
  async function open(day) {
    if (!api.ready()) { message('Espera a que carguen tus tareas.', true); return; }
    target = day === dates().today ? day : dates().tomorrow; opener = document.activeElement;
    try {
      var plan = await api.getDay(target), available = tasks();
      draft = (plan.items || []).filter(function (item) { return isBreak(item) || api.tasks().some(function (t) { return t.id === item.id; }); }).map(function (item) { return Object.assign({}, item); });
      // Una asignación semanal previa es una propuesta editable, no un plan confirmado.
      if (!done(plan) && !draft.length) draft = available.filter(function (t) { return t.fechaHacer === target; }).map(itemFromTask);
      ui.title.textContent = (target===dates().today ? 'Tu ruta de hoy' : '¿Qué haremos mañana?') + ' · ' + target;
      ui.begin.value=plan.startTime || '09:00';
      ui.capacity.value = plan.capacity || '4'; ui.search.value = ''; ui.dialogStatus.textContent = '';
      paintDraft(); paintCandidates(); dialog.showModal(); ui.capacity.focus();
    } catch (e) { message('No pude abrir tu plan. ' + (e.message || ''), true); }
  }
  function itemFromTask(t) { return { id: t.id, minutes: Number(t.estimadoMin) > 0 ? Number(t.estimadoMin) : 0 }; }
  function paintSummary() {
    var total = draft.reduce(function (sum, item) { return sum + (Number(item.minutes) || 0); }, 0);
    var capacity = Number(ui.capacity.value) * 60, missing = draft.filter(function (i) { return !(i.minutes > 0); }).length;
    ui.summary.textContent = draft.filter(function(i){return !isBreak(i);}).length + ' tareas · ' + total + ' min con descansos. ' +
      (missing ? missing + ' sin duración: completa el tiempo que dedicarás. ' : '') +
      (capacity > 0 && total > capacity ? 'Tu plan supera en ' + Math.round(total - capacity) + ' min las horas disponibles. Puedes quitar tareas o reducir bloques.' : 'Deja margen para pausas e imprevistos.');
  }
  function paintDraft(focusId, direction) {
    ui.queue.replaceChildren(); var all = api.tasks();
    draft.forEach(function (item, i) {
      var t = all.find(function (t) { return t.id === item.id; }); if (!t && !isBreak(item)) return;
      var title=itemTitle(item,all), row = node('li', null, 'dp-item'+(isBreak(item) ? ' dp-item-break' : '')); row.dataset.id = item.id;
      row.append(node('strong', (i === 0 && !isBreak(item) ? 'Empezar por aquí: ' : '') + title));
      var minutes = input('number', item.minutes || ''); minutes.min = '1'; minutes.max = '1440'; minutes.step = '1';
      minutes.addEventListener('input', function () { item.minutes = Number(minutes.value); paintSummary(); });
      var fields=node('div',null,'dp-item-fields'), start=input('time',item.startTime || ''); start.step='60';
      start.addEventListener('input',function(){item.startTime=start.value;paintSummary();});
      fields.append(field(isBreak(item) ? 'Duración del descanso' : 'Minutos que dedicarás', minutes),field('Hora de inicio (opcional)',start));
      if(isBreak(item)){var name=input('text',title);name.maxLength=120;name.addEventListener('input',function(){item.title=name.value;});fields.append(field('Nombre del descanso',name));}
      row.append(fields);
      var actions = node('div', null, 'dp-actions');
      [-1, 1].forEach(function (delta) {
        var b = button(delta < 0 ? 'Subir' : 'Bajar', function () {
          var next = i + delta; if (next < 0 || next >= draft.length) return;
          draft.splice(i, 1); draft.splice(next, 0, item); paintDraft(item.id, delta);
        });
        b.disabled = i + delta < 0 || i + delta >= draft.length; b.dataset.boundary=String(b.disabled); b.dataset.move = delta;
        b.setAttribute('aria-label', (delta < 0 ? 'Subir ' : 'Bajar ') + title); actions.append(b);
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
    var sorted=draft.filter(function(i){return !isBreak(i);}).sort(function (a, b) {
      var ta = all.find(function (t) { return t.id === a.id; }) || {}, tb = all.find(function (t) { return t.id === b.id; }) || {};
      var da = ta.fecha || '9999', db = tb.fecha || '9999';
      return da.localeCompare(db) || (weights[ta.prioridad] == null ? 1 : weights[ta.prioridad]) - (weights[tb.prioridad] == null ? 1 : weights[tb.prioridad]);
    });
    var cursor=0; draft=draft.map(function(i){return isBreak(i) ? i : sorted[cursor++];});
    paintDraft(); ui.dialogStatus.textContent = 'Sugerencia aplicada: primero lo que vence antes; a igual fecha, la prioridad. Puedes cambiar el orden.';
  }
  function distribute(){
    var cursor=timeMinutes(ui.begin.value);
    if(cursor==null || draft.some(function(i){return !Number.isInteger(i.minutes) || i.minutes<=0;}) || cursor+draft.reduce(function(sum,i){return sum+i.minutes;},0)>1440){
      ui.dialogStatus.textContent='Elige una hora de inicio y duraciones válidas que quepan en el día.'; return;
    }
    draft.forEach(function(i){i.startTime=clockTime(cursor);cursor+=i.minutes;});paintDraft();
    ui.dialogStatus.textContent='Horarios distribuidos en tu orden, incluidos los descansos. Puedes cambiar cada hora; no se han creado eventos en Calendar.';
  }
  function scheduleError(items){
    var ranges=[];
    for(var i of items){
      if(!i.startTime) continue;
      var start=timeMinutes(i.startTime),end=start+Number(i.minutes);
      if(start==null || end>1440) return 'Un bloque queda fuera del día. Ajusta su hora o duración.';
      if(ranges.some(function(r){return start<r.end && end>r.start;})) return 'Hay bloques que se solapan. Ajusta los horarios antes de guardar.';
      if(ranges.length && start<ranges[ranges.length-1].start) return 'El orden de los bloques no coincide con sus horas. Ajusta las horas o pulsa «Distribuir mis bloques».';
      ranges.push({start:start,end:end});
    }
    return '';
  }
  async function finishPlan(state) {
    if (target !== dates().tomorrow && target !== dates().today) { ui.dialogStatus.textContent = 'Cambió el día. Cierra y vuelve a abrir para planificar.'; return; }
    if (state === 'guardado') {
      if (!draft.length) { ui.dialogStatus.textContent = 'Elige al menos una tarea o pulsa «Hoy no voy a planificar».'; return; }
      if (!ui.capacity.reportValidity() || draft.some(function (i) { return !Number.isInteger(i.minutes) || i.minutes <= 0 || i.minutes > 1440; })) {
        ui.dialogStatus.textContent = 'Completa las horas disponibles y una duración de 1 a 1440 minutos por tarea.'; return;
      }
      if(!draft.some(function(i){return !isBreak(i);})){ui.dialogStatus.textContent='Añade al menos una tarea a tu ruta, además de los descansos.';return;}
      if (draft.some(function (i) { return !isBreak(i) && !api.tasks().some(function (t) { return t.id === i.id; }); })) { ui.dialogStatus.textContent = 'Una tarea fue eliminada. Quítala del plan antes de guardar.'; return; }
      var conflict=scheduleError(draft); if(conflict){ui.dialogStatus.textContent=conflict;return;}
    }
    await action(async function () {
      var data = { estado: state, items: state === 'guardado' ? draft : [], orden: state === 'guardado' ? draft.map(function (i) { return i.id; }) : [], capacity: Number(ui.capacity.value) || 4, startTime:ui.begin.value || '', actualizado: Date.now() };
      await api.saveDay(target, data);
      dialog.close(); cleanupHash();
      message(state === 'guardado' ? 'Tu ruta está guardada, en el orden que elegiste.' : 'Elegiste no planificar ese día.');
      try { var s=await global.FicheroNightly.finish(target); if(s.pending.length) message('Tu decisión está guardada. La cancelación de correos está pendiente: conecta Google y reintenta.',true); }
      catch (e) { message('Tu decisión está guardada, pero no pude cancelar todos los correos. Conecta Google y pulsa «Reintentar sincronización».', true); }
    });
  }
  function save() { finishPlan('guardado'); }
  function skip() { finishPlan('omitido'); }
  function paintRoute(){
    var date=previewTomorrow ? dates().tomorrow : dates().today, plan=previewTomorrow ? tomorrowPlan : todayPlan, all=api.tasks();
    var entries=(plan.items || []).map(function(item){return {item:item,task:all.find(function(t){return t.id===item.id;})};}).filter(function(e){return isBreak(e.item) || e.task;});
    var active=previewTomorrow ? null : tasks().find(function(t){return t.estado==='curso' && !t.pausada && t.cursoDesde;});
    if(active && !entries.some(function(e){return e.task && e.task.id===active.id;})) entries.unshift({item:{id:active.id,minutes:Number(active.estimadoMin)||0},task:active,outside:true});
    var next=entries.find(function(e){return e.task && e.task.estado!=='hecho' && !(e.task.estado==='curso' && !e.task.pausada);});
    ui.headingTitle.textContent=previewTomorrow ? 'Tu ruta guiada de mañana' : 'Tu ruta guiada de hoy';
    ui.badge.textContent=active ? 'En marcha' : plan.estado==='guardado' ? 'Plan listo' : 'Por preparar';
    ui.badge.dataset.ready=String(!!active || plan.estado==='guardado');
    ui.editToday.textContent=done(todayPlan) ? 'Editar hoy' : 'Armar ruta de hoy';
    ui.preview.textContent=previewTomorrow ? 'Volver a hoy' : 'Ver ruta de mañana';
    ui.preview.setAttribute('aria-pressed',String(previewTomorrow));
    ui.planState.textContent=done(tomorrowPlan) ? (tomorrowPlan.estado==='guardado' ? '✓ Mañana está preparado' : 'Elegiste no planificar mañana') : 'Mañana aún está por preparar';
    var scroll=ui.route.scrollLeft;
    ui.route.replaceChildren(); ui.route.classList.toggle('dp-route-empty',!entries.length);
    if(!entries.length){
      var empty=node('div',null,'dp-empty');
      empty.append(node('span','◷','dp-empty-symbol'),node('h3','Dale una ruta a tu día'),
        node('p','Elige las tareas, ponles una hora y añade tus descansos. Aquí verás cada bloque en el orden que tú decidas.','dp-note'),
        button('Armar mi ruta',function(){open(date);}));
      ui.route.append(empty);
    }
    entries.forEach(function(entry,index){
      var item=entry.item,t=entry.task,rest=isBreak(item),live=!previewTomorrow && t && t.estado==='curso' && !t.pausada && t.cursoDesde;
      var complete=t && t.estado==='hecho',paused=t && t.estado==='curso' && t.pausada,isNext=entry===next;
      var kind=complete ? 'done' : live ? 'active' : rest ? 'break' : paused ? 'paused' : isNext ? 'next' : 'later';
      var card=node('article',null,'dp-block dp-block-'+kind);card.dataset.taskId=t ? t.id : '';card.dataset.kind=kind;
      var top=node('div',null,'dp-block-top'), time=node('span',timeRange(item),'dp-block-time');
      if(entry.outside) time.textContent='Ahora · fuera del plan';
      var status=complete ? 'Hecha' : live ? 'En curso' : rest ? 'Descanso' : paused ? 'Pausada' : isNext ? 'Siguiente' : 'Bloque '+(index+1);
      top.append(time,node('span',status,'dp-block-badge'));
      var title=itemTitle(item,all), heading=node('h3',title);heading.title=title;
      var subtitle=node('p',rest ? 'Una pausa también es parte del plan' : live ? '' : complete ? 'Completada · buen trabajo' : (t.prioridad ? 'Prioridad '+t.prioridad+' · ' : '')+minutesLabel(Number(item.minutes)||0)+' previstos','dp-block-description');
      if(live){subtitle.dataset.liveStart=t.cursoDesde; subtitle.dataset.liveMinutes=item.minutes || '';}
      var foot=node('div',null,'dp-block-meta');
      if(t){
        var control=button(live ? 'Ver tarea en curso' : complete || previewTomorrow || !isNext ? 'Ver tarea' : paused ? 'Reanudar' : 'Empezar',function(){
          action(async function(){if(live || complete || previewTomorrow || !isNext) api.openTask(t.id);else await api.start(t.id);});
        });control.classList.add('dp-block-action');
        if(live){control.setAttribute('aria-label','Ver tarea en curso');control.dataset.remainingStart=t.cursoDesde;control.dataset.remainingMinutes=item.minutes || '';}
        foot.append(control);
        if(isNext && t.fecha){var due=node('span',t.fecha===date ? 'Vence '+(t.horaLimite || 'hoy') : 'Vence '+t.fecha,'dp-block-due');foot.append(due);}
        else {var project=node('span',t.proyecto || 'Sin proyecto','dp-block-project');project.title=t.proyecto || 'Sin proyecto';foot.append(project);}
      } else {
        foot.append(node('span','☕ Recargar energía'),node('span',minutesLabel(item.minutes)));
      }
      card.append(top,heading,subtitle,foot);
      ui.route.append(card);
    });
    ui.route.scrollLeft=scroll;tickRoute();controls();
  }
  function tickRoute(){
    if(!ui.route) return;
    ui.route.querySelectorAll('[data-live-start]').forEach(function(n){
      var elapsed=Math.max(0,Math.floor((Date.now()-Number(n.dataset.liveStart))/60000));
      n.textContent=minutesLabel(elapsed)+' transcurridos';
    });
    ui.route.querySelectorAll('[data-remaining-start]').forEach(function(n){
      var planned=Number(n.dataset.remainingMinutes),elapsed=Math.max(0,(Date.now()-Number(n.dataset.remainingStart))/60000);
      n.textContent=planned>0 ? elapsed<planned ? '◷ Quedan ~'+minutesLabel(Math.ceil(planned-elapsed)) : '◷ Bloque estimado superado' : '◷ Sin duración estimada';
    });
  }
  async function refresh() {
    if (!api || !api.ready() || refreshing) { if (api && !api.ready()) setTimeout(refresh, 500); return; }
    refreshing = true;
    try {
      var now = dates(), plans = await Promise.all([api.getDay(now.today), api.getDay(now.tomorrow), api.nightly.read()]);
      todayPlan = plans[0]; tomorrowPlan = plans[1];
      var pending = (plans[2].pending || []).length;
      ui.email.textContent = pending ? 'Hay operaciones pendientes con Calendar: revisa la conexión y reintenta.' : plans[2].enabled ? 'Recordatorios activados. Último aviso: 11 p. m. (Lima).' : 'Los correos están desactivados.';
      paintRoute();
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
