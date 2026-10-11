"""Prueba de navegador aislada: nunca usa Firebase ni un Calendar real.

Ejecutar con webapp-testing/scripts/with_server.py y un servidor en el puerto 8765.
"""
import json
import zipfile
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-results"
OUT.mkdir(exist_ok=True)
NOW = datetime(2026, 10, 8, 15, 0, tzinfo=timezone.utc)
MS = int(NOW.timestamp() * 1000)


def task(key, title, **kw):
    value = dict(id=key, titulo=title, proyecto="Economía aplicada", estado="pendiente",
                 prioridad="media", creado=MS - 86400000, msEnCurso=0, cursoDesde=0,
                 completado=0, estimadoMin=60, orden=0, sesiones=[])
    value.update(kw)
    return value


def fixture():
    start = MS - 40 * 60000
    session = dict(id="done-session", tareaId="done", titulo="Informe terminado",
                   proyecto="Economía aplicada", inicio=MS - 4 * 3600000,
                   fin=MS - 3 * 3600000, duracionMs=3600000, estimadoMin=60,
                   eventoId="closed-event", eventoLink="https://calendar.google.com/calendar/event?eid=test",
                   calendarEstado="sincronizado", calendarError="")
    ts = [task("pending", "Revisar bibliografía", fechaHacer="2026-10-08"),
          task("active", "Limpiar microdatos", estado="curso", cursoDesde=start,
               iniciado=start, tramoId="active-event", tramoInicio=start),
          task("done", "Informe terminado", estado="hecho", completado=MS - 2 * 3600000,
               msEnCurso=3600000, sesiones=[session]),
          task("old", "Histórico sin sesiones", estado="hecho", completado=MS - 8 * 86400000,
               msEnCurso=5400000)]
    data = {"tareas/" + t["id"]: t for t in ts}
    data["config/preferencias"] = {"registrarTiempo": True}
    return data


def overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "Desbordamiento horizontal"


def shot(page, name):
    page.evaluate('scrollTo(0,0)')
    page.screenshot(path=str(OUT / name), full_page=True, animations='disabled')


def kanban_drag_regression(browser, route_request, url):
    """Arrastre nativo con ratón, en un almacén separado del resto del smoke."""
    data = {"config/preferencias": {"registrarTiempo": False}}
    for i in range(8):
        value = task("drag-%d" % i, "Ficha larga %d" % i, orden=i * 20)
        data["tareas/" + value["id"]] = value
    data["tareas/drag-parent"] = task("drag-parent", "Padre pendiente", orden=-20)
    data["tareas/drag-sub-a"] = task("drag-sub-a", "Primera subtarea", padre="drag-parent", orden=0)
    data["tareas/drag-sub-b"] = task("drag-sub-b", "Segunda subtarea", padre="drag-parent", orden=20)
    data["tareas/drag-course"] = task("drag-course", "Destino en curso", estado="curso", pausada=True)
    data["tareas/drag-done"] = task("drag-done", "Destino hecho", estado="hecho", completado=MS)
    context = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="America/Lima")
    context.route("**/*", route_request)
    context.add_init_script("localStorage.setItem('fichero-tareas:v1',JSON.stringify(%s));" % json.dumps(data))
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.clock.install(time=NOW)
    try:
        page.goto(url, wait_until="networkidle")
        expect(page.locator('#s-pendiente > .card')).to_have_count(9)
        heights = page.locator('#board > .col').evaluate_all('(cols)=>cols.map(c=>c.getBoundingClientRect().height)')
        assert max(heights) - min(heights) <= 1, heights
        overflow(page)
        shot(page, 'kanban-aligned-1280.png')

        # Mover horizontalmente una ficha baja: cabeceras fuera de pantalla,
        # destino por debajo de la última tarjeta de la columna vecina.
        source = page.locator('.card[data-id="drag-7"]')
        source.evaluate('(el)=>scrollTo(0,scrollY+el.getBoundingClientRect().top-400)')
        box = source.bounding_box()
        dest = page.locator('.col[data-col="curso"]').bounding_box()
        y = box['y'] + 35
        x = dest['x'] + dest['width'] / 2
        assert page.locator('.col[data-col="curso"] .col-head').bounding_box()['y'] < 0
        assert page.locator('.card[data-id="drag-course"]').bounding_box()['y'] < y
        assert page.evaluate('(p)=>document.elementFromPoint(p.x,p.y).closest(".col").dataset.col', {'x': x, 'y': y}) == 'curso'
        page.mouse.move(box['x'] + 30, y)
        page.mouse.down()
        page.mouse.move(box['x'] + 45, y, steps=5)
        page.mouse.move(x, y, steps=20)
        page.mouse.move(x + 1, y)
        expect(page.locator('.col[data-col="curso"]')).to_have_class('col recibe')
        page.mouse.up()
        expect(page.locator('#s-curso .card[data-id="drag-7"]')).to_have_count(1)

        # El centro de otra tarjeta en otra columna cambia estado, sin anidar.
        source.drag_to(page.locator('.card[data-id="drag-done"]'), source_position={'x': 20, 'y': 20})
        expect(page.locator('#s-hecho .card[data-id="drag-7"]')).to_have_count(1)
        moved = page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/drag-7']")
        assert moved['estado'] == 'hecho' and not moved.get('padre'), moved
        source.drag_to(page.locator('.card[data-id="drag-course"]'), source_position={'x': 20, 'y': 20})
        expect(page.locator('#s-curso .card[data-id="drag-7"]')).to_have_count(1)

        # El anidado de fichas principales en la misma columna sigue disponible.
        page.locator('.card[data-id="drag-0"]').drag_to(page.locator('.card[data-id="drag-1"]'), source_position={'x': 20, 'y': 20})
        page.wait_for_function("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/drag-0'].padre==='drag-1'")

        # Las subtareas reordenan su lista y pueden cambiar de padre entre columnas.
        page.locator('.card[data-id="drag-parent"] .desplegar').click()
        page.locator('.card[data-id="drag-parent"]').evaluate('(el)=>scrollTo(0,scrollY+el.getBoundingClientRect().top-200)')
        # Eventos de subtarea aislados: el arrastre nativo de fichas ya se probó arriba.
        page.evaluate("""()=>{const source=document.querySelector('.sub[data-sub="drag-sub-b"]');
          const target=document.querySelector('.sub[data-sub="drag-sub-a"]'),r=target.getBoundingClientRect(),dt=new DataTransfer();
          source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
          for(const type of ['dragover','drop']) target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:r.top+3}));
          source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));}""")
        page.wait_for_function("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/drag-sub-b'].orden < JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/drag-sub-a'].orden")
        expect(page.locator('.card[data-id="drag-parent"] .sub').first).to_have_attribute('data-sub', 'drag-sub-b')
        page.evaluate("""()=>{const source=document.querySelector('.sub[data-sub="drag-sub-b"]');
          const target=document.querySelector('.card[data-id="drag-course"]'),r=target.getBoundingClientRect(),dt=new DataTransfer();
          source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
          for(const type of ['dragover','drop']) target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:r.top+r.height/2}));
          source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));}""")
        page.wait_for_function("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/drag-sub-b'].padre==='drag-course'")
        assert page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/drag-parent'].estado") == 'pendiente'

        # El breakpoint móvil mantiene una sola columna y las pestañas segmentadas.
        page.set_viewport_size({'width': 390, 'height': 844})
        for col in ('pendiente', 'curso', 'hecho'):
            page.locator('#kanban-tabs [data-mobile-col="%s"]' % col).click()
            expect(page.locator('#board > .col:visible')).to_have_count(1)
            expect(page.locator('#board > .col:visible')).to_have_attribute('data-col', col)
            overflow(page)
        shot(page, 'kanban-mobile-390.png')
        assert not errors, errors
        print('OK: arrastre horizontal inferior, sobre tarjeta, anidado, subtareas y pestañas móviles.')
    finally:
        context.close()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, timeout=20000)
    context = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="America/Lima",
                                  locale="es-PE", accept_downloads=True, color_scheme="light")
    errors = []
    calls = []
    fail = {"close": False}
    hold = {"next": False, "route": None, "payload": None, "headers": None}

    def route_request(route):
        req = route.request
        parsed = urlparse(req.url)
        if parsed.path.endswith("firebase-config.js"):
            return route.fulfill(content_type="text/javascript", body="window.FIREBASE_CONFIG=null;window.GOOGLE_CLIENT_ID='test';")
        if parsed.hostname == "www.googleapis.com":
            headers = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"}
            if req.method == "OPTIONS":
                return route.fulfill(status=204, headers=headers)
            payload = json.loads(req.post_data or "{}")
            calls.append((req.method, parsed.path, payload))
            if req.method == "POST" and payload.get("summary", "").startswith("⏱ ") and hold["next"]:
                hold.update(next=False, route=route, payload=payload, headers=headers)
                return
            if req.method == "PATCH" and parsed.path.endswith("active-event") and fail["close"]:
                fail["close"] = False
                return route.fulfill(status=503, headers=headers, json={"error": {"message": "Fallo de red simulado"}})
            if req.method == "DELETE":
                return route.fulfill(status=204, headers=headers)
            if req.method == "GET":
                return route.fulfill(headers=headers, json={"items": [], "files": []})
            return route.fulfill(headers=headers, json={"id": payload.get("id") or parsed.path.rsplit("/", 1)[-1],
                                                       "htmlLink": "https://calendar.google.com/calendar/event?eid=test", **payload})
        if parsed.hostname not in ("localhost", "127.0.0.1"):
            if parsed.hostname == "cdnjs.cloudflare.com":
                return route.continue_()  # Bibliotecas ya usadas por el proyecto.
            return route.fulfill(body="", content_type="text/css" if "fonts" in req.url else "text/javascript")
        return route.continue_()

    context.route("**/*", route_request)
    kanban_drag_regression(browser, route_request, sys.argv[1] if len(sys.argv)>1 else "http://127.0.0.1:8765")
    context.add_init_script("""if(!localStorage.getItem('__fixture-seeded')){
      localStorage.clear();localStorage.setItem('__fixture-seeded','1');
      localStorage.setItem('fichero-tareas:v1',JSON.stringify(%s));
      localStorage.setItem('fichero-tareas:gtoken',JSON.stringify({tk:'test',exp:%d}));
      localStorage.setItem('fichero-tema','light');
    }""" % (json.dumps(fixture()), MS + 86400000))
    page = context.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.clock.install(time=NOW)
    page.goto(sys.argv[1] if len(sys.argv)>1 else "http://127.0.0.1:8765", wait_until="networkidle", timeout=60000)
    expect(page.locator("#sub")).to_contain_text("tareas abiertas")
    expect(page.locator("#s-hecho .card")).to_have_count(1)
    expect(page.locator("#archive-summary")).to_contain_text("1")
    overflow(page)
    shot(page, 'desktop-1280.png')

    # Captura persistente: texto literal, proyecto y estimación.
    page.locator("#quick-title").fill("<b>Tarea de prueba</b>")
    page.locator("#quick-project").fill("Tesis")
    page.locator("#quick-estimate").select_option("90")
    page.locator("#quick-title").press("Enter")
    expect(page.locator("#s-pendiente .title", has_text="<b>Tarea de prueba</b>")).to_have_count(1)
    saved = page.evaluate("Object.values(JSON.parse(localStorage.getItem('fichero-tareas:v1'))).find(t=>t.titulo==='<b>Tarea de prueba</b>')")
    assert saved["estimadoMin"] == 90 and saved["proyecto"] == "Tesis"

    # Pausa persiste un bloque y no sigue sumando; fallo Calendar visible y recuperable.
    fail["close"] = True
    active = page.locator('.card[data-id="active"]')
    active.get_by_role("button", name="Pausar").click()
    expect(active.get_by_role("button", name="Reanudar")).to_be_visible()
    page.wait_for_function("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active'].sesiones[0].calendarEstado==='error'")
    paused = page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active']")
    page.clock.fast_forward(120000)
    again = page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active']")
    assert paused["msEnCurso"] == again["msEnCurso"] and again["cursoDesde"] == 0
    assert len(again["sesiones"]) == 1 and again["sesiones"][0]["duracionMs"] >= 40 * 60000
    active.get_by_role("button", name="Reanudar").click()
    page.clock.fast_forward(240000)
    active.get_by_role("button", name="Finalizar").click()
    expect(page.locator('#s-hecho .card[data-id="active"]')).to_be_visible()
    finished = page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active']")
    assert finished["estado"] == "hecho" and finished["cursoDesde"] == 0 and len(finished["sesiones"]) == 2
    assert all(s["fin"] >= s["inicio"] for s in finished["sesiones"])

    # Archivo reversible: el documento y exportaciones conservan tareas.
    page.locator("#archive-today").click()
    expect(page.locator("#s-hecho .card")).to_have_count(0)
    page.locator("#done-archive summary").click()
    expect(page.locator("#archive-stack .card")).to_have_count(3)
    page.locator("#archive-today").click()
    expect(page.locator("#s-hecho .card")).to_have_count(2)
    assert page.evaluate("Object.keys(JSON.parse(localStorage.getItem('fichero-tareas:v1'))).filter(k=>k.startsWith('tareas/')).length") == 5

    # Vista de analítica: datos reales, historial y reintento explícito.
    page.locator('.desktop-sidebar [data-workspace="analitica"]').click()
    expect(page.locator("#workspace-insights")).to_be_visible()
    expect(page.locator('.fi-projects')).to_contain_text('Dato histórico sin fecha: 1 h 30 min')
    page.locator('[data-action="retry"]').click()
    page.wait_for_function("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active'].sesiones[0].calendarEstado==='sincronizado'")
    assert len(page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active'].sesiones")) == 2
    for kind in ('csv', 'xlsx', 'pdf'):
        with page.expect_download() as info:
            page.locator('[data-action="%s"]' % kind).click()
        download = info.value
        dest = OUT / ('sessions.' + kind)
        download.save_as(str(dest))
        assert dest.stat().st_size > 100
        if kind == 'csv':
            csv = dest.read_text(encoding='utf-8-sig')
            assert 'Limpiar microdatos' in csv and 'Duración bloque (ms)' in csv
        elif kind == 'xlsx':
            with zipfile.ZipFile(dest) as book:
                assert 'xl/worksheets/sheet1.xml' in book.namelist()
        else:
            assert dest.read_bytes().startswith(b'%PDF')
    overflow(page)
    shot(page, 'analytics-1280.png')

    # Plantillas reales: crear, editar, usar, eliminar; planificar conserva el borrador.
    page.locator('.desktop-sidebar [data-workspace="plan"]').click()
    page.get_by_label('Título de la tarea', exact=True).fill('Lectura recurrente')
    page.locator('.fi-template-form').get_by_label('Proyecto', exact=True).fill('Tesis')
    page.get_by_label('Duración estimada (minutos)', exact=True).fill('45')
    page.get_by_role('button', name='Guardar plantilla', exact=True).click()
    expect(page.locator('.fi-template-list h4')).to_have_text('Lectura recurrente')
    page.locator('[data-action="edit-template"]').click()
    page.get_by_label('Duración estimada (minutos)', exact=True).fill('60')
    page.get_by_role('button', name='Guardar plantilla', exact=True).click()
    page.wait_for_function("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['config/plantillas'].items[0].estimadoMin===60")
    page.get_by_label('Día para asignar tareas y usar plantillas', exact=True).fill('2026-10-09')
    page.locator('[data-action="use-template"]').click()
    page.wait_for_function("Object.values(JSON.parse(localStorage.getItem('fichero-tareas:v1'))).some(t=>t.titulo==='Lectura recurrente' && t.fechaHacer==='2026-10-09')")
    row = page.locator('.fi-task', has=page.get_by_role('button', name='<b>Tarea de prueba</b>', exact=True))
    row.locator('input[type="date"]').fill('2026-10-10')
    row.get_by_role('button', name='Asignar día', exact=True).click()
    page.wait_for_function("Object.values(JSON.parse(localStorage.getItem('fichero-tareas:v1'))).some(t=>t.titulo==='<b>Tarea de prueba</b>' && t.fechaHacer==='2026-10-10')")
    page.get_by_label('Título de la tarea', exact=True).fill('Borrador conservado')
    page.evaluate('window.FicheroInsights.refresh()')
    expect(page.get_by_label('Título de la tarea', exact=True)).to_have_value('Borrador conservado')
    page.locator('[data-action="delete-template"]').click()
    expect(page.locator('.fi-template-list h4')).to_have_count(0)
    overflow(page)
    shot(page, 'plan-1280.png')

    # Respuesta lenta de Calendar después de pausar/reanudar: enlazar cada bloque correcto.
    page.locator('.desktop-sidebar [data-workspace="tablero"]').click()
    hold['next'] = True
    page.locator('#spontaneous-task').click()
    page.locator('#quick-title').fill('Sesión con conexión lenta')
    page.locator('#quick-title').press('Enter')
    slow = page.locator('.card', has=page.locator('.title', has_text='Sesión con conexión lenta'))
    expect(slow.get_by_role('button', name='Pausar')).to_be_visible()
    page.wait_for_timeout(100)
    assert hold['route'] is not None
    page.clock.fast_forward(60000)
    slow.get_by_role('button', name='Pausar').click()
    page.clock.fast_forward(1000)
    slow.get_by_role('button', name='Reanudar').click()
    payload = hold['payload']
    hold['route'].fulfill(headers=hold['headers'], json={'id': payload['id'], 'htmlLink': 'https://calendar.google.com/calendar/event?eid=slow', **payload})
    page.wait_for_function("Object.values(JSON.parse(localStorage.getItem('fichero-tareas:v1'))).some(t=>t.titulo==='Sesión con conexión lenta' && t.tramoId && t.sesiones[0].calendarEstado==='breve')")
    slow_data = page.evaluate("Object.values(JSON.parse(localStorage.getItem('fichero-tareas:v1'))).find(t=>t.titulo==='Sesión con conexión lenta')")
    assert slow_data['tramoInicio'] > slow_data['sesiones'][0]['inicio']
    slow.get_by_role('button', name='Pausar').click()

    # Volver a cargar conserva captura, sesiones y estado.
    page.reload(wait_until="networkidle")
    expect(page.locator("#s-hecho .card")).to_have_count(2)
    check = page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active']")
    assert len(check["sesiones"]) == 2
    assert not errors, errors

    # Teléfono: siguen funcionando pestañas, barra inferior y captura.
    page.set_viewport_size({"width": 390, "height": 844})
    page.locator('#kanban-tabs [data-mobile-col="pendiente"]').click()
    expect(page.locator('.col[data-col="pendiente"]')).to_be_visible()
    expect(page.locator('.col[data-col="curso"]')).not_to_be_visible()
    expect(page.locator(".mobile-nav")).to_be_visible()
    overflow(page)
    shot(page, 'mobile-390.png')
    page.locator('.workspace-shortcuts [data-workspace="analitica"]').click()
    overflow(page)
    shot(page, 'analytics-390.png')
    page.locator("#mob-tablero").click()
    expect(page.locator("#board")).to_be_visible()
    page.set_viewport_size({'width': 1280, 'height': 900})
    # Corregir el inicio y terminar desde el mismo formulario; luego recortar el fin.
    done = page.locator('#s-hecho .card[data-id="active"]')
    done.get_by_role('button', name='Reabrir tarea', exact=True).click()
    pending = page.locator('#s-pendiente .card[data-id="active"]')
    pending.get_by_role('button', name='Empezar', exact=False).click()
    page.clock.fast_forward(25 * 60000)
    page.locator('#s-curso .card[data-id="active"] .title').click()
    start_text = page.evaluate("new Date(Date.now()-35*60000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})")
    page.locator('#f-inicio').fill(start_text)
    page.locator('#f-estado').select_option('hecho')
    page.locator('#f-guardar').click()
    expect(page.locator('#cierre')).to_be_visible()
    end_text = page.evaluate("new Date(Date.now()-5*60000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})")
    page.locator('#cierre input[type="time"]').fill(end_text)
    page.locator('#cierre').get_by_role('button', name='Fue a esa hora').click()
    page.wait_for_function("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active'].sesiones.at(-1).calendarEstado==='sincronizado'")
    corrected = page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/active']")
    last = corrected['sesiones'][-1]
    assert last['duracionMs'] == 30 * 60000, last
    assert last['id'] == 'active-' + str(last['inicio'])
    updates = [data for method, path, data in calls if method == 'PATCH' and path.endswith(last['eventoId']) and 'end' in data]
    assert updates and int(datetime.fromisoformat(updates[-1]['end']['dateTime']).timestamp()*1000) == last['fin']
    page.locator('#tema').click()
    overflow(page)
    shot(page, 'desktop-dark-1280.png')
    page.set_viewport_size({'width': 900, 'height': 900})
    overflow(page)
    # Conexión desconectada: también cabe el botón adicional de autorización.
    page.evaluate("localStorage.removeItem('fichero-tareas:gtoken')")
    page.reload(wait_until='networkidle')
    expect(page.locator('#conectar-google')).to_be_visible()
    overflow(page)
    shot(page, 'desktop-900.png')
    assert not errors, errors
    print("OK: captura, pausa/reanudación, sesiones, cierre, archivo, recarga, navegación móvil y tamaños 1280/390.")
    print("Peticiones Calendar simuladas:", len(calls))
    print("Capturas:", OUT)
    context.close()
    browser.close()
