const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.TZ = 'America/Lima';
const g = { localStorage: { getItem() { return null; }, setItem() {} } };
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'calendar.js'), 'utf8'))(g);
const C = g.FicheroCalendar._test;
const ev = (id, a, b) => ({ id, start: { dateTime: a }, end: { dateTime: b } });

test('rangos de día, semana (lunes a domingo) y mes (6 semanas)', () => {
  assert.deepEqual(C.rango('dia', '2026-11-08'), { desde: '2026-11-08', hasta: '2026-11-08' });
  assert.deepEqual(C.rango('semana', '2026-11-08'), { desde: '2026-11-02', hasta: '2026-11-08' });
  const m = C.rango('mes', '2026-11-20');
  assert.equal(m.desde, '2026-10-26'); assert.equal(m.hasta, '2026-12-06');
});

test('los eventos solapados se reparten en columnas', () => {
  const r = C.distribuir([
    ev('a', '2026-11-08T09:00:00-05:00', '2026-11-08T10:00:00-05:00'),
    ev('b', '2026-11-08T09:30:00-05:00', '2026-11-08T11:00:00-05:00'),
    ev('c', '2026-11-08T12:00:00-05:00', '2026-11-08T13:00:00-05:00'),
  ], '2026-11-08');
  const by = Object.fromEntries(r.map(i => [i.ev.id, i]));
  assert.equal(by.a.cols, 2); assert.equal(by.b.cols, 2);
  assert.notEqual(by.a.col, by.b.col);
  assert.equal(by.c.cols, 1); assert.equal(by.c.ini, 720);
});

test('un evento que cruza medianoche se recorta a cada día', () => {
  const e = ev('n', '2026-11-08T22:00:00-05:00', '2026-11-09T02:00:00-05:00');
  assert.deepEqual(C.distribuir([e], '2026-11-08').map(i => [i.ini, i.fin]), [[1320, 1440]]);
  assert.deepEqual(C.distribuir([e], '2026-11-09').map(i => [i.ini, i.fin]), [[0, 120]]);
});

test('días completos: el fin es exclusivo', () => {
  const t = C.tiempos({ start: { date: '2026-11-08' }, end: { date: '2026-11-10' } });
  assert.ok(t.todoDia);
  assert.ok(C.tocaDia(t, '2026-11-08')); assert.ok(C.tocaDia(t, '2026-11-09'));
  assert.ok(!C.tocaDia(t, '2026-11-10'));
});

test('solo se editan los eventos propios', () => {
  assert.ok(C.editable({}));
  assert.ok(C.editable({ organizer: { self: true } }));
  assert.ok(!C.editable({ organizer: { email: 'otra@x.com' } }));
});
