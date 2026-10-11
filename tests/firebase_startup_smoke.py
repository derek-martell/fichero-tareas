"""Firebase simulado con autenticación estricta: nunca toca cuentas ni datos reales."""
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

SDK=r"""
window.firebaseWrites=[];window.earlyAuthCalls=0;
const fixture={'tareas/startup':{titulo:'Tarea guardada antes de actualizar',estado:'pendiente',proyecto:'Prueba',prioridad:'media',cursoDesde:0,sesiones:[]}};
function relative(path){return path.replace(/^usuarios\/test-user\//,'');}
function snap(path){const value=fixture[relative(path)];return {exists:!!value,data:()=>value||{},metadata:{fromCache:false}};}
const fs={enablePersistence:()=>Promise.resolve(),
  doc(path){return {get:()=>Promise.resolve(path.endsWith('/config/migracion')?{exists:true}:snap(path)),
    onSnapshot(fn){queueMicrotask(()=>fn(snap(path)));return ()=>{};},
    set(data){window.firebaseWrites.push({path,data});fixture[relative(path)]=data;return Promise.resolve();}};},
  collection(path){return {
    where(){return this;},
    onSnapshot(fn){queueMicrotask(()=>fn({docs:Object.keys(fixture).filter(k=>k.startsWith(relative(path)+'/')).map(k=>({id:k.split('/').pop(),data:()=>fixture[k]})),metadata:{fromCache:false}}));return ()=>{};},
    doc(id){return fs.doc(path+'/'+id);},get(){return Promise.resolve({docs:[]});}};}};
const auth={currentUser:null,onAuthStateChanged(fn){queueMicrotask(()=>{auth.currentUser={uid:'test-user'};fn(auth.currentUser);});},signInWithPopup:()=>Promise.resolve()};
window.firebase={apps:[],initializeApp(config){this.apps.push({name:'[DEFAULT]'});return this.apps[0];},
  auth(){if(!this.apps.length){window.earlyAuthCalls++;throw new Error('No Firebase App [DEFAULT] has been created - call Firebase App.initializeApp()');}return auth;},firestore:()=>fs};
"""
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    context=browser.new_context(viewport={'width':1280,'height':900})
    def mock(route):
        u=urlparse(route.request.url)
        if u.path.endswith('firebase-app-compat.js'):return route.fulfill(body=SDK,content_type='text/javascript')
        if u.path.endswith('firebase-config.js'):return route.fulfill(body='window.FIREBASE_CONFIG={apiKey:"fake",projectId:"fake"};',content_type='text/javascript')
        if u.hostname not in ('127.0.0.1','localhost'):return route.fulfill(body='',content_type='text/javascript')
        return route.continue_()
    context.route('**/*',mock)
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(sys.argv[1],wait_until='networkidle')
    assert not errors,errors
    assert page.evaluate('window.earlyAuthCalls')==0,'No llamar auth antes de initializeApp'
    expect(page.locator('.card[data-id="startup"]')).to_contain_text('Tarea guardada antes de actualizar')
    expect(page.locator('#sync-badge')).not_to_contain_text('Conectando')
    expect(page.get_by_role('button',name='Configurar música por actividad')).to_be_enabled()
    assert page.evaluate('Object.keys(localStorage).some(k=>k.includes("fichero-pomodoro:v1:local"))') is False
    for width in (1280,390):
        page.set_viewport_size({'width':width,'height':900})
        if width==390:page.locator('#focus-mobile-slot > details > summary').click()
        expect(page.locator('#pomodoro-panel')).to_contain_text('25:00')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.locator('#pomodoro-panel').get_by_role('button',name='Iniciar',exact=True).click()
    assert page.evaluate('localStorage.getItem("fichero-pomodoro:v1:test-user")!==null')
    assert not page.evaluate('window.firebaseWrites'),'El arranque no debe reescribir las tareas'
    assert not errors,errors
    context.close();browser.close()
    print('OK: inicio Firebase estricto, tareas existentes, paneles, usuario autenticado y PC/móvil sin escrituras de datos.')
