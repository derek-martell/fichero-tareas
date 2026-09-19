// Sustituye las capacidades de la plataforma de Artifacts (claude.use) para que el
// tablero corra como página estática. Misma interfaz que usa el resto del código:
//   db         -> Firestore (si hay FIREBASE_CONFIG) o localStorage (si no)
//   mcp        -> google.js (Calendar y Drive vía OAuth), o null si no hay conexión
//   downloads  -> Blob + <a download>
(function(){
  "use strict";

  // ---------- downloads ----------
  var downloads = {
    save: async function(o){
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data]);
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = o.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
    }
  };

  // ---------- almacén local (respaldo cuando no hay Firebase) ----------
  var CLAVE = "fichero-tareas:v1";
  function leerTodo(){
    try{ return JSON.parse(localStorage.getItem(CLAVE) || "{}"); }catch(e){ return {}; }
  }
  function escribirTodo(o){
    try{ localStorage.setItem(CLAVE, JSON.stringify(o)); }catch(e){}
  }
  function copia(v){ return JSON.parse(JSON.stringify(v)); }

  function almacenLocal(){
    var oyentes = [];   // {ruta, tipo:"doc"|"col", cb}
    var canal = ("BroadcastChannel" in window) ? new BroadcastChannel(CLAVE) : null;

    function snapDoc(ruta){
      var d = leerTodo()[ruta];
      return { exists: d !== undefined, data: function(){ return d === undefined ? undefined : copia(d); },
               id: ruta.split("/").pop(), metadata: {fromCache:false} };
    }
    function cumple(d, filtros){
      return filtros.every(function(f){
        var v = d[f[0]];
        if(f[1] === "==")  return v === f[2];
        if(f[1] === ">=")  return v >= f[2];
        if(f[1] === "<=")  return v <= f[2];
        if(f[1] === ">")   return v > f[2];
        if(f[1] === "<")   return v < f[2];
        return false;
      });
    }
    function snapCol(nombre, filtros){
      var todo = leerTodo(), docs = [];
      filtros = filtros || [];
      Object.keys(todo).forEach(function(k){
        if(k.indexOf(nombre + "/") === 0 && k.split("/").length === 2 && cumple(todo[k], filtros)){
          docs.push({ id: k.split("/")[1], exists:true, data: function(){ return copia(todo[k]); } });
        }
      });
      return { docs: docs, empty: !docs.length, size: docs.length, metadata: {fromCache:false} };
    }
    function avisar(){
      oyentes.forEach(function(o){
        try{ o.cb(o.tipo === "doc" ? snapDoc(o.ruta) : snapCol(o.ruta, o.filtros)); }catch(e){ console.error(e); }
      });
    }
    function cambiar(fn){
      var todo = leerTodo(); fn(todo); escribirTodo(todo);
      avisar();
      if(canal) canal.postMessage("cambio");
      return Promise.resolve();
    }
    if(canal) canal.onmessage = avisar;
    window.addEventListener("storage", function(e){ if(e.key === CLAVE) avisar(); });

    function suscribir(o){
      oyentes.push(o);
      setTimeout(function(){
        if(oyentes.indexOf(o) < 0) return;
        try{ o.cb(o.tipo === "doc" ? snapDoc(o.ruta) : snapCol(o.ruta, o.filtros)); }catch(e){ console.error(e); }
      }, 0);
      return function(){ var i = oyentes.indexOf(o); if(i >= 0) oyentes.splice(i, 1); };
    }
    function colRef(nombre, filtros){
      return {
        doc: function(id){ return docRef(nombre + "/" + id); },
        where: function(campo, op, valor){ return colRef(nombre, filtros.concat([[campo, op, valor]])); },
        onSnapshot: function(cb){ return suscribir({ruta:nombre, tipo:"col", filtros:filtros, cb:cb}); },
        get: function(){ return Promise.resolve(snapCol(nombre, filtros)); }
      };
    }
    function docRef(ruta){
      return {
        onSnapshot: function(cb){ return suscribir({ruta:ruta, tipo:"doc", cb:cb}); },
        get: function(){ return Promise.resolve(snapDoc(ruta)); },
        set: function(obj){ return cambiar(function(t){ t[ruta] = copia(obj); }); },
        update: function(obj){ return cambiar(function(t){ t[ruta] = Object.assign({}, t[ruta] || {}, copia(obj)); }); },
        delete: function(){ return cambiar(function(t){ delete t[ruta]; }); }
      };
    }
    return {
      doc: docRef,
      collection: function(nombre){ return colRef(nombre, []); }
    };
  }

  // ---------- Firestore + inicio de sesión con Google ----------
  function pantallaLogin(mensaje, alPulsar){
    var d = document.getElementById("login-shim");
    if(!d){
      d = document.createElement("div");
      d.id = "login-shim";
      d.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--ground,#EDF0F4);color:var(--ink,#18202B);font-family:'IBM Plex Sans',system-ui,sans-serif;text-align:center;padding:24px";
      d.innerHTML = '<h1 style="font-family:Archivo,system-ui,sans-serif;margin:0">Fichero de Tareas</h1>' +
                    '<p id="login-msg" style="margin:0;color:var(--muted,#616C7C)"></p>' +
                    '<button id="login-btn" class="btn-primary" style="font-size:15px;padding:10px 18px">Entrar con Google</button>';
      document.body.appendChild(d);
    }
    d.querySelector("#login-msg").textContent = mensaje;
    d.querySelector("#login-btn").onclick = alPulsar;
    return d;
  }

  function almacenFirebase(cfg){
    firebase.initializeApp(cfg);
    var auth = firebase.auth();
    var fs = firebase.firestore();
    try{ fs.enablePersistence({synchronizeTabs:true}).catch(function(){}); }catch(e){}

    // Cada persona guarda todo bajo usuarios/{uid}/…; las reglas solo le dejan ver esa rama.
    function porUsuario(uid){
      var base = "usuarios/" + uid + "/";
      return {
        doc: function(ruta){ return fs.doc(base + ruta); },
        collection: function(nombre){ return fs.collection(base + nombre); }
      };
    }

    // Copia (sin borrar) los datos de la estructura antigua, una sola vez por cuenta.
    // Si la cuenta no tiene permiso sobre esas rutas, no hay nada que migrar.
    function migrar(uid){
      var base = "usuarios/" + uid + "/";
      var marca = fs.doc(base + "config/migracion");
      return marca.get().then(function(m){
        if(m.exists) return;
        var pares = [];
        var lecturas = ["tareas", "asistencia"].map(function(c){
          return fs.collection(c).get().then(function(s){
            s.docs.forEach(function(d){ pares.push([base + c + "/" + d.id, d.data()]); });
          });
        }).concat(["cursos", "carpetas", "preferencias"].map(function(n){
          return fs.doc("config/" + n).get().then(function(d){
            if(d.exists) pares.push([base + "config/" + n, d.data()]);
          });
        }));
        return Promise.all(lecturas).then(function(){
          var lotes = [];
          for(var i = 0; i < pares.length; i += 400){
            var b = fs.batch();
            pares.slice(i, i + 400).forEach(function(p){ b.set(fs.doc(p[0]), p[1]); });
            lotes.push(b.commit());
          }
          return Promise.all(lotes);
        }).then(function(){
          return marca.set({ migrados: pares.length, fecha: Date.now() });
        });
      }).catch(function(e){
        // Sin permiso sobre lo antiguo = cuenta nueva: se marca y no se vuelve a intentar.
        if(e && e.code === "permission-denied") return marca.set({ migrados: 0, fecha: Date.now() }).catch(function(){});
        console.warn("Migración pendiente:", e);
      });
    }

    return new Promise(function(resolver){
      var listo = false;
      function pedir(msg){
        pantallaLogin(msg, function(){
          auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(function(e){
            pedir("No se pudo iniciar sesión (" + (e && e.code || "error") + "). Inténtalo de nuevo.");
          });
        });
      }
      auth.onAuthStateChanged(function(u){
        if(!u){ pedir("Inicia sesión para ver tus tareas."); return; }
        var d = document.getElementById("login-shim"); if(d) d.remove();
        if(!listo){ listo = true; migrar(u.uid).then(function(){ resolver(porUsuario(u.uid)); }); }
      });
    });
  }

  // ---------- claude.use ----------
  var dbPromesa = null;
  function obtenerDb(){
    if(dbPromesa) return dbPromesa;
    var cfg = window.FIREBASE_CONFIG;
    dbPromesa = (cfg && window.firebase) ? almacenFirebase(cfg) : Promise.resolve(almacenLocal());
    return dbPromesa;
  }

  window.claude = {
    use: function(nombre){
      if(nombre === "db")        return obtenerDb();
      if(nombre === "downloads") return Promise.resolve(downloads);
      if(nombre === "mcp")       return window.googleMcp ? window.googleMcp.obtener() : Promise.resolve(null);
      return Promise.resolve(null);   // "mcp" y cualquier otro
    }
  };
})();
