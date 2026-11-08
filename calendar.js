/* Calendario sincronizado con Google Calendar (calendario principal).
   Google es la fuente de verdad: lo que se crea, edita o borra aquí se escribe
   al instante en Google, y lo que cambia en Google aparece al refrescar
   (cada minuto con la vista abierta, al volver a la pestaña o con «Sincronizar»). */
(function (global) {
  'use strict';
  var CAL = 'Google Calendar';
  var HORA_PX = 48;            // alto de una hora en la rejilla
  var POLL_MS = 60000;
  var COLORES = { '1': '#7986CB', '2': '#33B679', '3': '#8E24AA', '4': '#E67C73', '5': '#F6BF26', '6': '#F4511E',
    '7': '#039BE5', '8': '#616161', '9': '#3F51B5', '10': '#0B8043', '11': '#D50000' };
  var LS_VISTA = 'fichero-calendario-vista', LS_VENC = 'fichero-calendario-venc';

  var api = null, root = null, ui = {}, visible = false;
  var vista = null, ancla = null;               // ancla: fecha AAAA-MM-DD de referencia
  var eventos = [], estado = 'idle', error = null, sello = 0, pedido = 0, temporizador = null;
  var dialogo = null, editando = null, guardando = false;

  // ---------- fechas (zona del navegador) ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function aFecha(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function mas(s, n) { var d = aFecha(s); d.setDate(d.getDate() + n); return iso(d); }
  function lunes(s) { var d = aFecha(s); return mas(s, -((d.getDay() + 6) % 7)); }
  function hoy() { return api && api.today ? api.today() : iso(new Date()); }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function mayus(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function rango(v, a) {
    if (v === 'dia') return { desde: a, hasta: a };
    if (v === 'semana') { var l = lunes(a); return { desde: l, hasta: mas(l, 6) }; }
    var l2 = lunes(a.slice(0, 8) + '01');
    return { desde: l2, hasta: mas(l2, 41) };
  }

  // Inicio y fin (exclusivo) de un evento como Date; todoDia si usa fechas.
  function tiempos(ev) {
    var s = ev.start || {}, e = ev.end || {};
    if (s.date) {
      var ini = aFecha(String(s.date).slice(0, 10));
      var fin = e.date ? aFecha(String(e.date).slice(0, 10)) : new Date(ini.getTime() + 86400000);
      return { ini: ini, fin: fin, todoDia: true };
    }
    var a = new Date(s.dateTime), b = e.dateTime ? new Date(e.dateTime) : new Date(a.getTime() + 3600000);
    return { ini: a, fin: b, todoDia: false };
  }
  // ¿El evento toca el día? (para los de día completo, fin es exclusivo)
  function tocaDia(t, dia) {
    var a = aFecha(dia), b = aFecha(mas(dia, 1));
    return t.ini < b && t.fin > a || (!t.todoDia && t.ini.getTime() === t.fin.getTime() && t.ini >= a && t.ini < b);
  }

  // Coloca los eventos con hora de un día en columnas para que no se pisen.
  function distribuir(evs, dia) {
    var a = aFecha(dia).getTime(), b = aFecha(mas(dia, 1)).getTime();
    var items = evs.map(function (ev) {
      var t = tiempos(ev);
      var ini = Math.max(t.ini.getTime(), a), fin = Math.min(Math.max(t.fin.getTime(), t.ini.getTime() + 15 * 60000), b);
      return { ev: ev, ini: (ini - a) / 60000, fin: (fin - a) / 60000 };
    }).sort(function (x, y) { return x.ini - y.ini || y.fin - x.fin; });
    var grupo = [], finGrupo = -1, salida = [];
    function cerrar() {
      var cols = 0; grupo.forEach(function (i) { cols = Math.max(cols, i.col + 1); });
      grupo.forEach(function (i) { i.cols = cols; salida.push(i); });
      grupo = [];
    }
    items.forEach(function (it) {
      if (grupo.length && it.ini >= finGrupo) cerrar();
      var usadas = grupo.filter(function (g) { return g.fin > it.ini; }).map(function (g) { return g.col; });
      var c = 0; while (usadas.indexOf(c) >= 0) c++;
      it.col = c; grupo.push(it); finGrupo = Math.max(finGrupo, it.fin);
    });
    if (grupo.length) cerrar();
    return salida;
  }

  function editable(ev) { return !ev.organizer || ev.organizer.self === true || !!ev.guestsCanModify; }
  function color(ev) { return COLORES[ev.colorId] || 'var(--accent)'; }
  function titulo(ev) { return ev.summary || '(sin título)'; }

  // ---------- datos ----------
  function mcp() { return api && api.mcp ? api.mcp() : null; }

  async function cargar(silencioso) {
    var m = mcp();
    if (!m) { estado = 'sin-google'; pintar(); return; }
    var r = rango(vista, ancla), mio = ++pedido;
    if (!silencioso) { estado = 'cargando'; pintar(); }
    try {
      var lista = [], token = null, vueltas = 0;
      do {
        var input = { startTime: aFecha(r.desde).toISOString(), endTime: aFecha(mas(r.hasta, 1)).toISOString(),
          orderBy: 'startTime', pageSize: 250, timeZone: api.timeZone };
        if (token) input.pageToken = token;
        var res = await m.callTool(CAL, 'list_events', input);
        var p = (res && res.payload) || {};
        lista = lista.concat(p.events || []);
        token = p.nextPageToken || null;
      } while (token && ++vueltas < 6);
      if (mio !== pedido) return;
      eventos = lista.filter(function (e) { return e.status !== 'cancelled'; });
      estado = 'listo'; error = null; sello = Date.now();
    } catch (e) {
      if (mio !== pedido) return;
      error = e; estado = eventos.length ? 'listo' : 'error';
    }
    pintar();
  }

  function programar() {
    clearInterval(temporizador); temporizador = null;
    if (visible) temporizador = setInterval(function () { if (!document.hidden) cargar(true); }, POLL_MS);
  }

  // ---------- interfaz ----------
  function n(tag, cls, text) { var x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
  function boton(texto, fn, cls) { var b = n('button', cls || 'btn', texto); b.type = 'button'; b.addEventListener('click', fn); return b; }

  function construir() {
    root.replaceChildren();
    var cab = n('div', 'gc-cab');
    var nav = n('div', 'gc-nav');
    ui.ant = boton('‹', function () { mover(-1); }, 'btn gc-flecha'); ui.ant.setAttribute('aria-label', 'Anterior');
    ui.hoy = boton('Hoy', function () { ancla = hoy(); cargar(); });
    ui.sig = boton('›', function () { mover(1); }, 'btn gc-flecha'); ui.sig.setAttribute('aria-label', 'Siguiente');
    ui.titulo = n('h2', 'gc-titulo'); ui.titulo.id = 'gc-titulo';
    nav.append(ui.ant, ui.hoy, ui.sig, ui.titulo);
    var der = n('div', 'gc-der');
    ui.vistas = n('span', 'vistas gc-vistas'); ui.vistas.setAttribute('role', 'group'); ui.vistas.setAttribute('aria-label', 'Vista del calendario');
    [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes']].forEach(function (v) {
      var b = boton(v[1], function () { cambiarVista(v[0]); }, ''); b.dataset.gcVista = v[0]; ui.vistas.appendChild(b);
    });
    ui.venc = n('label', 'gc-venc'); ui.vencInput = n('input'); ui.vencInput.type = 'checkbox';
    try { ui.vencInput.checked = localStorage.getItem(LS_VENC) !== '0'; } catch (e) { ui.vencInput.checked = true; }
    ui.vencInput.addEventListener('change', function () { try { localStorage.setItem(LS_VENC, ui.vencInput.checked ? '1' : '0'); } catch (e) {} pintar(); });
    ui.venc.append(ui.vencInput, document.createTextNode(' Vencimientos de fichas'));
    ui.sync = boton('↻ Sincronizar', function () { cargar(); }, 'btn-ghost gc-sync');
    ui.nuevo = boton('+ Evento', function () { abrirDialogo(null, { fecha: ancla, hora: proximaHora() }); }, 'btn-primary');
    der.append(ui.vistas, ui.venc, ui.sync, ui.nuevo);
    cab.append(nav, der);
    ui.estado = n('p', 'gc-estado'); ui.estado.setAttribute('role', 'status');
    ui.cuerpo = n('div', 'gc-cuerpo');
    root.append(cab, ui.estado, ui.cuerpo);
    construirDialogo();
  }

  function proximaHora() { var d = new Date(); return Math.min(23, d.getHours() + 1) * 60; }

  function mover(signo) {
    if (vista === 'dia') ancla = mas(ancla, signo);
    else if (vista === 'semana') ancla = mas(ancla, 7 * signo);
    else { var d = aFecha(ancla); d.setDate(1); d.setMonth(d.getMonth() + signo); ancla = iso(d); }
    cargar();
  }
  function cambiarVista(v) {
    vista = v; try { localStorage.setItem(LS_VISTA, v); } catch (e) {}
    cargar();
  }

  function etiqueta() {
    var d = aFecha(ancla);
    if (vista === 'mes') return mayus(d.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' }));
    if (vista === 'dia') return mayus(d.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' }));
    var r = rango(vista, ancla), a = aFecha(r.desde), b = aFecha(r.hasta);
    var ma = a.toLocaleDateString('es-PE', { month: 'short' }).replace('.', ''), mb = b.toLocaleDateString('es-PE', { month: 'short' }).replace('.', '');
    return a.getDate() + (ma === mb ? '' : ' ' + ma) + ' – ' + b.getDate() + ' ' + mb + ' ' + b.getFullYear();
  }

  function vencimientos() {
    if (!ui.vencInput || !ui.vencInput.checked || !api.tasks) return [];
    return api.tasks().filter(function (t) { return t.fecha && t.estado !== 'hecho'; });
  }

  function msgError(e) {
    var c = e && e.code;
    if (c === 'needs_reauth') return 'Tu conexión con Google caducó. Pulsa «Reconectar Google» arriba.';
    if (c === 'rate_limited' || c === 'upstream_error') return 'Google Calendar no respondió. Reintentaré en un minuto.';
    return 'No se pudo leer Google Calendar' + (e && e.message ? ': ' + e.message : '.');
  }

  function pintar() {
    if (!root || !visible) return;
    ui.titulo.textContent = etiqueta();
    Array.prototype.forEach.call(ui.vistas.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.gcVista === vista)); });
    var conectado = !!mcp();
    ui.nuevo.disabled = !conectado; ui.sync.disabled = !conectado;
    ui.estado.classList.toggle('gc-error', !!error);
    if (!conectado) {
      ui.estado.textContent = '';
      ui.cuerpo.replaceChildren();
      var v = n('div', 'gc-vacio');
      v.append(n('h3', null, 'Conecta tu Google Calendar'),
        n('p', null, 'Verás aquí todos los eventos de tu calendario principal y podrás crearlos, moverlos o borrarlos desde el fichero. Los cambios se guardan directamente en Google.'));
      var c = document.getElementById('conectar-google');
      if (c) v.appendChild(boton(c.textContent || 'Conectar Google', function () { c.click(); }, 'btn-primary'));
      else v.appendChild(n('p', 'gc-nota', 'Usa el botón «Conectar Google» de la barra superior.'));
      ui.cuerpo.appendChild(v);
      return;
    }
    if (estado === 'cargando' && !eventos.length) ui.estado.textContent = 'Leyendo tu calendario…';
    else if (error) ui.estado.textContent = msgError(error);
    else if (sello) ui.estado.textContent = 'Sincronizado con Google Calendar · ' + hhmm(new Date(sello));
    else ui.estado.textContent = '';
    var scroll = ui.cuerpo.querySelector('.gc-scroll'), arriba = scroll ? scroll.scrollTop : null;
    ui.cuerpo.replaceChildren();
    if (vista === 'mes') pintarMes(); else pintarRejilla(arriba);
  }

  function chipEvento(ev, cls) {
    var b = n('button', 'gc-chip ' + (cls || '')); b.type = 'button';
    b.style.setProperty('--ev', color(ev));
    var t = tiempos(ev);
    if (!t.todoDia) b.appendChild(n('em', null, hhmm(t.ini)));
    b.appendChild(document.createTextNode(titulo(ev)));
    b.title = titulo(ev);
    b.addEventListener('click', function (e) { e.stopPropagation(); abrirDialogo(ev); });
    return b;
  }
  function chipTarea(t) {
    var b = n('button', 'gc-chip gc-tarea'); b.type = 'button';
    b.appendChild(n('em', null, 'Vence'));
    b.appendChild(document.createTextNode(t.titulo || 'Tarea'));
    b.title = 'Ficha: ' + (t.titulo || '') + ' — clic para abrirla';
    b.addEventListener('click', function (e) { e.stopPropagation(); if (api.openTask) api.openTask(t.id); });
    return b;
  }

  function pintarRejilla(arriba) {
    var r = rango(vista, ancla), dias = [];
    for (var d = r.desde; d <= r.hasta; d = mas(d, 1)) dias.push(d);
    var porDia = {}, todoDia = {}, tareas = vencimientos();
    dias.forEach(function (dia) { porDia[dia] = []; todoDia[dia] = []; });
    eventos.forEach(function (ev) {
      var t = tiempos(ev);
      dias.forEach(function (dia) { if (tocaDia(t, dia)) (t.todoDia ? todoDia : porDia)[dia].push(ev); });
    });
    var marco = n('div', 'gc-rejilla gc-' + vista);
    marco.style.setProperty('--dias', dias.length);
    // cabecera con días y fila de eventos de todo el día
    var cab = n('div', 'gc-fila gc-cabdias');
    cab.appendChild(n('div', 'gc-gutter'));
    var fila = n('div', 'gc-fila gc-todo');
    fila.appendChild(n('div', 'gc-gutter', 'todo el día'));
    dias.forEach(function (dia) {
      var f = aFecha(dia), c = n('button', 'gc-dia-cab' + (dia === hoy() ? ' es-hoy' : '')); c.type = 'button';
      c.append(n('span', null, f.toLocaleDateString('es-PE', { weekday: 'short' }).replace('.', '')), n('b', null, f.getDate()));
      c.title = 'Ver el día'; c.addEventListener('click', function () { ancla = dia; cambiarVista('dia'); });
      cab.appendChild(c);
      var celda = n('div', 'gc-todo-celda');
      todoDia[dia].forEach(function (ev) { celda.appendChild(chipEvento(ev)); });
      tareas.filter(function (t) { return t.fecha === dia; }).forEach(function (t) { celda.appendChild(chipTarea(t)); });
      celda.addEventListener('dblclick', function () { abrirDialogo(null, { fecha: dia, todoDia: true }); });
      fila.appendChild(celda);
    });
    marco.append(cab, fila);

    var scroll = n('div', 'gc-scroll'), cuerpo = n('div', 'gc-fila gc-horas');
    var gutter = n('div', 'gc-gutter');
    for (var h = 0; h < 24; h++) gutter.appendChild(n('span', 'gc-hora', h ? pad(h) + ':00' : ''));
    cuerpo.appendChild(gutter);
    dias.forEach(function (dia) {
      var col = n('div', 'gc-col' + (dia === hoy() ? ' es-hoy' : ''));
      col.style.height = (24 * HORA_PX) + 'px';
      col.title = 'Clic para crear un evento';
      col.addEventListener('click', function (e) {
        if (e.target !== col) return;
        var y = e.offsetY, min = Math.max(0, Math.min(23 * 60 + 30, Math.floor(y / HORA_PX * 2) * 30));
        abrirDialogo(null, { fecha: dia, hora: min });
      });
      distribuir(porDia[dia], dia).forEach(function (it) {
        var b = chipEvento(it.ev, 'gc-bloque' + (it.fin - it.ini < 50 ? ' gc-corto' : ''));
        b.style.top = (it.ini / 60 * HORA_PX) + 'px';
        b.style.height = Math.max(18, (it.fin - it.ini) / 60 * HORA_PX - 2) + 'px';
        b.style.left = 'calc(' + (100 * it.col / it.cols) + '% + 2px)';
        b.style.width = 'calc(' + (100 / it.cols) + '% - 4px)';
        var t = tiempos(it.ev);
        b.title = titulo(it.ev) + '\n' + hhmm(t.ini) + ' – ' + hhmm(t.fin) + (it.ev.location ? '\n' + it.ev.location : '');
        col.appendChild(b);
      });
      if (dia === hoy()) {
        var ahora = new Date(), linea = n('div', 'gc-ahora');
        linea.style.top = ((ahora.getHours() * 60 + ahora.getMinutes()) / 60 * HORA_PX) + 'px';
        col.appendChild(linea);
      }
      cuerpo.appendChild(col);
    });
    scroll.appendChild(cuerpo);
    marco.appendChild(scroll);
    ui.cuerpo.appendChild(marco);
    scroll.scrollTop = arriba != null ? arriba : 7 * HORA_PX;
  }

  function pintarMes() {
    var r = rango('mes', ancla), mesRef = ancla.slice(0, 7), tareas = vencimientos();
    var grid = n('div', 'gc-mes');
    ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].forEach(function (x) { grid.appendChild(n('div', 'gc-mes-nom', x)); });
    for (var i = 0; i < 42; i++) {
      var dia = mas(r.desde, i);
      var cel = n('div', 'gc-mes-dia' + (dia.slice(0, 7) !== mesRef ? ' fuera' : '') + (dia === hoy() ? ' es-hoy' : ''));
      var num = boton(String(aFecha(dia).getDate()), (function (f) { return function () { ancla = f; cambiarVista('dia'); }; })(dia), 'gc-mes-num');
      num.title = 'Ver el día';
      cel.appendChild(num);
      var items = eventos.filter(function (ev) { return tocaDia(tiempos(ev), dia); })
        .sort(function (a, b) { var x = tiempos(a), y = tiempos(b); return (y.todoDia - x.todoDia) || (x.ini - y.ini); })
        .map(function (ev) { return chipEvento(ev); })
        .concat(tareas.filter(function (t) { return t.fecha === dia; }).map(chipTarea));
      items.slice(0, 3).forEach(function (c) { cel.appendChild(c); });
      if (items.length > 3) cel.appendChild(boton('+' + (items.length - 3) + ' más', (function (f) { return function (e) { e.stopPropagation(); ancla = f; cambiarVista('dia'); }; })(dia), 'gc-mas'));
      cel.addEventListener('click', (function (f) { return function (e) {
        if (e.target === e.currentTarget) abrirDialogo(null, { fecha: f, hora: 9 * 60 });
      }; })(dia));
      grid.appendChild(cel);
    }
    ui.cuerpo.appendChild(grid);
  }

  // ---------- diálogo crear / editar ----------
  function campo(etq, input) { var l = n('label', 'gc-campo'); l.append(n('span', null, etq), input); return l; }
  function entrada(tipo) { var i = n('input'); i.type = tipo; return i; }

  function construirDialogo() {
    if (dialogo) dialogo.remove();
    dialogo = n('dialog', 'gc-dialogo'); dialogo.setAttribute('aria-labelledby', 'gc-dlg-t');
    var f = n('form'); f.method = 'dialog';
    ui.dTitulo = n('h3', null, 'Nuevo evento'); ui.dTitulo.id = 'gc-dlg-t';
    ui.fResumen = entrada('text'); ui.fResumen.required = true; ui.fResumen.maxLength = 300; ui.fResumen.placeholder = 'Añade un título';
    ui.fFecha = entrada('date'); ui.fFecha.required = true;
    ui.fFechaFin = entrada('date');
    ui.fTodo = entrada('checkbox');
    ui.fIni = entrada('time'); ui.fIni.step = 300;
    ui.fFin = entrada('time'); ui.fFin.step = 300;
    ui.fLugar = entrada('text'); ui.fLugar.maxLength = 300;
    ui.fDesc = n('textarea'); ui.fDesc.rows = 3;
    var todo = n('label', 'gc-check'); todo.append(ui.fTodo, document.createTextNode(' Todo el día'));
    ui.horas = n('div', 'gc-dos'); ui.horas.append(campo('Empieza', ui.fIni), campo('Termina', ui.fFin));
    ui.finDia = campo('Hasta el día', ui.fFechaFin);
    ui.fTodo.addEventListener('change', alternarTodoDia);
    ui.fIni.addEventListener('change', function () {
      var a = minutos(ui.fIni.value), b = minutos(ui.fFin.value);
      if (a != null && (b == null || b <= a)) ui.fFin.value = reloj(Math.min(a + 60, 23 * 60 + 59));
    });
    ui.dEstado = n('p', 'gc-dlg-estado'); ui.dEstado.setAttribute('role', 'status');
    ui.dNota = n('p', 'gc-nota');
    ui.dEnlace = n('a', 'btn-ghost', 'Abrir en Google Calendar'); ui.dEnlace.target = '_blank'; ui.dEnlace.rel = 'noopener noreferrer';
    var acciones = n('div', 'gc-acciones');
    ui.dBorrar = boton('Eliminar', borrar, 'btn gc-borrar');
    ui.dCancelar = boton('Cancelar', function () { dialogo.close(); }, 'btn');
    ui.dGuardar = n('button', 'btn-primary', 'Guardar'); ui.dGuardar.type = 'submit';
    acciones.append(ui.dBorrar, ui.dEnlace, n('span', 'gc-hueco'), ui.dCancelar, ui.dGuardar);
    f.append(ui.dTitulo, campo('Título', ui.fResumen), campo('Fecha', ui.fFecha), todo, ui.horas, ui.finDia,
      campo('Ubicación', ui.fLugar), campo('Descripción', ui.fDesc), ui.dNota, ui.dEstado, acciones);
    f.addEventListener('submit', function (e) { e.preventDefault(); guardar(); });
    dialogo.appendChild(f);
    document.body.appendChild(dialogo);
  }

  function minutos(v) { if (!/^\d{2}:\d{2}$/.test(v || '')) return null; var p = v.split(':').map(Number); return p[0] * 60 + p[1]; }
  function reloj(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function alternarTodoDia() { ui.horas.hidden = ui.fTodo.checked; ui.finDia.hidden = !ui.fTodo.checked; }

  function abrirDialogo(ev, preset) {
    if (!mcp()) { if (api.toast) api.toast('Conecta Google para usar el calendario.'); return; }
    editando = ev || null;
    var puede = !ev || editable(ev), t = ev ? tiempos(ev) : null;
    ui.dTitulo.textContent = ev ? (puede ? 'Editar evento' : 'Evento') : 'Nuevo evento';
    ui.dEstado.textContent = '';
    if (ev) {
      ui.fResumen.value = ev.summary || '';
      ui.fFecha.value = iso(t.ini);
      ui.fTodo.checked = t.todoDia;
      ui.fFechaFin.value = t.todoDia ? iso(new Date(t.fin.getTime() - 86400000)) : iso(t.ini);
      ui.fIni.value = t.todoDia ? '09:00' : hhmm(t.ini);
      ui.fFin.value = t.todoDia ? '10:00' : hhmm(t.fin);
      ui.fLugar.value = ev.location || '';
      ui.fDesc.value = ev.description || '';
    } else {
      var p = preset || {}, h = p.hora != null ? p.hora : 9 * 60;
      ui.fResumen.value = ''; ui.fLugar.value = ''; ui.fDesc.value = '';
      ui.fFecha.value = p.fecha || hoy(); ui.fFechaFin.value = p.fecha || hoy();
      ui.fTodo.checked = !!p.todoDia;
      ui.fIni.value = reloj(h); ui.fFin.value = reloj(Math.min(h + 60, 23 * 60 + 59));
    }
    var notas = [];
    if (ev && ev.recurringEventId) notas.push('Evento repetido: los cambios afectan solo a esta fecha.');
    if (ev && !puede) notas.push('Lo organiza otra persona: ábrelo en Google Calendar para responder o cambiarlo.');
    if (ev && !t.todoDia && t.fin > t.ini && iso(new Date(t.fin.getTime() - 1)) !== iso(t.ini)) {
      notas.push('Este evento dura varios días; edítalo en Google Calendar para no recortarlo.'); puede = false;
    }
    ui.dNota.textContent = notas.join(' ');
    ui.dNota.hidden = !notas.length;
    [ui.fResumen, ui.fFecha, ui.fFechaFin, ui.fTodo, ui.fIni, ui.fFin, ui.fLugar, ui.fDesc].forEach(function (x) { x.disabled = !puede; });
    ui.dGuardar.hidden = !puede; ui.dBorrar.hidden = !ev || !puede;
    ui.dEnlace.hidden = !(ev && ev.htmlLink); if (ev && ev.htmlLink) ui.dEnlace.href = ev.htmlLink;
    alternarTodoDia();
    dialogo.showModal();
    if (puede) ui.fResumen.focus();
  }

  function datosFormulario() {
    var resumen = ui.fResumen.value.trim(), fecha = ui.fFecha.value;
    if (!resumen) throw new Error('Escribe un título.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('Elige una fecha.');
    var i = { summary: resumen, description: ui.fDesc.value, location: ui.fLugar.value.trim(), timeZone: api.timeZone };
    if (ui.fTodo.checked) {
      var hasta = ui.fFechaFin.value || fecha;
      if (hasta < fecha) throw new Error('El último día no puede ser anterior al primero.');
      i.allDay = true; i.startTime = fecha; i.endTime = mas(hasta, 1);
    } else {
      var a = minutos(ui.fIni.value), b = minutos(ui.fFin.value);
      if (a == null || b == null) throw new Error('Indica la hora de inicio y de fin.');
      if (b === 0 && a > 0) b = 24 * 60;   // 00:00 como fin = medianoche siguiente
      if (b <= a) throw new Error('La hora de fin debe ser posterior a la de inicio.');
      i.allDay = false;
      // setHours respeta los cambios de horario del día elegido.
      var ini = aFecha(fecha); ini.setHours(Math.floor(a / 60), a % 60); i.startTime = ini.toISOString();
      var fin = aFecha(fecha); fin.setHours(Math.floor(b / 60), b % 60); i.endTime = fin.toISOString();
    }
    return i;
  }

  async function ejecutar(fn, exito) {
    if (guardando) return;
    guardando = true; ui.dGuardar.disabled = true; ui.dBorrar.disabled = true;
    try { await fn(); dialogo.close(); if (api.toast) api.toast(exito); await cargar(true); }
    catch (e) { ui.dEstado.textContent = e && e.code ? msgError(e).replace('leer', 'actualizar') : (e && e.message) || 'No se pudo guardar.'; }
    finally { guardando = false; ui.dGuardar.disabled = false; ui.dBorrar.disabled = false; }
  }

  function guardar() {
    var datos;
    try { datos = datosFormulario(); } catch (e) { ui.dEstado.textContent = e.message; return; }
    var m = mcp(); if (!m) { ui.dEstado.textContent = 'Conecta Google primero.'; return; }
    var ev = editando;
    ejecutar(function () {
      if (ev) return m.callTool(CAL, 'update_event', Object.assign({ eventId: ev.id }, datos));
      return m.callTool(CAL, 'create_event', datos);
    }, ev ? 'Evento actualizado en Google Calendar' : 'Evento creado en Google Calendar');
  }

  function borrar() {
    var ev = editando, m = mcp(); if (!ev || !m) return;
    if (!global.confirm('¿Eliminar «' + titulo(ev) + '» de Google Calendar?')) return;
    ejecutar(function () { return m.callTool(CAL, 'delete_event', { eventId: ev.id }); }, 'Evento eliminado de Google Calendar');
  }

  // ---------- API pública ----------
  global.FicheroCalendar = {
    mount: function (opts) {
      api = opts; root = opts.root;
      var guardada = null; try { guardada = localStorage.getItem(LS_VISTA); } catch (e) {}
      vista = ['dia', 'semana', 'mes'].indexOf(guardada) >= 0 ? guardada
        : (global.matchMedia && global.matchMedia('(max-width:820px)').matches ? 'dia' : 'semana');
      ancla = hoy();
      construir();
      document.addEventListener('visibilitychange', function () { if (visible && !document.hidden) cargar(true); });
      global.addEventListener('focus', function () { if (visible && Date.now() - sello > 15000) cargar(true); });
    },
    show: function (si) {
      visible = !!si; programar();
      if (visible) { if (!sello || Date.now() - sello > 15000) cargar(); else pintar(); }
    },
    // Llamar cuando cambia la conexión con Google o las fichas.
    refresh: function () { if (!visible) return; if (mcp() && !sello) cargar(); else pintar(); },
    _test: { distribuir: distribuir, tiempos: tiempos, tocaDia: tocaDia, rango: rango, editable: editable, lunes: lunes, mas: mas }
  };
})(typeof window !== 'undefined' ? window : globalThis);
