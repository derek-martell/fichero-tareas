"""Standalone mocked host; no Firebase, auth, Calendar or external requests.

Run: python tests/pomodoro_smoke.py [http://127.0.0.1:FRESH_PORT/]
Without a URL, starts its own fresh local server with logs sent to NUL.
"""
import json
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
NOW = datetime(2026, 10, 11, 17, 0, tzinfo=timezone.utc)
HOST = '''<!doctype html><html lang="es" data-theme="light"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="pomodoro.css"><body>
<div style="width:196px;max-width:100%"><section id="pomodoro-panel"></section></div>
<script src="pomodoro.js"></script><script>
window.uid='alice'; window.toasts=[];
window.tasks=[{id:'a',titulo:'Leer <b>sin HTML</b>',estado:'curso',cursoDesde:Date.now(),pausada:false}];
window.FicheroPomodoro.mount({root:document.getElementById('pomodoro-panel'),
tasks:()=>window.tasks,scope:()=>window.uid,toast:message=>window.toasts.push(message)});
</script></body></html>'''


def run(base):
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        errors, external = [], []

        def route_request(route):
            parsed = urlparse(route.request.url)
            if parsed.hostname not in ('localhost', '127.0.0.1'):
                external.append(route.request.url)
                return route.fulfill(body='', content_type='text/javascript')
            if parsed.path.endswith('/__pomodoro__'):
                return route.fulfill(body=HOST, content_type='text/html')
            return route.continue_()

        context.route('**/*', route_request)
        context.add_init_script('''window.audioCreated=0;window.beeps=0;window.permissions=0;
          window.AudioContext=class {constructor(){window.audioCreated++;this.state='running';this.currentTime=0;}
          createOscillator(){return {frequency:{value:0},connect(){},disconnect(){},start(){window.beeps++;},stop(){}};}
          createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
          resume(){return Promise.resolve();} close(){return Promise.resolve();}};
          window.Notification={requestPermission(){window.permissions++;}};''')
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.clock.install(time=NOW)
        page.goto(base.rstrip('/') + '/__pomodoro__', wait_until='networkidle')
        panel = page.locator('#pomodoro-panel')
        expect(panel.locator('.fp-clock')).to_have_text('25:00')
        expect(panel.locator('.fp-context')).to_have_text('En foco: Leer <b>sin HTML</b>')
        assert panel.locator('.fp-context b').count() == 0
        baseline = page.evaluate('JSON.stringify(window.tasks)')
        page.evaluate("window.tasks[0].pausada=true;window.FicheroPomodoro.refresh()")
        expect(panel.locator('.fp-context')).to_have_text('Un momento para concentrarte.')
        page.evaluate("window.tasks[0].pausada=false;window.tasks[0].cursoDesde=0;window.FicheroPomodoro.refresh()")
        expect(panel.locator('.fp-context')).to_have_text('Un momento para concentrarte.')
        page.evaluate('window.tasks=' + baseline + ';window.FicheroPomodoro.refresh()')
        page.get_by_text('Ajustes', exact=True).click()
        page.get_by_label('Concentración (min)', exact=True).fill('1')
        page.get_by_role('button', name='Guardar duraciones').click()
        expect(panel.locator('.fp-clock')).to_have_text('01:00')
        assert page.evaluate('window.toasts.length') == 1
        assert page.evaluate('window.audioCreated') == 0
        page.get_by_label('Sonido al terminar').check()
        assert page.evaluate('window.audioCreated') == 1
        page.get_by_role('button', name='Iniciar', exact=True).click()
        page.clock.run_for(10000)
        expect(panel.locator('.fp-clock')).to_have_text('00:50')
        page.get_by_role('button', name='Pausar', exact=True).click()
        page.clock.run_for(20000)
        expect(panel.locator('.fp-clock')).to_have_text('00:50')
        page.get_by_role('button', name='Reanudar').click()
        page.clock.run_for(50000)
        expect(panel.locator('.fp-status')).to_contain_text('terminada')
        expect(panel.locator('.fp-rounds')).to_have_text('1 ronda completada')
        assert page.evaluate('window.beeps') == 1
        page.clock.run_for(10000)
        expect(panel.locator('.fp-clock')).to_have_text('00:00')
        page.reload(wait_until='networkidle')
        expect(panel.locator('.fp-rounds')).to_have_text('1 ronda completada')
        assert page.evaluate('window.audioCreated') == 0
        page.get_by_role('button', name='Iniciar descanso corto', exact=True).click()
        expect(panel.locator('.fp-phase')).to_have_text('Descanso corto')
        page.evaluate("window.uid='bob';window.FicheroPomodoro.refresh()")
        expect(panel.locator('.fp-clock')).to_have_text('25:00')
        expect(panel.locator('.fp-rounds')).to_have_text('0 rondas completadas')
        page.evaluate("window.uid='alice';window.FicheroPomodoro.refresh()")
        expect(panel.locator('.fp-phase')).to_have_text('Descanso corto')
        page.get_by_role('button', name='Reiniciar', exact=True).click()
        page.get_by_text('Ajustes', exact=True).click()
        page.get_by_role('button', name='Omitir fase').click()
        expect(panel.locator('.fp-phase')).to_have_text('Concentración')
        page.get_by_role('button', name='Iniciar', exact=True).click()
        # Reload a persisted deadline in the past, even when the page was closed.
        page.evaluate('''const k='fichero-pomodoro:v1:alice';const s=JSON.parse(localStorage.getItem(k));
          s.deadline=Date.now()-1;localStorage.setItem(k,JSON.stringify(s));''')
        page.reload(wait_until='networkidle')
        expect(panel.locator('.fp-rounds')).to_have_text('2 rondas completadas')
        page.reload(wait_until='networkidle')
        expect(panel.locator('.fp-rounds')).to_have_text('2 rondas completadas')
        page.evaluate("window.tasks[0].titulo='Nuevo contexto';window.FicheroPomodoro.refresh()")
        expect(panel.locator('.fp-context')).to_have_text('En foco: Nuevo contexto')
        page.evaluate("window.tasks[0].titulo='Leer <b>sin HTML</b>'")
        # The host fixture reconstructs its own active timestamp on reload.
        assert page.evaluate("window.tasks[0].estado==='curso' && window.tasks[0].pausada===false && window.tasks[0].cursoDesde>0")
        # Repeated mounts retain state and remove old ticking/listeners.
        page.evaluate('''window.FicheroPomodoro.mount({root:document.getElementById('pomodoro-panel'),
          tasks:()=>window.tasks,scope:()=>window.uid});''')
        expect(panel.locator('h2')).to_have_count(1)
        page.get_by_text('Ajustes', exact=True).click()
        for width in (1280, 390):
            page.set_viewport_size({'width': width, 'height': 900})
            # Host owns placement: widen the mobile card without touching sidebar CSS.
            page.evaluate("document.querySelector('#pomodoro-panel').parentElement.style.width=innerWidth<=820?'100%':'196px'")
            for theme in ('light', 'dark'):
                page.evaluate('document.documentElement.dataset.theme=' + json.dumps(theme))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                assert panel.evaluate('(n)=>n.scrollWidth<=n.clientWidth+1')
                assert panel.locator('button,input,summary').evaluate_all('(ns)=>ns.every(n=>n.getBoundingClientRect().height>=44 && n.getBoundingClientRect().width>=44)')
                panel.screenshot(path=str(OUT / f'pomodoro-{width}-{theme}.png'), animations='disabled')
        page.get_by_label('Concentración (min)', exact=True).focus()
        page.keyboard.press('Tab')
        assert page.evaluate("document.activeElement.name==='short'")
        assert page.evaluate('window.permissions') == 0
        assert not external, external
        assert not errors, errors
        context.close()
        browser.close()
    print('OK: Pomodoro independiente, controles, recarga/vencimiento, scopes, sonido opt-in y 390/1280 claro/oscuro.')


if __name__ == '__main__':
    if len(sys.argv) > 1:
        run(sys.argv[1])
    else:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '--directory', str(ROOT)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError('El servidor local no pudo iniciarse.')
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.05)
            else:
                raise RuntimeError('El servidor local no respondió.')
            run(f'http://127.0.0.1:{port}/')
        finally:
            server.terminate()
            server.wait(timeout=5)
