"""Calendario sincronizado: prueba aislada con un Google Calendar simulado en memoria.

Uso: python3 tests/calendar_smoke.py [URL_LOCAL]  (por defecto http://127.0.0.1:8765)
Nunca usa Firebase ni un Calendar real. Capturas en test-results/.
"""
import json
import re
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-results"
OUT.mkdir(exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
NOW = datetime(2026, 11, 10, 15, 0, tzinfo=timezone.utc)   # martes 10:00 en Lima
MS = int(NOW.timestamp() * 1000)

store = {
    "e1": {"id": "e1", "summary": "Clase de Econometría", "start": {"dateTime": "2026-11-10T11:00:00-05:00"},
           "end": {"dateTime": "2026-11-10T12:30:00-05:00"}, "colorId": "7", "organizer": {"self": True},
           "htmlLink": "https://calendar.google.com/calendar/event?eid=e1"},
    "e2": {"id": "e2", "summary": "Reunión de tesis", "start": {"dateTime": "2026-11-10T11:30:00-05:00"},
           "end": {"dateTime": "2026-11-10T12:00:00-05:00"}, "organizer": {"email": "asesor@x.edu"}},
    "e3": {"id": "e3", "summary": "Feriado", "start": {"date": "2026-11-12"}, "end": {"date": "2026-11-13"},
           "organizer": {"self": True}},
}
calls = []


def task():
    return {"tareas/t1": dict(id="t1", titulo="Entregar ensayo", proyecto="Curso", estado="pendiente",
                              prioridad="alta", creado=MS - 86400000, msEnCurso=0, cursoDesde=0, completado=0,
                              estimadoMin=60, orden=0, sesiones=[], fecha="2026-11-11")}


def route_request(route):
    req = route.request
    u = urlparse(req.url)
    if u.path.endswith("firebase-config.js"):
        return route.fulfill(content_type="text/javascript", body="window.FIREBASE_CONFIG=null;window.GOOGLE_CLIENT_ID='test';")
    if u.hostname == "www.googleapis.com":
        h = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
             "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"}
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=h)
        body = json.loads(req.post_data or "{}")
        calls.append((req.method, u.path, body))
        last = u.path.rsplit("/", 1)[-1]
        if req.method == "GET":
            return route.fulfill(headers=h, json={"items": list(store.values())})
        if req.method == "DELETE":
            store.pop(last, None)
            return route.fulfill(status=204, headers=h)
        if req.method == "PATCH":
            ev = store[last]
            for k, v in body.items():
                if isinstance(v, dict) and isinstance(ev.get(k), dict):
                    merged = dict(ev[k]); merged.update(v)
                    ev[k] = {a: b for a, b in merged.items() if b is not None}
                else:
                    ev[k] = v
            return route.fulfill(headers=h, json=ev)
        new_id = "n%d" % len(store)
        store[new_id] = dict(body, id=new_id, organizer={"self": True})
        return route.fulfill(headers=h, json=store[new_id])
    if u.hostname not in ("localhost", "127.0.0.1"):
        return route.fulfill(body="", content_type="text/css" if "fonts" in req.url else "text/javascript")
    return route.continue_()


def overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "Desbordamiento horizontal"


with sync_playwright() as p:
    # CHROMIUM=/ruta/al/navegador si la versión de Playwright no trae el suyo.
    browser = p.chromium.launch(**({"executable_path": os.environ["CHROMIUM"]} if os.environ.get("CHROMIUM") else {}))
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="America/Lima", locale="es-PE")
    ctx.route("**/*", route_request)
    ctx.add_init_script("""if(!localStorage.getItem('__seed')){localStorage.clear();localStorage.setItem('__seed','1');
      localStorage.setItem('fichero-tareas:v1',JSON.stringify(%s));
      localStorage.setItem('fichero-tareas:gtoken',JSON.stringify({tk:'test',exp:%d}));
      localStorage.setItem('fichero-tema','light');}""" % (json.dumps(task()), MS + 86400000))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.clock.install(time=NOW)
    page.goto(URL, wait_until="networkidle")
    page.click(".desktop-sidebar [data-workspace=calendario]")
    cal = page.locator("#workspace-calendar")
    expect(cal).to_be_visible()
    expect(page.locator(".board")).to_be_hidden()
    expect(cal.locator(".gc-titulo")).to_contain_text(re.compile("9 – 15 nov", re.I))
    expect(cal.locator(".gc-bloque", has_text="Clase de Econometría")).to_be_visible()
    expect(cal.locator(".gc-todo-celda .gc-chip", has_text="Feriado")).to_be_visible()
    expect(cal.locator(".gc-tarea", has_text="Entregar ensayo")).to_be_visible()
    a = cal.locator(".gc-bloque", has_text="Clase de Econometría").bounding_box()
    b = cal.locator(".gc-bloque", has_text="Reunión de tesis").bounding_box()
    assert a["x"] + a["width"] <= b["x"] + 1 or b["x"] + b["width"] <= a["x"] + 1, "Eventos solapados se pisan"
    overflow(page)
    page.screenshot(path=str(OUT / "calendar-week-1280.png"))

    # Evento de otra persona: solo lectura
    cal.locator(".gc-bloque", has_text="Reunión de tesis").click()
    expect(page.locator(".gc-dialogo .gc-nota")).to_contain_text("otra persona")
    expect(page.locator(".gc-dialogo button[type=submit]")).to_be_hidden()
    page.locator(".gc-dialogo").get_by_role("button", name="Cancelar").click()

    # Crear haciendo clic en la rejilla (miércoles 15:00)
    col = cal.locator(".gc-col").nth(2)
    col.click(position={"x": 20, "y": 15 * 48 + 5})
    dlg = page.locator(".gc-dialogo")
    expect(dlg.locator("input[type=date]").first).to_have_value("2026-11-11")
    expect(dlg.locator("input[type=time]").first).to_have_value("15:00")
    dlg.locator("input[type=text]").first.fill("Estudiar para el parcial")
    dlg.locator("input[type=text]").nth(1).fill("Biblioteca")
    dlg.get_by_role("button", name="Guardar").click()
    expect(cal.locator(".gc-bloque", has_text="Estudiar para el parcial")).to_be_visible()
    post = [c for c in calls if c[0] == "POST"][-1][2]
    assert post["summary"] == "Estudiar para el parcial" and post["location"] == "Biblioteca", post
    assert post["start"]["dateTime"] == "2026-11-11T20:00:00.000Z", post["start"]
    assert post["end"]["dateTime"] == "2026-11-11T21:00:00.000Z", post["end"]

    # Editar: pasar a todo el día
    cal.locator(".gc-bloque", has_text="Estudiar para el parcial").click()
    dlg.locator("input[type=checkbox]").check()
    dlg.get_by_role("button", name="Guardar").click()
    expect(cal.locator(".gc-todo-celda .gc-chip", has_text="Estudiar para el parcial")).to_be_visible()
    patch = [c for c in calls if c[0] == "PATCH"][-1][2]
    assert patch["start"] == {"date": "2026-11-11", "dateTime": None, "timeZone": None}, patch
    assert patch["end"]["date"] == "2026-11-12", patch

    # Cambio hecho en Google: aparece al sincronizar
    store["ext"] = {"id": "ext", "summary": "Creado en el móvil", "start": {"dateTime": "2026-11-13T09:00:00-05:00"},
                    "end": {"dateTime": "2026-11-13T10:00:00-05:00"}}
    cal.get_by_role("button", name="↻ Sincronizar").click()
    expect(cal.locator(".gc-bloque", has_text="Creado en el móvil")).to_be_visible()
    expect(cal.locator(".gc-estado")).to_contain_text("Sincronizado")

    # Eliminar
    cal.locator(".gc-bloque", has_text="Creado en el móvil").click()
    dlg.get_by_role("button", name="Eliminar").click()
    expect(cal.locator(".gc-bloque", has_text="Creado en el móvil")).to_have_count(0)
    assert "ext" not in store

    # Mes
    cal.get_by_role("button", name="Mes").click()
    expect(cal.locator(".gc-titulo")).to_contain_text(re.compile("noviembre de 2026", re.I))
    expect(cal.locator(".gc-mes-dia.es-hoy .gc-chip").first).to_be_visible()
    page.screenshot(path=str(OUT / "calendar-month-1280.png"))
    page.evaluate("localStorage.setItem('fichero-tema','dark');document.documentElement.setAttribute('data-theme','dark')")
    cal.get_by_role("button", name="Semana").click()
    page.screenshot(path=str(OUT / "calendar-week-dark-1280.png"))

    # Móvil
    m = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="America/Lima", locale="es-PE",
                            is_mobile=True, has_touch=True)
    m.route("**/*", route_request)
    m.add_init_script("""localStorage.setItem('fichero-tareas:gtoken',JSON.stringify({tk:'test',exp:%d}));
      localStorage.setItem('fichero-tareas:v1',JSON.stringify(%s));localStorage.setItem('fichero-tema','light');""" % (MS + 86400000, json.dumps(task())))
    mp = m.new_page()
    mp.on("pageerror", lambda e: errors.append(str(e)))
    mp.clock.install(time=NOW)
    mp.goto(URL, wait_until="networkidle")
    mp.click(".workspace-shortcuts [data-workspace=calendario]")
    mc = mp.locator("#workspace-calendar")
    expect(mc.locator(".gc-bloque", has_text="Clase de Econometría")).to_be_visible()
    expect(mc.locator(".gc-titulo")).to_contain_text(re.compile("martes", re.I))
    overflow(mp)
    mp.screenshot(path=str(OUT / "calendar-day-390.png"))
    mc.get_by_role("button", name="Mes").click()
    overflow(mp)
    mp.screenshot(path=str(OUT / "calendar-month-390.png"))
    assert not errors, errors
    print("OK: semana, mes, día, crear, editar, todo el día, solo lectura, sincronizar, eliminar, móvil.")
    browser.close()
