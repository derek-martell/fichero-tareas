/* Clasificación local y playlists elegidas por la persona. No controla Spotify. */
(function(global){
  'use strict';
  var types=[['lectura','Lectura y estudio'],['escritura','Escritura y redacción'],['analisis','Programación y análisis'],['repaso','Repaso y ejercicios'],['organizacion','Organización'],['reunion','Reuniones'],['otros','Sin clasificar']];
  var rules={
    lectura:/\b(leer|lectura|estudiar|bibliografia|articulo|libro)\b/g,
    escritura:/\b(escribir|redactar|redaccion|borrador|capitulo|ensayo)\b/g,
    analisis:/\b(programar|programacion|codigo|microdatos|stata|python|sql|regresion|estimar|estimacion|depurar|analizar|analisis|modelo|limpiar datos)\b/g,
    repaso:/\b(repasar|repaso|ejercicios|practicar|practica|simulacro)\b/g,
    organizacion:/\b(organizar|planificar|planificacion|agenda|administrativo|ordenar|tramite)\b/g,
    reunion:/\b(reunion|reuniones|meet|llamada|entrevista)\b/g
  };
  function valid(id){return types.some(function(t){return t[0]===id;});}
  function label(id){return (types.find(function(t){return t[0]===id;}) || types[6])[1];}
  function suggest(title){
    var text=String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(), winner='otros',best=0,tie=false;
    Object.keys(rules).forEach(function(id){var score=(text.match(rules[id]) || []).length;
      if(score>best){winner=id;best=score;tie=false;} else if(score && score===best) tie=true;
    });
    return tie ? 'otros' : winner;
  }
  function resolve(t){return valid(t.actividad) ? t.actividad : suggest(t.titulo);}
  function playlist(value){
    var match=String(value || '').trim().match(/^spotify:playlist:([A-Za-z0-9]{22})$/);
    if(!match){try{var u=new URL(value);if(u.protocol==='https:' && u.hostname==='open.spotify.com') match=u.pathname.match(/^\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]{22})\/?$/);}catch(e){}}
    return match ? 'https://open.spotify.com/playlist/'+match[1] : '';
  }
  var api,root,ui={},settings={mappings:{}},loaded=false,saving=false,dialog,taskDialog,editing,configInputs={},message='',scope='';
  function node(tag,text,cls){var n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
  function button(text,fn){var n=node('button',text,'btn');n.type='button';n.addEventListener('click',fn);return n;}
  function fillSelect(select){select.replaceChildren();var auto=node('option','Sugerir según el título');auto.value='';select.append(auto);types.forEach(function(t){var o=node('option',t[1]);o.value=t[0];select.append(o);});}
  function normalize(data){var result={mappings:{}};types.forEach(function(t){var m=data && data.mappings && data.mappings[t[0]] || {};result.mappings[t[0]]={mode:m.mode==='playlist' && playlist(m.url) ? 'playlist' : m.mode==='none' ? 'none' : 'keep',url:playlist(m.url),name:String(m.name || '').slice(0,100)};});return result;}
  function refresh(){
    if(!api) return;
    var next=api.scope();if(next!==scope){scope=next;loaded=false;settings=normalize({});if(dialog.open)dialog.close();if(taskDialog.open)taskDialog.close();}
    var task=api.tasks().find(function(t){return t.estado==='curso' && !t.pausada && t.cursoDesde;});
    var category=task ? resolve(task) : 'otros', mapping=settings.mappings[category] || {mode:'keep'};
    ui.task.textContent=task ? task.titulo : 'Tu música, a tu ritmo';
    ui.type.textContent=task ? label(category)+(valid(task.actividad) ? '' : ' · sugerido') : 'Empieza una tarea para ver su actividad';
    ui.playlist.textContent=mapping.mode==='playlist' ? mapping.name || 'Playlist elegida' : mapping.mode==='none' ? 'Preferencia: sin música' : 'Mantener tu música actual';
    ui.link.hidden=mapping.mode!=='playlist';if(mapping.url)ui.link.href=mapping.url;else ui.link.removeAttribute('href');
    ui.status.textContent=message || 'Spotify sin conectar · apertura manual';
    ui.configure.disabled=!api.ready() || !loaded || saving;
    ui.manage.disabled=!api.ready() || !loaded || saving;
  }
  function setSettings(data){if(api)scope=api.scope();settings=normalize(data);loaded=true;message='';refresh();}
  function openSettings(){
    if(!loaded || saving) return;
    types.forEach(function(t){var m=settings.mappings[t[0]],f=configInputs[t[0]];f.mode.value=m.mode;f.name.value=m.name;f.url.value=m.url;updateFields(f);});
    ui.configStatus.textContent='';dialog.showModal();
  }
  function updateFields(f){f.name.disabled=f.url.disabled=f.mode.value!=='playlist';}
  function mount(bridge){
    api=bridge;root=bridge.root;scope=api.scope();settings=normalize({});
    var head=node('div',null,'music-head');head.append(node('span','♫','music-symbol'),node('h2','Música y enfoque'));
    ui.configure=button('Configurar',openSettings);ui.configure.classList.add('music-configure');ui.configure.setAttribute('aria-label','Configurar música por actividad');head.append(ui.configure);
    ui.task=node('strong','','music-task');ui.type=node('p','','music-context');ui.playlist=node('p','','music-playlist');
    ui.link=node('a','↗ Abrir playlist en Spotify','music-open');ui.link.target='_blank';ui.link.rel='noopener noreferrer';ui.link.hidden=true;
    ui.status=node('p','','music-status');ui.status.setAttribute('role','status');
    root.classList.add('music-panel');root.append(head,ui.task,ui.type,ui.playlist,ui.link,ui.status);
    dialog=node('dialog',null,'music-dialog');dialog.setAttribute('aria-labelledby','music-title');var title=node('h2','Música por actividad');title.id='music-title';
    dialog.append(title,node('p','Asigna una playlist una sola vez. Por ahora la abrirás manualmente: conectar Spotify será el siguiente paso. No cambiamos ni pausamos tu música.','music-note'));
    types.forEach(function(t){
      var row=node('fieldset',null,'music-mapping'),legend=node('legend',t[1]);row.append(legend);
      var mode=node('select');[['keep','No cambiar mi música'],['none','Sin música'],['playlist','Usar una playlist']].forEach(function(pair){var o=node('option',pair[1]);o.value=pair[0];mode.append(o);});
      var name=node('input');name.type='text';name.maxLength=100;name.placeholder='Nombre para reconocerla';
      var url=node('input');url.type='text';url.placeholder='https://open.spotify.com/playlist/…';
      [[mode,'Qué hacer'],[name,'Nombre de la playlist'],[url,'Enlace o URI de Spotify']].forEach(function(p){var l=node('label',p[1]);l.append(p[0]);row.append(l);});
      var f={mode:mode,name:name,url:url};configInputs[t[0]]=f;mode.addEventListener('change',function(){updateFields(f);});dialog.append(row);
    });
    ui.configStatus=node('p','','music-note');ui.configStatus.setAttribute('role','status');dialog.append(ui.configStatus);
    ui.save=button('Guardar playlists',async function(){
      if(saving)return;var data={mappings:{}};
      for(var t of types){var f=configInputs[t[0]],url=playlist(f.url.value);if(f.mode.value==='playlist' && !url){ui.configStatus.textContent='Introduce un enlace válido de playlist de Spotify para '+t[1]+'.';f.url.focus();return;}data.mappings[t[0]]={mode:f.mode.value,name:f.name.value.trim(),url:url};}
      saving=true;ui.save.disabled=true;ui.close.disabled=true;
      try{await api.save(data);setSettings(data);dialog.close();api.toast('Playlists guardadas. La conexión automática con Spotify aún está pendiente.');}
      catch(e){ui.configStatus.textContent='No se pudieron guardar las playlists. Inténtalo de nuevo.';}
      finally{saving=false;ui.save.disabled=false;ui.close.disabled=false;refresh();}
    });ui.close=button('Cerrar sin guardar',function(){dialog.close();});
    dialog.append(ui.save,ui.close);dialog.addEventListener('cancel',function(e){if(saving)e.preventDefault();});document.body.append(dialog);
    taskDialog=node('dialog',null,'music-dialog activity-dialog');taskDialog.setAttribute('aria-labelledby','activity-title');var taskTitle=node('h2','Tipo de actividad');taskTitle.id='activity-title';
    ui.taskName=node('p');ui.taskSelect=node('select');fillSelect(ui.taskSelect);var l=node('label','Elige el tipo');l.append(ui.taskSelect);
    ui.taskStatus=node('p','','music-note');ui.taskStatus.setAttribute('role','status');
    var saveType=button('Guardar actividad',async function(){
      saveType.disabled=true;ui.typeClose.disabled=true;
      try{await api.updateTask(editing,ui.taskSelect.value);taskDialog.close();}
      catch(e){ui.taskStatus.textContent='No se pudo guardar la actividad. Inténtalo de nuevo.';}
      finally{saveType.disabled=false;ui.typeClose.disabled=false;}
    });ui.typeClose=button('Cancelar',function(){taskDialog.close();});taskDialog.addEventListener('cancel',function(e){if(saveType.disabled)e.preventDefault();});
    taskDialog.append(taskTitle,ui.taskName,l,node('p','La sugerencia usa solo el título. Tu selección manual siempre manda; «Sin clasificar» evita las sugerencias.','music-note'),ui.taskStatus,saveType,ui.typeClose);document.body.append(taskDialog);
    ui.manage=document.getElementById('music-settings');ui.manage.addEventListener('click',openSettings);
    refresh();
  }
  function chip(t){
    var id=resolve(t),b=button(label(id)+(valid(t.actividad) ? '' : id==='otros' ? '' : ' · sugerido'),function(e){
      e.stopPropagation();editing=t.id;ui.taskName.textContent=t.titulo;ui.taskSelect.value=valid(t.actividad) ? t.actividad : '';ui.taskStatus.textContent='';taskDialog.showModal();
    });b.className='activity-chip';b.dataset.activity=id;b.title='Cambiar tipo de actividad';b.setAttribute('aria-label','Cambiar actividad de '+t.titulo);b.addEventListener('keydown',function(e){e.stopPropagation();});return b;
  }
  var exported={types:types,valid:valid,label:label,suggest:suggest,resolve:resolve,playlist:playlist,normalize:normalize,mount:mount,refresh:refresh,setSettings:setSettings,fillSelect:fillSelect,chip:chip};
  global.FicheroActivity=exported;
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
})(typeof window!=='undefined' ? window : globalThis);
