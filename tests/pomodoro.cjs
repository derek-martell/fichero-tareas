'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../pomodoro.js');
function fixture() {
  let time = 1000000, scope = 'alice';
  const data = new Map();
  const storage = { getItem: k => data.get(k) || null, setItem: (k, v) => data.set(k, v) };
  const options = { now: () => time, scope: () => scope, storage };
  return { engine: createEngine(options), data, reload: () => createEngine(options),
    advance: ms => { time += ms; }, scope: uid => { scope = uid; } };
}
test('defaults, deadline, idempotent start, pause and resume survive reload', () => {
  const f = fixture(), e = f.engine;
  assert.deepEqual(e.snapshot().config, { focus: 25, short: 5, long: 15 });
  const deadline = e.start().deadline;
  f.advance(120000); assert.equal(e.start().deadline, deadline);
  assert.equal(e.pause().remaining, 1380000);
  f.advance(9000000);
  assert.equal(f.reload().snapshot().remaining, 1380000);
  assert.equal(e.start().remaining, 1380000);
  f.advance(1300000); assert.equal(f.reload().snapshot().remaining, 80000);
  assert.equal(e.pause().remaining, 80000);
});
test('expired reload counts once, stays stopped and starts the next phase only manually', () => {
  const f = fixture(); f.engine.start(); f.advance(86400000);
  let e = f.reload(), s = e.snapshot();
  assert.equal(s.status, 'complete'); assert.equal(s.remaining, 0); assert.equal(s.rounds, 1);
  assert.equal(s.phase, 'focus'); assert.equal(s.nextPhase, 'short');
  for (let i = 0; i < 5; i++) { e = f.reload(); assert.equal(e.snapshot().rounds, 1); }
  assert.equal(e.start().phase, 'short'); f.advance(300000);
  assert.equal(e.snapshot().rounds, 1); assert.equal(e.snapshot().nextPhase, 'focus');
});
test('four completed focus rounds select the long break; skips and resets earn nothing', () => {
  const f = fixture(), e = f.engine;
  e.start(); f.advance(10000); e.reset(); assert.equal(e.snapshot().rounds, 0);
  assert.equal(e.skip().phase, 'short'); assert.equal(e.skip().phase, 'focus');
  for (let i = 1; i <= 4; i++) {
    e.start(); f.advance(1500000);
    assert.equal(e.snapshot().rounds, i);
    assert.equal(e.snapshot().nextPhase, i === 4 ? 'long' : 'short');
    e.start(); f.advance((i === 4 ? 15 : 5) * 60000);
    assert.equal(e.snapshot().rounds, i); e.start(); e.reset();
  }
  assert.equal(e.snapshot().phase, 'focus'); assert.equal(e.snapshot().rounds, 4);
});
test('configuration bounds, running and paused duration remain consistent', () => {
  const f = fixture(), e = f.engine;
  for (const invalid of [0, 181, 1.5, NaN, '5']) {
    assert.throws(() => e.configure({ focus: invalid, short: 5, long: 15 }), RangeError);
  }
  e.configure({ focus: 1, short: 180, long: 15 }); assert.equal(e.snapshot().remaining, 60000);
  e.start(); f.advance(10000);
  e.configure({ focus: 180, short: 1, long: 1 }); assert.equal(e.snapshot().remaining, 50000);
  e.pause(); e.configure({ focus: 2, short: 1, long: 1 }); assert.equal(e.snapshot().remaining, 50000);
  assert.equal(e.reset().remaining, 120000); assert.equal(e.snapshot().rounds, 0);
});
test('scope isolates timers, config, sound and counts, including expired previous users', () => {
  const f = fixture(), e = f.engine;
  e.configure({ focus: 1, short: 2, long: 3 }); e.setSound(true); e.start();
  f.scope('bob'); let s = e.snapshot();
  assert.equal(s.status, 'idle'); assert.equal(s.rounds, 0); assert.equal(s.sound, false);
  assert.equal(s.config.focus, 25);
  e.start(); f.advance(61000);
  f.scope('alice'); assert.equal(e.snapshot().rounds, 1); assert.equal(e.snapshot().status, 'complete');
  f.scope('bob'); assert.equal(e.snapshot().rounds, 0); assert.equal(e.snapshot().remaining, 1439000);
  f.scope(null); assert.equal(e.snapshot().scope, 'local'); assert.equal(e.snapshot().status, 'idle');
});
test('reset and skip before expiry do not create focus rounds; expiry boundary is real completion', () => {
  const f = fixture(), e = f.engine;
  e.start(); f.advance(1499999); e.reset(); assert.equal(e.snapshot().rounds, 0);
  e.start(); f.advance(1499999); e.skip(); assert.equal(e.snapshot().rounds, 0);
  e.skip(); e.start(); f.advance(1500000); e.pause();
  assert.equal(e.snapshot().rounds, 1); assert.equal(e.snapshot().status, 'complete');
  e.reset(); assert.equal(e.snapshot().rounds, 1);
});
test('malformed storage recovers; failed persistence does not break the timer', () => {
  const f = fixture(); f.data.set('fichero-pomodoro:v1:alice', '{');
  assert.equal(f.engine.snapshot().status, 'idle');
  const broken = createEngine({ storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } } });
  assert.equal(broken.start().status, 'running'); assert.equal(broken.snapshot().storageError, true);
  assert.equal(broken.pause().status, 'paused');
  const bad = f.engine.snapshot(); bad.status = 'running'; bad.deadline = null;
  f.data.set('fichero-pomodoro:v1:alice', JSON.stringify(bad));
  assert.equal(f.reload().snapshot().status, 'idle');
});
test('storage refresh reads another tab before settling a stale expired deadline', () => {
  const f = fixture(), first = f.engine;
  first.start(); const second = f.reload(); second.snapshot();
  f.advance(1500000); first.snapshot(); first.start();
  const s = second.reload();
  assert.equal(s.phase, 'short'); assert.equal(s.status, 'running'); assert.equal(s.rounds, 1);
  s.rounds = 99;
  assert.equal(second.snapshot().rounds, 1, 'snapshots cannot mutate the engine');
});
