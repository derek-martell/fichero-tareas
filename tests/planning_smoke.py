"""Plan diario aislado: Firebase, Google y todos los correos son simulados."""
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

OUT = Path(__file__).resolve().parents[1] / 'test-results'
OUT.mkdir(exist_ok=True)
NOW = datetime(2026, 10, 10, 22, 0, tzinfo=timezone.utc)  # 17:00 Lima
MS = int(NOW.timestamp() * 1000)
data = {
    'config/preferencias': {'registrarTiempo': False},
    **{'tareas/' + key: dict(id=key, titulo=title, proyecto='Tesis', prioridad=priority,
                           fecha=deadline, estado='pendiente', creado=MS, orden=i,
                           estimadoMin=30, msEnCurso=0, cursoDesde=0, sesiones=[])
       for i, (key, title, priority, deadline) in enumerate([
           ('a', 'Leer <b>sin HTML</b>', 'media', '2026-10-12'),
           ('b', 'Terminar informe', 'alta', '2026-10-11')])}
}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 900}, timezone_id='Europe/Madrid')
    calls, errors = [], []
    def route_request(route):
        parsed = urlparse(route.request.url)
        if parsed.path.endswith('firebase-config.js'):
            return route.fulfill(body="window.FIREBASE_CONFIG=null;window.GOOGLE_CLIENT_ID='test';", content_type='text/javascript')
        if parsed.hostname == 'www.googleapis.com':
            headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'}
            if route.request.method == 'OPTIONS': return route.fulfill(status=204, headers=headers)
            payload = json.loads(route.request.post_data or '{}')
            calls.append((route.request.method, parsed.path, payload))
            if route.request.method == 'DELETE': return route.fulfill(status=204, headers=headers)
            if route.request.method == 'GET':
                if parsed.path.endswith('/instances'):
                    series = parsed.path.split('/')[-2]
                    start = parse_qs(parsed.query)['timeMin'][0]
                    return route.fulfill(headers=headers, json={'items': [
                        {'id': series + '_today', 'recurringEventId': series, 'start': {'dateTime': start}},
                        {'id': 'foreign', 'recurringEventId': 'foreign', 'start': {'dateTime': start}},
                        {'id': series + '_tomorrow', 'recurringEventId': series, 'start': {'dateTime': '2026-10-11T20:00:00-05:00'}}]})
                return route.fulfill(headers=headers, json={'items': [], 'files': []})
            return route.fulfill(headers=headers, json={**payload, 'id': payload.get('id', 'mock-event')})
        if parsed.hostname not in ('127.0.0.1', 'localhost'):
            return route.fulfill(body='', content_type='text/javascript')
        return route.continue_()
    context.route('**/*', route_request)
    context.add_init_script("""if(!localStorage.getItem('__seed')){
      localStorage.setItem('__seed','1');localStorage.setItem('fichero-tareas:v1',JSON.stringify(%s));
      localStorage.setItem('fichero-tareas:gtoken',JSON.stringify({tk:'test',exp:%d}));
    }""" % (json.dumps(data), MS + 86400000))
    page = context.new_page()
    page.clock.install(time=NOW)
    page.on('pageerror', lambda e: errors.append(str(e)))
    base = sys.argv[1]
    page.goto(base, wait_until='networkidle')
    expect(page.get_by_role('button', name='Preparar mañana')).to_be_enabled()
    page.get_by_role('button', name='Preparar mañana').click()
    dialog = page.locator('.dp-dialog')
    expect(dialog).to_be_visible()
    expect(dialog.locator('#dp-title')).to_contain_text('2026-10-11')
    dialog.locator('.dp-candidate').filter(has_text='Leer <b>sin HTML</b>').get_by_role('button').click()
    dialog.locator('.dp-candidate').filter(has_text='Terminar informe').get_by_role('button').click()
    expect(dialog.locator('.dp-item b')).to_have_count(0)
    expect(dialog.locator('.dp-item').first).to_contain_text('Leer <b>sin HTML</b>')
    dialog.get_by_role('button', name='Sugerir orden: vencimiento y prioridad').click()
    expect(dialog.locator('.dp-item').first).to_contain_text('Terminar informe')
    dialog.get_by_role('button', name='Subir Leer <b>sin HTML</b>', exact=True).click()
    expect(dialog.locator('.dp-item').first).to_contain_text('Leer <b>sin HTML</b>')
    dialog.get_by_role('button', name='Guardar mi plan', exact=True).click()
    expect(dialog).not_to_be_visible()
    saved = page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['config/plan-2026-10-11']")
    assert saved['orden'] == ['a', 'b'] and saved['estado'] == 'guardado'
    assert not any(method == 'POST' for method, _, _ in calls), 'No crear correos sin activación'
    page.locator('.dp-settings summary').click()
    page.get_by_role('button', name='Activar correos con Google Calendar').click()
    expect(page.locator('.dp-status').first).to_contain_text('Recordatorios configurados')
    posts = [payload for method, _, payload in calls if method == 'POST']
    assert len(posts) == 4
    assert all(event['recurrence'] == ['RRULE:FREQ=DAILY'] for event in posts)
    assert all(event['start']['timeZone'] == 'America/Lima' and event['transparency'] == 'transparent' for event in posts)
    assert all(event['reminders']['overrides'][0] == {'method': 'email', 'minutes': 0} for event in posts)
    deleted = [path for method, path, _ in calls if method == 'DELETE']
    assert len(deleted) == 4 and all(path.endswith('_today') for path in deleted)
    assert not any(path.endswith('foreign') or path.endswith('_tomorrow') for path in deleted)
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name='Preparar mañana').click()
    expect(dialog.locator('.dp-item').first).to_contain_text('Leer <b>sin HTML</b>')
    dialog.locator('.dp-item input').first.fill('200')
    dialog.get_by_role('button', name='Cerrar sin guardar').click()
    assert page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['config/plan-2026-10-11'].items[0].minutes") == 30
    page.get_by_role('button', name='Preparar mañana').click()
    dialog.get_by_role('button', name='Hoy no voy a planificar').click()
    expect(dialog).not_to_be_visible()
    assert page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['config/plan-2026-10-11'].estado") == 'omitido'
    page.goto(base + '#planificar-manana', wait_until='networkidle')
    expect(dialog).to_be_visible()
    page.screenshot(path=str(OUT / 'planificador-1280.png'), animations='disabled')
    for width in (390, 1280):
        page.set_viewport_size({'width': width, 'height': 900})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert dialog.evaluate('(n)=>n.scrollWidth <= n.clientWidth + 1')
        page.screenshot(path=str(OUT / ('planificador-%s.png' % width)), animations='disabled')
    dialog.get_by_role('button', name='Cerrar sin guardar').click()
    # El primer paso de mañana usa el cronómetro existente, no uno ficticio.
    page.clock.set_system_time(datetime(2026, 10, 11, 22, 0, tzinfo=timezone.utc))
    page.evaluate("const d=JSON.parse(localStorage.getItem('fichero-tareas:v1'));d['config/plan-2026-10-11']=%s;localStorage.setItem('fichero-tareas:v1',JSON.stringify(d));window.FicheroPlanning.refresh();" % json.dumps(saved))
    expect(page.locator('.dp-route h3').first).to_contain_text('Leer <b>sin HTML</b>')
    page.locator('.dp-route').get_by_role('button', name='Empezar', exact=True).click()
    page.wait_for_function("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/a'].estado==='curso'")
    # Datos de demostración aislados para comprobar fidelidad a la referencia.
    page.clock.set_system_time(datetime(2026, 10, 11, 16, 12, 18, tzinfo=timezone.utc))
    page.evaluate("""const d=JSON.parse(localStorage.getItem('fichero-tareas:v1'));
      d['tareas/a'].titulo='Limpieza microdatos ENAHO';d['tareas/a'].cursoDesde=Date.parse('2026-10-11T10:30:00-05:00');
      d['tareas/a'].estado='curso';d['tareas/a'].pausada=false;d['tareas/a'].proyecto='Economía';
      d['tareas/b'].titulo='Estimación modelo VAR';d['tareas/b'].fecha='2026-10-11';d['tareas/b'].horaLimite='19:00';
      d['tareas/c']={...d['tareas/b'],id:'c',titulo:'Lectura de elasticidades',fecha:'',prioridad:'media',proyecto:'Economía',cursoDesde:0};
      d['config/plan-2026-10-11']={estado:'guardado',capacity:7,startTime:'10:30',items:[
        {id:'a',minutes:100,startTime:'10:30'},{id:'b',minutes:120,startTime:'12:30'},
        {id:'break-demo',kind:'break',title:'Almuerzo y descanso',minutes:60,startTime:'14:30'},
        {id:'c',minutes:105,startTime:'15:30'}],orden:['a','b','break-demo','c']};
      localStorage.setItem('fichero-tareas:v1',JSON.stringify(d));""")
    page.reload(wait_until='networkidle')
    expect(page.locator('.dp-block')).to_have_count(4)
    expect(page.locator('.dp-block-active')).to_contain_text('42 min transcurridos')
    expect(page.locator('.dp-block-next')).to_contain_text('12:30 – 14:30')
    expect(page.locator('.dp-block-next')).to_contain_text('Vence 19:00')
    expect(page.locator('.dp-block-break')).to_contain_text('Almuerzo y descanso')
    expect(page.locator('.dp-block-later')).to_contain_text('Lectura de elasticidades')
    for width in (1280, 390):
        page.set_viewport_size({'width':width,'height':900})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.locator('#daily-planning').screenshot(path=str(OUT / ('ruta-guiada-%s.png' % width)))
    page.evaluate("document.documentElement.dataset.theme='dark'")
    page.locator('#daily-planning').screenshot(path=str(OUT / 'ruta-guiada-dark.png'))
    page.evaluate("document.documentElement.dataset.theme='light'")
    page.set_viewport_size({'width':1280,'height':900})
    page.get_by_role('button',name='Editar hoy',exact=True).click()
    expect(dialog.locator('.dp-item')).to_have_count(4)
    # No se pierde un descanso al editar un plan existente; bloqueos de solapamientos.
    dialog.locator('.dp-item input[type="time"]').nth(1).fill('11:00')
    dialog.get_by_role('button',name='Guardar mi plan',exact=True).click()
    expect(dialog).to_be_visible()
    expect(dialog.locator('.dp-status')).to_contain_text('solapan')
    dialog.locator('.dp-item input[type="time"]').nth(1).fill('12:30')
    dialog.get_by_role('button',name='Guardar mi plan',exact=True).click()
    expect(dialog).not_to_be_visible()
    page.get_by_role('button',name='Preparar mañana',exact=True).click()
    dialog.locator('.dp-candidate').filter(has_text='Estimación modelo VAR').get_by_role('button').click()
    dialog.get_by_role('button',name='+ Añadir descanso',exact=True).click()
    dialog.locator('.dp-candidate').filter(has_text='Lectura de elasticidades').get_by_role('button').click()
    dialog.locator('.dp-schedule-controls input[type="time"]').fill('09:00')
    dialog.get_by_role('button',name='Distribuir mis bloques',exact=True).click()
    assert dialog.locator('.dp-item input[type="time"]').nth(0).input_value()=='09:00'
    assert dialog.locator('.dp-item input[type="time"]').nth(1).input_value()=='09:30'
    dialog.get_by_role('button',name='Guardar mi plan',exact=True).click()
    expect(dialog).not_to_be_visible()
    plan=page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['config/plan-2026-10-12']")
    assert len(plan['items'])==3 and plan['items'][1]['kind']=='break'
    page.get_by_role('button',name='Ver ruta de mañana',exact=True).click()
    expect(page.locator('.dp-heading h2')).to_contain_text('mañana')
    expect(page.locator('.dp-block-time').first).to_contain_text('09:00 – 09:30')
    assert page.get_by_role('button',name='Empezar',exact=True).count()==0, 'No iniciar una tarea futura desde la vista previa'
    assert not errors, errors
    context.close(); browser.close()
    print('OK: plan manual, persistencia, enlace, 4 correos simulados, cancelación selectiva, primer paso con cronómetro y 390/1280; Lima con navegador Madrid.')
