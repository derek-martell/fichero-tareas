// Traductor entre la interfaz que usa el tablero (mcp.callTool / mcp.watchTool, con
// entradas y salidas al estilo del conector de Claude) y las APIs REST de Google
// Calendar y Drive, con OAuth en el navegador (Google Identity Services).
//
// El ID de cliente es público por diseño. NUNCA pongas un "client secret" en el repo.
(function(){
  "use strict";

  var SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive";
  var LS_TOKEN = "fichero-tareas:gtoken";
  var LS_VISTO = "fichero-tareas:gconectado";
  var CAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  var DRIVE_API = "https://www.googleapis.com/drive/v3/files";
  var DRIVE_UP = "https://www.googleapis.com/upload/drive/v3/files";

  var token = null, expira = 0, pendiente = null;

  // ---------- almacenamiento del token (dura ~1 h) ----------
  function leerToken(){
    try{
      var t = JSON.parse(localStorage.getItem(LS_TOKEN) || "null");
      if(t && t.tk && t.exp > Date.now()){ token = t.tk; expira = t.exp; }
    }catch(e){}
  }
  function guardarToken(){
    try{
      localStorage.setItem(LS_TOKEN, JSON.stringify({tk: token, exp: expira}));
      localStorage.setItem(LS_VISTO, "1");
    }catch(e){}
  }
  function vigente(){ return !!token && expira > Date.now() + 60000; }

  // ---------- OAuth ----------
  function correoConocido(){
    try{ return window.firebase && firebase.auth().currentUser && firebase.auth().currentUser.email || undefined; }
    catch(e){ return undefined; }
  }

  function pedirToken(silencioso){
    if(pendiente) return pendiente;
    pendiente = new Promise(function(ok, fallo){
      if(!window.google || !google.accounts || !google.accounts.oauth2){
        fallo({code:"upstream_error", message:"No cargó el servicio de acceso de Google."}); return;
      }
      var plazo = setTimeout(function(){ fallo({code:"needs_reauth"}); }, silencioso ? 10000 : 180000);
      var cliente = google.accounts.oauth2.initTokenClient({
        client_id: window.GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: function(r){
          clearTimeout(plazo);
          if(!r || r.error || !r.access_token){
            fallo({code: r && r.error === "access_denied" ? "cancelled" : "needs_reauth", message: r && r.error});
            return;
          }
          token = r.access_token;
          expira = Date.now() + (Number(r.expires_in) || 3600) * 1000;
          guardarToken();
          ok(token);
        },
        error_callback: function(e){
          clearTimeout(plazo);
          fallo({code: e && e.type === "popup_closed" ? "cancelled" : "needs_reauth", message: e && e.type});
        }
      });
      cliente.requestAccessToken({prompt: "", hint: correoConocido()});
    });
    var limpiar = function(){ pendiente = null; };
    pendiente.then(limpiar, limpiar);
    return pendiente;
  }

  // ---------- botón de conexión ----------
  function botonConexion(texto){
    var b = document.getElementById("conectar-google");
    if(texto === null){ if(b) b.remove(); return; }
    var poner = function(){
      var barra = document.querySelector(".actions");
      if(!barra) return;
      var x = document.getElementById("conectar-google");
      if(!x){
        x = document.createElement("button");
        x.id = "conectar-google"; x.className = "btn"; x.type = "button";
        x.addEventListener("click", function(){
          x.disabled = true; x.textContent = "Conectando…";
          pedirToken(false).then(function(){ location.reload(); }, function(e){
            x.disabled = false;
            x.textContent = (e && e.code === "cancelled") ? "Conectar Google" : "No se pudo conectar. Reintentar";
          });
        });
        barra.insertBefore(x, barra.firstChild);
      }
      x.textContent = texto;
    };
    if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", poner); else poner();
  }

  // ---------- llamadas HTTP ----------
  function codigoHttp(status, cuerpo){
    if(status === 401) return "needs_reauth";
    if(status === 429) return "rate_limited";
    if(status >= 500) return "upstream_error";
    var motivo = cuerpo && cuerpo.error && cuerpo.error.errors && cuerpo.error.errors[0] && cuerpo.error.errors[0].reason;
    if(status === 403 && /rateLimit|quota/i.test(motivo || "")) return "rate_limited";
    return "tool_error";
  }

  async function api(url, init, reintento){
    if(!vigente()){
      try{ await pedirToken(true); }
      catch(e){ botonConexion("Reconectar Google"); throw e; }
    }
    var cab = Object.assign({Authorization: "Bearer " + token}, (init && init.headers) || {});
    var r = await fetch(url, Object.assign({}, init || {}, {headers: cab}));
    if(r.status === 401 && !reintento){
      token = null; expira = 0;
      return api(url, init, true);
    }
    if(!r.ok){
      var cuerpo = null;
      try{ cuerpo = await r.json(); }catch(e){}
      throw {code: codigoHttp(r.status, cuerpo), message: cuerpo && cuerpo.error && cuerpo.error.message};
    }
    if(r.status === 204) return null;
    return r.json();
  }

  function qs(o){
    var p = [];
    Object.keys(o).forEach(function(k){
      if(o[k] !== undefined && o[k] !== null && o[k] !== "") p.push(encodeURIComponent(k) + "=" + encodeURIComponent(o[k]));
    });
    return p.length ? "?" + p.join("&") : "";
  }

  // ---------- Calendar ----------
  function nivel(i, conInvitados){
    if(i.notificationLevel === "NONE") return "none";
    if(i.notificationLevel === "ALL") return "all";
    return conInvitados ? "all" : "none";
  }

  function cuerpoEvento(i){
    var b = {};
    if(i.summary !== undefined) b.summary = i.summary;
    if(i.description !== undefined) b.description = i.description;
    if(i.allDay){
      if(i.startTime) b.start = {date: String(i.startTime).slice(0, 10)};
      if(i.endTime) b.end = {date: String(i.endTime).slice(0, 10)};
    } else {
      if(i.startTime) b.start = {dateTime: i.startTime, timeZone: i.timeZone};
      if(i.endTime) b.end = {dateTime: i.endTime, timeZone: i.timeZone};
    }
    if(i.availability) b.transparency = i.availability === "AVAILABILITY_FREE" ? "transparent" : "opaque";
    if(i.colorId) b.colorId = String(i.colorId);
    if(Array.isArray(i.overrideReminders)){
      b.reminders = {useDefault: false, overrides: i.overrideReminders.map(function(x){
        return {method: x.method, minutes: x.minutes};
      })};
    }
    if(Array.isArray(i.attendees)){
      b.attendees = i.attendees.map(function(a){ return {email: a.email}; });
    }
    return b;
  }

  function evento(ev){
    if(!ev) return ev;
    var url = ev.hangoutLink || "";
    if(!url && ev.conferenceData && ev.conferenceData.entryPoints){
      var e = ev.conferenceData.entryPoints.filter(function(x){ return x.entryPointType === "video"; })[0];
      url = e ? e.uri : "";
    }
    return Object.assign({}, ev, {conferenceUrl: url});
  }

  var calendario = {
    create_event: async function(i){
      var b = cuerpoEvento(i);
      var conMeet = !!i.addGoogleMeetUrl;
      if(conMeet){
        b.conferenceData = {createRequest: {
          requestId: "fichero-" + Date.now() + "-" + Math.random().toString(36).slice(2),
          conferenceSolutionKey: {type: "hangoutsMeet"}
        }};
      }
      var ev = await api(CAL_API + qs({
        conferenceDataVersion: conMeet ? 1 : undefined,
        sendUpdates: nivel(i, !!(i.attendees && i.attendees.length))
      }), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(b)});
      return evento(ev);
    },
    update_event: async function(i){
      var ev = await api(CAL_API + "/" + encodeURIComponent(i.eventId) + qs({sendUpdates: nivel(i, false)}),
        {method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify(cuerpoEvento(i))});
      return evento(ev);
    },
    delete_event: async function(i){
      await api(CAL_API + "/" + encodeURIComponent(i.eventId) + qs({sendUpdates: nivel(i, false)}), {method: "DELETE"});
      return {ok: true};
    },
    list_events: async function(i){
      var r = await api(CAL_API + qs({
        timeMin: i.startTime, timeMax: i.endTime, singleEvents: "true",
        orderBy: i.orderBy || "startTime", maxResults: i.pageSize || 50,
        timeZone: i.timeZone, pageToken: i.pageToken
      }));
      return {events: (r.items || []).map(evento), nextPageToken: r.nextPageToken || null};
    }
  };

  // ---------- Drive ----------
  function archivo(f){
    return f && {id: f.id, title: f.name, mimeType: f.mimeType, viewUrl: f.webViewLink, parents: f.parents};
  }
  var CAMPOS = "id,name,mimeType,webViewLink,parents";

  // "parentId = 'X'" y "title contains 'y'" (estilo del conector) -> sintaxis de la API de Drive.
  function consultaDrive(q){
    var s = String(q || "")
      .replace(/parentId\s*=\s*'((?:[^'\\]|\\.)*)'/g, "'$1' in parents")
      .replace(/\btitle\s+contains\b/g, "name contains");
    return s ? "(" + s + ") and trashed = false" : "trashed = false";
  }

  var drive = {
    search_files: async function(i){
      var r = await api(DRIVE_API + qs({
        q: consultaDrive(i.query), pageSize: i.pageSize || 20,
        fields: "files(" + CAMPOS + ")", supportsAllDrives: "true", includeItemsFromAllDrives: "true"
      }));
      return {files: (r.files || []).map(archivo)};
    },
    get_file_metadata: async function(i){
      return archivo(await api(DRIVE_API + "/" + encodeURIComponent(i.fileId) +
        qs({fields: CAMPOS, supportsAllDrives: "true"})));
    },
    create_file: async function(i){
      var meta = {name: i.title, mimeType: "application/vnd.google-apps.document"};
      if(i.parentId) meta.parents = [i.parentId];
      var lim = "fichero" + Math.random().toString(36).slice(2);
      var cuerpo = "--" + lim + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) +
        "\r\n--" + lim + "\r\nContent-Type: " + (i.contentMimeType || "text/plain") + "; charset=UTF-8\r\n\r\n" +
        (i.textContent || "") + "\r\n--" + lim + "--";
      return archivo(await api(DRIVE_UP + qs({uploadType: "multipart", supportsAllDrives: "true", fields: CAMPOS}),
        {method: "POST", headers: {"Content-Type": "multipart/related; boundary=" + lim}, body: cuerpo}));
    }
  };

  // ---------- interfaz mcp ----------
  async function llamar(servidor, herramienta, input){
    var tabla = /drive/i.test(servidor) ? drive : calendario;
    if(!tabla[herramienta]) throw {code: "tool_error", message: "Herramienta no disponible: " + herramienta};
    return {payload: await tabla[herramienta](input || {})};
  }

  var mcp = {
    callTool: llamar,
    // Devuelve una función para cancelar. Vuelve a consultar cada `refetchInterval` ms.
    watchTool: function(servidor, herramienta, input, cb, opts){
      var vivo = true;
      function ronda(){
        llamar(servidor, herramienta, input).then(
          function(r){ if(vivo) cb({type: "result", result: r}); },
          function(e){ if(vivo) cb({type: "error", error: e}); });
      }
      ronda();
      var t = opts && opts.refetchInterval ? setInterval(ronda, opts.refetchInterval) : null;
      return function(){ vivo = false; if(t) clearInterval(t); };
    }
  };

  // Devuelve `mcp` si hay conexión con Google; si no, null y deja el botón para conectar.
  window.googleMcp = {
    obtener: async function(){
      if(!window.GOOGLE_CLIENT_ID) return null;
      leerToken();
      if(vigente()){ botonConexion(null); return mcp; }
      var yaConectado = false;
      try{ yaConectado = localStorage.getItem(LS_VISTO) === "1"; }catch(e){}
      if(yaConectado){
        try{ await pedirToken(true); botonConexion(null); return mcp; }
        catch(e){ botonConexion("Reconectar Google"); return null; }
      }
      botonConexion("Conectar Google");
      return null;
    }
  };
})();
