'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '..', 'nightly.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const failure = status => Object.assign(new Error(`Google ${status}`), { status });

function fixture(options = {}) {
  let now = Date.parse(options.now || '2026-10-10T20:30:00-05:00');
  let online = options.online !== false;
  let config = clone(options.config || {});
  let hook = options.hook;
  const calls = [], saves = [], messages = [], plans = {}, events = new Map(), deleted = [];
  let active = 0, maxActive = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const window = { crypto: webcrypto, location: { origin: 'https://example.test', pathname: '/fichero/', hash: '#viejo' } };
  vm.runInNewContext(source, { window, Date: Clock, Intl, Uint8Array, Set });
  const api = {
    read: async () => clone(config),
    save: async patch => { saves.push(clone(patch)); config = { ...config, ...clone(patch) }; },
    getDay: async day => clone(plans[day] || {}),
    connected: () => online,
    changed: (message, error) => messages.push({ message, error }),
    call: async (tool, input) => {
      calls.push({ tool, input: clone(input) });
      active++; maxActive = Math.max(maxActive, active);
      try {
        assert.ok(online, 'no Google calls offline');
        if (hook) {
          const result = await hook(tool, input, { config, events });
          if (result !== undefined) return result;
        }
        if (tool === 'create_event') {
          assert.ok(config.namespace, 'namespace persisted BEFORE creation');
          assert.ok(config.pending.some(j => j.type === 'create'), 'queue persisted BEFORE creation');
          if (events.has(input.id)) throw failure(409);
          events.set(input.id, clone(input));
          return { id: input.id };
        }
        if (tool === 'delete_event') { deleted.push(input.eventId); events.delete(input.eventId); return { ok: true }; }
        if (tool === 'list_event_instances') return { events: [], nextPageToken: null };
        throw new Error(`Unexpected tool ${tool}`);
      } finally { active--; }
    }
  };
  return { nightly: window.FicheroNightly, api, calls, saves, messages, plans, events, deleted,
    mount() { window.FicheroNightly.mount(api); },
    config: () => clone(config), setOnline: v => { online = v; }, setHook: v => { hook = v; },
    setNow: v => { now = Date.parse(v); }, maxActive: () => maxActive };
}

test('mount has no effects; enable is serialized, idempotent and creates four daily Lima series', async () => {
  const f = fixture(); f.mount();
  assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0);
  await Promise.all([f.nightly.enable(), f.nightly.enable(), f.nightly.sync()]);
  const creates = f.calls.filter(c => c.tool === 'create_event');
  assert.equal(creates.length, 4); assert.equal(f.events.size, 4); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.config().pending, []);
  for (const [i, { input }] of creates.entries()) {
    assert.match(input.id, /^[0-9a-v]{5,1024}$/);
    assert.deepEqual(input.recurrence, ['RRULE:FREQ=DAILY']);
    assert.equal(input.timeZone, 'America/Lima');
    assert.equal(input.availability, 'AVAILABILITY_FREE');
    assert.deepEqual(input.overrideReminders, [{ method: 'email', minutes: 0 }, { method: 'popup', minutes: 0 }]);
    assert.equal(input.description, 'https://example.test/fichero/#planificar-manana');
    assert.equal(input.startTime, `2026-10-${i ? '10' : '11'}T${20 + i}:00:00-05:00`);
    assert.equal(Date.parse(input.endTime) - Date.parse(input.startTime), 300000);
  }
});

test('partial creation persists only failed job, retries across module reload', async () => {
  const f = fixture({ hook: (tool, input) => { if (tool === 'create_event' && input.startTime.includes('T22:')) throw failure(503); } });
  f.mount(); await assert.rejects(f.nightly.enable(), /503/);
  assert.equal(f.events.size, 3);
  assert.deepEqual(f.config().pending, [{ type: 'create', hour: 22 }]);
  assert.ok(f.config().lastError);
  const reloaded = fixture({ config: f.config() }); reloaded.mount();
  await reloaded.nightly.sync();
  assert.equal(reloaded.calls.filter(c => c.tool === 'create_event').length, 1);
  assert.equal(Object.keys(reloaded.config().series).length, 4);
  assert.deepEqual(reloaded.config().pending, []);
});

test('409 after uncertain creation is idempotent', async () => {
  const f = fixture({ hook: (tool, input, { events }) => {
    if (tool === 'create_event') { events.set(input.id, input); throw failure(409); }
  } });
  f.mount(); await f.nightly.enable(); await f.nightly.enable();
  assert.equal(f.calls.filter(c => c.tool === 'create_event').length, 4);
  assert.equal(f.config().pending.length, 0);
});

test('failed durable save makes zero Google calls; uncertain remote success retries via 409', async () => {
  const blocked = fixture();
  blocked.api.save = async () => { throw new Error('storage unavailable'); };
  blocked.mount(); await assert.rejects(blocked.nightly.enable(), /storage unavailable/);
  assert.equal(blocked.calls.length, 0);
  const f = fixture();
  const save = f.api.save;
  let failOnce = true;
  f.api.save = async patch => {
    if (failOnce && Object.keys(patch.series).length === 1) {
      failOnce = false; throw new Error('write interrupted');
    }
    return save(patch);
  };
  f.mount(); await assert.rejects(f.nightly.enable(), /write interrupted/);
  assert.equal(f.events.size, 1); assert.equal(f.config().pending.length, 4);
  await f.nightly.sync();
  assert.equal(f.events.size, 4); assert.equal(f.config().pending.length, 0);
  const createdIDs = f.calls.filter(c => c.tool === 'create_event').map(c => c.input.id);
  assert.equal(createdIDs[0], createdIDs[1]);
});

function instance(id, series, start, extra = {}) {
  return { id, recurringEventId: series, start: { dateTime: start }, ...extra };
}

test('finish deletes only future own instances of day-1, paginates, keeps next day and series', async () => {
  const f = fixture(); f.mount(); await f.nightly.enable();
  const ids = Object.values(f.config().series);
  f.setHook((tool, input) => {
    if (tool !== 'list_event_instances') return;
    assert.equal(input.startTime, '2026-10-10T20:00:00-05:00');
    assert.equal(input.endTime, '2026-10-11T00:00:00-05:00');
    if (input.eventId !== ids[0]) return { events: [] };
    if (!input.pageToken) return { events: [
      instance('past', ids[0], '2026-10-10T20:00:00-05:00'),
      instance('future', ids[0], '2026-10-10T21:00:00-05:00'),
      instance('foreign', 'someoneelse', '2026-10-10T21:00:00-05:00'),
      instance(ids[0], ids[0], '2026-10-10T21:00:00-05:00'),
      instance('cancelled', ids[0], '2026-10-10T21:00:00-05:00', { status: 'cancelled' })
    ], nextPageToken: 'two' };
    assert.equal(input.pageToken, 'two');
    return { events: [instance('late', ids[0], '2026-10-11T04:00:00Z'),
      instance('nextday', ids[0], '2026-10-11T21:00:00-05:00')] };
  });
  await f.nightly.finish('2026-10-11');
  assert.deepEqual(f.deleted, ['future', 'late']);
  assert.equal(f.events.size, 4);
  assert.equal(f.calls.filter(c => c.tool === 'list_event_instances').length, 5);
});

test('offline finish is durable and retries when connected; deletion 404/410 succeeds', async () => {
  const f = fixture(); f.mount(); await f.nightly.enable(); f.setOnline(false);
  const before = f.calls.length;
  await assert.rejects(f.nightly.finish('2026-10-11'), { code: 'nightly_pending' });
  assert.equal(f.calls.length, before);
  assert.deepEqual(f.config().pending, [{ type: 'finish', day: '2026-10-11' }]);
  const r = fixture({ config: f.config(), hook: (tool, input) => {
    if (tool === 'list_event_instances') return { events: [instance('gone' + input.eventId, input.eventId, '2026-10-10T22:00:00-05:00')] };
    if (tool === 'delete_event') throw failure(input.eventId.endsWith('14') ? 404 : 410);
  } }); r.mount(); await r.nightly.sync();
  assert.equal(r.calls.filter(c => c.tool === 'delete_event').length, 4);
  assert.deepEqual(r.config().pending, []);
});

test('instance error is retained, reported, and retry can finish', async () => {
  const f = fixture(); f.mount(); await f.nightly.enable();
  f.setHook(tool => { if (tool === 'list_event_instances') throw failure(500); });
  await assert.rejects(f.nightly.finish('2026-10-11'), /500/);
  assert.equal(f.config().pending[0].type, 'finish'); assert.ok(f.messages.at(-1).error);
  f.setHook(undefined); await f.nightly.sync(); assert.deepEqual(f.config().pending, []);
});

test('partial instance deletion failure is never reported as success and retries only pending evening', async () => {
  const f = fixture(); f.mount(); await f.nightly.enable();
  const own = Object.values(f.config().series)[0];
  let failOnce = true;
  const gone = new Set();
  f.setHook((tool, input) => {
    if (tool === 'list_event_instances') return { events: input.eventId === own ? ['one', 'two']
      .filter(id => !gone.has(id)).map(id => instance(id, own, '2026-10-10T22:00:00-05:00')) : [] };
    if (tool === 'delete_event') {
      if (input.eventId === 'two' && failOnce) { failOnce = false; throw failure(403); }
      gone.add(input.eventId);
    }
  });
  await assert.rejects(f.nightly.finish('2026-10-11'), /403/);
  assert.deepEqual(f.deleted, ['one']); assert.equal(f.config().pending.length, 1);
  await f.nightly.sync();
  assert.deepEqual(f.deleted, ['one', 'two']); assert.equal(f.config().pending.length, 0);
});

test('exact starting hour rolls to next day; finish rejects equal-now instances', async () => {
  const f = fixture({ now: '2026-10-10T23:00:00-05:00' }); f.mount();
  await f.nightly.enable();
  assert.ok(f.calls.filter(c => c.tool === 'create_event').every(c => c.input.startTime.startsWith('2026-10-11')));
  f.setHook((tool, input) => {
    if (tool === 'list_event_instances') return { events: [instance('at-now', input.eventId, '2026-10-10T23:00:00-05:00')] };
  });
  await f.nightly.finish('2026-10-11'); assert.deepEqual(f.deleted, []);
});

test('disable deletes only own deterministic series including uncertain creates; partial failure retries', async () => {
  const f = fixture({ hook: (tool, input) => { if (tool === 'create_event' && input.startTime.includes('T22:')) throw failure(503); } });
  f.mount(); await assert.rejects(f.nightly.enable());
  const oldNS = f.config().namespace;
  const own = [20, 21, 22, 23].map(h => 'f1' + oldNS + h.toString(16));
  f.events.set('foreign', {});
  f.setHook((tool, input) => { if (tool === 'delete_event' && input.eventId === own[1]) throw failure(502); });
  await assert.rejects(f.nightly.disable(), /502/);
  assert.deepEqual(f.config().pending, [{ type: 'delete', hour: 21 }]);
  assert.equal(f.config().enabled, false); assert.ok(f.events.has('foreign'));
  assert.ok(f.deleted.every(id => own.includes(id)));
  f.setHook(undefined); await f.nightly.sync();
  assert.equal(f.config().namespace, null); assert.deepEqual(f.config().series, {});
  await f.nightly.enable(); assert.notEqual(f.config().namespace, oldNS);
});

test('offline enable then disable never creates and reconciles tombstones', async () => {
  const f = fixture({ online: false }); f.mount();
  await f.nightly.enable(); assert.equal(f.config().pending.length, 4);
  await f.nightly.disable(); assert.ok(f.config().pending.every(j => j.type === 'delete'));
  // Enable cannot replace unresolved deletions while offline.
  await f.nightly.enable(); assert.equal(f.config().enabled, false);
  f.setOnline(true); f.setHook(tool => { if (tool === 'delete_event') throw failure(404); });
  await f.nightly.sync(); assert.equal(f.config().namespace, null);
  assert.equal(f.calls.filter(c => c.tool === 'create_event').length, 0);
});

test('sync reconciles completed tomorrow and day-after-tomorrow, without snapshots or runaway reads', async () => {
  const f = fixture(); f.mount();
  f.plans['2026-10-11'] = { estado: 'guardado', orden: ['task'] };
  f.plans['2026-10-12'] = { estado: 'omitido', orden: [] };
  await f.nightly.enable();
  const lists = f.calls.filter(c => c.tool === 'list_event_instances');
  assert.equal(lists.length, 8);
  assert.equal(lists.filter(c => c.input.startTime.startsWith('2026-10-10')).length, 4);
  assert.equal(lists.filter(c => c.input.startTime.startsWith('2026-10-11')).length, 4);
});

test('finish waits for failed creations and handles expired evening without Google reads', async () => {
  const f = fixture({ online: false }); f.mount(); await f.nightly.enable();
  await assert.rejects(f.nightly.finish('2026-10-11'), { code: 'nightly_pending' }); f.setOnline(true);
  f.setHook(tool => { if (tool === 'create_event') throw failure(500); });
  await assert.rejects(f.nightly.sync());
  assert.equal(f.calls.filter(c => c.tool === 'list_event_instances').length, 0);
  f.setHook(undefined); f.setNow('2026-10-12T12:00:00-05:00');
  await f.nightly.sync(); assert.deepEqual(f.config().pending, []);
  assert.equal(f.calls.filter(c => c.tool === 'list_event_instances').length, 0);
});

test('repeated page tokens reject and preserve work', async () => {
  const f = fixture(); f.mount(); await f.nightly.enable();
  f.setHook(tool => { if (tool === 'list_event_instances') return { events: [], nextPageToken: 'same' }; });
  await assert.rejects(f.nightly.finish('2026-10-11'), /Paginación/);
  assert.equal(f.config().pending.length, 1);
  assert.equal(f.calls.filter(c => c.tool === 'list_event_instances').length, 2);
});

test('namespace and known IDs validation never allows deletion of a foreign series', async () => {
  const f = fixture({ config: { namespace: 'a'.repeat(32), enabled: true, series: { 20: 'foreign' } } });
  f.mount(); await assert.rejects(f.nightly.disable(), /ID de serie/); assert.equal(f.calls.length, 0);
});

test('dates uses Lima across midnight and host timezone differences', () => {
  const f = fixture();
  assert.deepEqual(clone(f.nightly.dates()), { today: '2026-10-10', tomorrow: '2026-10-11', hour: 20 });
  f.setNow('2026-01-01T00:00:00-05:00');
  assert.deepEqual(clone(f.nightly.dates()), { today: '2026-01-01', tomorrow: '2026-01-02', hour: 0 });
  assert.deepEqual(clone(f.nightly.dates('2026-01-01T04:59:00Z')), { today: '2025-12-31', tomorrow: '2026-01-01', hour: 23 });
  assert.deepEqual(clone(f.nightly.dates('2026-01-01T05:00:00Z')), { today: '2026-01-01', tomorrow: '2026-01-02', hour: 0 });
  const script = `const fs=require('node:fs'),vm=require('node:vm');let window={};vm.runInNewContext(fs.readFileSync(${JSON.stringify(path.join(__dirname, '..', 'nightly.js'))},'utf8'),{window,Intl,Date});process.stdout.write(JSON.stringify(window.FicheroNightly.dates('2026-01-01T04:59:00Z')));`;
  for (const TZ of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { today: '2025-12-31', tomorrow: '2026-01-01', hour: 23 });
  }
  assert.throws(() => f.nightly.finish('2026-02-30'), /Día inválido/);
});

test('idle sync and finish are silent, successful and have no writes or Google calls', async () => {
  for (const online of [true, false]) {
    const f = fixture({ online }); f.mount();
    f.api.getDay = async () => { throw new Error('idle must not query day records'); };
    f.api.save = async () => { throw new Error('idle must not need storage writes'); };
    for (let i = 0; i < 3; i++) {
      const state = await f.nightly.sync(); assert.equal(state.enabled, false);
    }
    const state = await f.nightly.finish('2026-10-11'); assert.equal(state.enabled, false);
    assert.deepEqual(f.messages, []); assert.deepEqual(f.calls, []);
  }
});

test('disabled sync still retries pending deletions, and full plan records are accepted', async () => {
  const f = fixture(); f.mount();
  f.plans['2026-10-11'] = { estado: 'guardado', items: [{ id: 'task', minutes: 45 }], orden: ['task'], capacity: 4 };
  await f.nightly.enable();
  assert.equal(f.calls.filter(c => c.tool === 'list_event_instances').length, 4);
  f.setOnline(false); await f.nightly.disable();
  f.setOnline(true); await f.nightly.sync();
  assert.equal(f.calls.filter(c => c.tool === 'delete_event').length, 4);
  const before = { messages: f.messages.length, saves: f.saves.length, calls: f.calls.length };
  await f.nightly.sync(); await f.nightly.finish('2026-10-11');
  assert.deepEqual({ messages: f.messages.length, saves: f.saves.length, calls: f.calls.length }, before);
});

test('enabled sync with unchanged state has zero writes and notifications', async () => {
  const f = fixture(); f.mount(); await f.nightly.enable();
  const before = { writes: f.saves.length, notices: f.messages.length, calls: f.calls.length };
  await f.nightly.sync(); await f.nightly.sync();
  f.setOnline(false); await f.nightly.sync();
  assert.deepEqual({ writes: f.saves.length, notices: f.messages.length, calls: f.calls.length }, before);
});

test('completed nights survive reload; repeated finish and minute sync have zero writes or Google reads', async () => {
  const f = fixture(); f.mount();
  f.plans['2026-10-11'] = { estado: 'guardado' };
  f.plans['2026-10-12'] = { estado: 'omitido' };
  await f.nightly.enable();
  assert.deepEqual(f.config().completed, { namespace: f.config().namespace, evenings: ['2026-10-10', '2026-10-11'] });
  const r = fixture({ config: f.config() }); r.mount();
  r.api.getDay = async () => { throw new Error('completed nights must skip day lookups'); };
  for (let i = 0; i < 4; i++) {
    await r.nightly.sync(); await r.nightly.finish('2026-10-11'); await r.nightly.finish('2026-10-12');
  }
  await r.nightly.enable(); // No missing series: completion remains valid.
  r.setOnline(false); await r.nightly.finish('2026-10-11');
  assert.deepEqual(r.calls, []); assert.deepEqual(r.saves, []); assert.deepEqual(r.messages, []);
});

test('new namespace or missing series invalidates completion and recancels relevant nights', async () => {
  const f = fixture(); f.mount(); f.plans['2026-10-11'] = { estado: 'guardado' };
  await f.nightly.enable(); const saved = f.config();
  delete saved.series[22];
  const r = fixture({ config: saved }); r.mount(); r.plans['2026-10-11'] = { estado: 'guardado' };
  await r.nightly.enable();
  assert.equal(r.calls.filter(c => c.tool === 'create_event').length, 1);
  assert.equal(r.calls.filter(c => c.tool === 'list_event_instances').length, 4);
  const previous = r.config().namespace;
  await r.nightly.disable(); await r.nightly.enable();
  assert.notEqual(r.config().namespace, previous);
  assert.equal(r.calls.filter(c => c.tool === 'list_event_instances').length, 8);
});

test('pending creations invalidate stale completions before sync reconciles plans', async () => {
  const f = fixture(); f.mount(); await f.nightly.enable(); await f.nightly.finish('2026-10-11');
  const saved = f.config(); delete saved.series[21]; saved.pending.push({ type: 'create', hour: 21 });
  const r = fixture({ config: saved }); r.mount(); r.plans['2026-10-11'] = { estado: 'guardado' };
  let fail = true;
  r.setHook(tool => { if (tool === 'create_event' && fail) throw failure(503); });
  await assert.rejects(r.nightly.sync(), /503/);
  assert.deepEqual(r.config().completed.evenings, []);
  assert.ok(r.config().pending.some(j => j.type === 'finish'));
  assert.equal(r.calls.filter(c => c.tool === 'list_event_instances').length, 0);
  fail = false; await r.nightly.sync();
  assert.equal(r.calls.filter(c => c.tool === 'list_event_instances').length, 4);
  assert.deepEqual(r.config().completed.evenings, ['2026-10-10']);
});

test('completed cache is bounded to 31 nights and failed cancellation never marks completion', async () => {
  const f = fixture(); f.mount(); await f.nightly.enable();
  f.setHook(tool => { if (tool === 'list_event_instances') throw failure(500); });
  await assert.rejects(f.nightly.finish('2026-10-11'), /500/);
  assert.deepEqual(f.config().completed.evenings, []);
  f.setHook(undefined); await f.nightly.sync();
  for (let offset = 1; offset < 36; offset++) {
    const day = new Date(Date.parse('2026-10-10T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    f.setNow(day + 'T12:00:00-05:00'); await f.nightly.finish(tomorrow);
  }
  assert.equal(f.config().completed.evenings.length, 31);
  assert.equal(f.config().completed.evenings[0], '2026-10-15');
  const before = f.saves.length; await f.nightly.finish('2026-10-11');
  assert.equal(f.saves.length, before, 'expired evening also does not enqueue or write');
});
