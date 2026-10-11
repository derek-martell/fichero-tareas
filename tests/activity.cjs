'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const activity=require('../activity.js');
test('sugerencias sin IA por título, con tildes y sin coincidencias parciales',()=>{
  for(const [title,id] of [['Leer bibliografía','lectura'],['Redactar capítulo 2','escritura'],['Limpieza de microdatos ENAHO','analisis'],['Practicar ejercicios','repaso'],['Planificar agenda','organizacion'],['Reunión Meet','reunion'],['Comprar cuaderno','otros'],['Relectura de resultados','otros']])assert.equal(activity.suggest(title),id,title);
});
test('ambigüedad no fuerza clasificación y proyecto no decide',()=>{
  assert.equal(activity.suggest('Leer y escribir'),'otros');
  assert.equal(activity.resolve({titulo:'Comprar café',proyecto:'Programación'}),'otros');
});
test('elección manual incluida sin clasificar manda y permite volver a automático',()=>{
  assert.equal(activity.resolve({titulo:'Leer',actividad:'analisis'}),'analisis');
  assert.equal(activity.resolve({titulo:'Leer',actividad:'otros'}),'otros');
  assert.equal(activity.resolve({titulo:'Leer',actividad:''}),'lectura');
  assert.equal(activity.resolve({titulo:'Leer',actividad:'invalid'}),'lectura');
});
test('playlists permiten solo Spotify HTTPS o URI, nunca URLs arbitrarias',()=>{
  const id='37i9dQZF1DWZeKCadgRdKQ';
  const url='https://open.spotify.com/playlist/'+id;
  for(const input of [url+'?si=abc','spotify:playlist:'+id,'https://open.spotify.com/intl-es/playlist/'+id])assert.equal(activity.playlist(input),url);
  for(const input of ['javascript:alert(1)','https://evil.test/playlist/'+id,'https://open.spotify.com.evil.test/playlist/'+id,'http://open.spotify.com/playlist/'+id,'https://open.spotify.com/track/'+id,'spotify:playlist:fake'])assert.equal(activity.playlist(input),'');
});
test('configuración incompleta o corrupta no activa música ni inventa conexión',()=>{
  const config=activity.normalize({mappings:{lectura:{mode:'playlist',url:'javascript:bad'},reunion:{mode:'none'}}});
  assert.equal(config.mappings.lectura.mode,'keep');
  assert.equal(config.mappings.reunion.mode,'none');
  assert.equal(config.mappings.otros.mode,'keep');
});
