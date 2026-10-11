"""Clasificación y playlists con Firebase/Spotify/Calendar bloqueados y datos de prueba."""
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

OUT=Path(__file__).resolve().parents[1]/'test-results'
OUT.mkdir(exist_ok=True)
NOW=datetime(2026,10,11,17,0,tzinfo=timezone.utc)
data={'config/preferencias':{'registrarTiempo':False},'tareas/test':{
    'id':'test','titulo':'Limpiar microdatos ENAHO','estado':'curso','pausada':False,
    'cursoDesde':int(NOW.timestamp()*1000)-600000,'msEnCurso':0,'sesiones':[],'proyecto':'Economía','prioridad':'media','estimadoMin':60}}
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    context=browser.new_context(viewport={'width':1280,'height':1000})
    requests=[]
    def mock(route):
        parsed=urlparse(route.request.url)
        if parsed.path.endswith('firebase-config.js'):
            return route.fulfill(body='window.FIREBASE_CONFIG=null;',content_type='text/javascript')
        if parsed.hostname not in ('127.0.0.1','localhost'):
            requests.append(route.request.url)
            return route.fulfill(body='',content_type='text/javascript')
        route.continue_()
    context.route('**/*',mock)
    context.add_init_script("if(!localStorage.getItem('__activitySeed')){localStorage.setItem('__activitySeed','1');localStorage.setItem('fichero-tareas:v1',JSON.stringify(%s));}" % json.dumps(data))
    page=context.new_page()
    page.clock.install(time=NOW)
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(sys.argv[1],wait_until='networkidle')
    chip=page.locator('.card[data-id="test"] .activity-chip')
    expect(chip).to_contain_text('Programación y análisis · sugerido')
    expect(page.locator('#music-panel')).to_contain_text('Spotify sin conectar')
    chip.click()
    dialog=page.locator('.activity-dialog')
    dialog.locator('select').select_option('lectura')
    dialog.get_by_role('button',name='Guardar actividad',exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(chip).to_have_text('Lectura y estudio')
    assert page.evaluate("JSON.parse(localStorage.getItem('fichero-tareas:v1'))['tareas/test'].actividad")=='lectura'
    page.get_by_role('button',name='Configurar música por actividad').click()
    mapping=page.locator('.music-mapping').filter(has=page.locator('legend',has_text='Lectura y estudio'))
    mapping.locator('select').select_option('playlist')
    mapping.locator('input').nth(0).fill('Concentración para leer')
    mapping.locator('input').nth(1).fill('javascript:alert(1)')
    page.get_by_role('button',name='Guardar playlists',exact=True).click()
    expect(page.locator('.music-dialog').first).to_be_visible()
    expect(page.locator('.music-dialog').first).to_contain_text('enlace válido')
    mapping.locator('input').nth(1).fill('https://open.spotify.com/playlist/37i9dQZF1DWZeKCadgRdKQ?si=demo')
    page.get_by_role('button',name='Guardar playlists',exact=True).click()
    expect(page.locator('.music-dialog').first).not_to_be_visible()
    expect(page.locator('#music-panel')).to_contain_text('Concentración para leer')
    expect(page.locator('#music-panel .music-open')).to_have_attribute('href','https://open.spotify.com/playlist/37i9dQZF1DWZeKCadgRdKQ')
    # Recarga conserva tanto la elección manual como las playlists por usuario.
    page.reload(wait_until='networkidle')
    expect(chip).to_have_text('Lectura y estudio')
    expect(page.locator('#music-panel')).to_contain_text('Concentración para leer')
    page.locator('.card[data-id="test"]').click()
    expect(page.locator('#f-actividad')).to_have_value('lectura')
    page.locator('#f-titulo').fill('Programar código Python')
    expect(page.locator('#f-actividad')).to_have_value('lectura')
    page.locator('#f-actividad').select_option('')
    expect(page.locator('#f-actividad-nota')).to_contain_text('Programación y análisis')
    page.locator('#form').get_by_role('button',name='Guardar',exact=True).click()
    expect(chip).to_contain_text('Programación y análisis · sugerido')
    page.locator('#focus-tools').screenshot(path=str(OUT/'panel-musica-pomodoro.png'))
    for width,height in [(1280,1000),(390,844),(900,700)]:
        page.set_viewport_size({'width':width,'height':height})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        if width<=820:
            page.locator('#focus-mobile-slot > details > summary').click()
            expect(page.locator('#focus-mobile-slot #music-panel')).to_be_visible()
            expect(page.locator('#focus-mobile-slot #pomodoro-panel')).to_be_visible()
            expect(page.locator('#board > .col:visible')).to_have_count(1)
        else:
            expect(page.locator('.desktop-sidebar #focus-tools')).to_be_visible()
            page.locator('.desktop-sidebar').evaluate('(n)=>n.scrollTop=n.scrollHeight')
        page.screenshot(path=str(OUT/('musica-pomodoro-%s.png'%width)))
    page.set_viewport_size({'width':1280,'height':1000})
    page.evaluate("document.documentElement.dataset.theme='dark'")
    page.screenshot(path=str(OUT/'musica-pomodoro-dark.png'))
    assert not any('api.spotify.com' in r or 'accounts.spotify.com' in r for r in requests)
    assert not errors,errors
    context.close();browser.close()
    print('OK: categorías, edición manual/automática, playlists válidas, persistencia, PC/móvil y Spotify honesto sin conexión.')
