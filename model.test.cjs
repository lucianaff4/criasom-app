const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Read as an ES module without requiring package.json or a build step.
const model = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, 'dist/model.js')).toString('base64'));
const schedule = (id = 's1') => ({ id, courseId: 'dap', moduleId: 'm3', practiceId: 'route', date: '2026-10-14', time: '19:30', minutes: 10 });
const practice = (id = 'p1') => ({ id, courseId: 'dap', moduleId: 'm3', practiceId: 'route', sessionId: 's1', minutes: 10 });
function fakeStorage(initial = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_, next) => { value = next; }, value: () => value };
}

test('planning and explicit rescheduling are immutable and do not accumulate overdue debt', async () => {
  const m = await model;
  const empty = m.emptyState();
  const state = m.planSession(empty, schedule());
  assert.equal(empty.sessions.length, 0);
  assert.equal(m.sessionTiming(state.sessions[0], '2026-10-16'), 'past');
  assert.equal(state.sessions.length, 1);
  const moved = m.rescheduleSession(state, 's1', { date: '2026-10-17', time: '09:00', minutes: 15 });
  assert.equal(moved.sessions.length, 1);
  assert.equal(moved.sessions[0].id, 's1');
  assert.equal(moved.sessions[0].minutes, 15);
  assert.equal(state.sessions[0].date, '2026-10-14');
  assert.equal(m.sessionTiming(moved.sessions[0], '2026-10-17'), 'today');
  assert.equal(m.sessionTiming(moved.sessions[0], '2026-10-16'), 'future');
});

test('invalid real dates, times, fractional durations and duplicate session IDs are rejected', async () => {
  const m = await model;
  for (const input of [{ date: '2026-02-29' }, { date: '2026-04-31' }, { time: '24:00' }, { minutes: 0 }, { minutes: 1.5 }]) {
    assert.throws(() => m.planSession(m.emptyState(), { ...schedule(), ...input }));
  }
  assert.equal(m.isValidDate('2028-02-29'), true);
  assert.throws(() => m.planSession(m.planSession(m.emptyState(), schedule()), schedule()));
});

test('partial practice can resume after reload without losing steps, time, or self-report history', async () => {
  const m = await model;
  const storage = fakeStorage();
  const a = m.createStore({ storage });
  a.transact(state => m.startPractice(m.planSession(state, schedule()), practice()));
  a.transact(state => m.updatePractice(state, 'p1', { elapsedSeconds: 125, stepIndex: 2 }));
  const finished = a.transact(state => m.completePractice(state, 'p1', { outcome: 'partial', selfReport: 'Preciso repetir a troca de cordas.' }));
  assert.equal(finished.ok, true);
  assert.equal(finished.state.sessions[0].status, 'completed');
  assert.equal(finished.state.sessions[0].outcome, 'partial');
  assert.equal(m.sessionTiming(finished.state.sessions[0], '2026-10-20'), 'completed');
  const reopened = m.createStore({ storage });
  const resumed = reopened.transact(state => m.resumePractice(state, 'p1'));
  assert.equal(resumed.state.practices[0].elapsedSeconds, 125);
  assert.equal(resumed.state.practices[0].stepIndex, 2);
  assert.equal(resumed.state.practices[0].status, 'active');
  assert.equal(resumed.state.practices[0].attempts[0].outcome, 'partial');
  assert.equal(resumed.state.practices[0].selfReport, 'Preciso repetir a troca de cordas.');
  assert.equal(resumed.state.sessions.length, 1);
  const done = reopened.transact(state => m.completePractice(state, 'p1', { outcome: 'complete', selfReport: 'Mais confortável hoje.' }));
  assert.equal(done.state.practices[0].attempts.length, 2);
  assert.equal(done.state.practices[0].outcome, 'complete');
  assert.equal('mastered' in done.state.practices[0], false);
  assert.equal('skillLevel' in done.state.practices[0], false);
});

test('repeat is a self-report; repeating does not insert obligations and deleting schedule preserves practice', async () => {
  const m = await model;
  let state = m.startPractice(m.planSession(m.emptyState(), schedule()), practice());
  state = m.completePractice(state, 'p1', { outcome: 'repeat' });
  assert.equal(state.sessions.length, 1);
  assert.equal(state.practices[0].outcome, 'repeat');
  state = m.resumePractice(state, 'p1');
  state = m.deleteSession(state, 's1');
  assert.equal(state.sessions.length, 0);
  assert.equal(state.practices.length, 1);
  assert.equal(state.practices[0].sessionId, null);
  assert.equal(state.practices[0].attempts.length, 1);
});

test('two tabs read the latest revision on every operation; stale timer cannot reduce progress', async () => {
  const m = await model;
  const storage = fakeStorage();
  const a = m.createStore({ storage });
  const b = m.createStore({ storage });
  b.read();
  a.transact(state => m.startPractice(m.planSession(state, schedule()), practice()));
  a.transact(state => m.updatePractice(state, 'p1', { elapsedSeconds: 120 }));
  const result = b.transact(state => m.updatePractice(state, 'p1', { elapsedSeconds: 80 }));
  assert.equal(result.state.revision, 3);
  assert.equal(result.state.practices[0].elapsedSeconds, 120);
  assert.equal(a.read().state.revision, 3);
  assert.equal(a.read().state.sessions.length, 1);
});

test('a stale whole-state replacement is rejected without replacing newer data', async () => {
  const m = await model;
  const storage = fakeStorage();
  const a = m.createStore({ storage });
  const old = a.read().state;
  a.transact(state => m.planSession(state, schedule()));
  const result = a.transact(() => old);
  assert.equal(result.ok, false);
  assert.equal(result.state.revision, 1);
  assert.equal(JSON.parse(storage.value()).sessions.length, 1);
});

test('a concurrent write detected before save replays the operation against the newer state', async () => {
  const m = await model;
  const storage = fakeStorage();
  const a = m.createStore({ storage });
  const b = m.createStore({ storage });
  let called = 0;
  const result = a.transact(state => {
    if (called++ === 0) b.transact(current => m.planSession(current, schedule('other-tab')));
    return m.planSession(state, { ...schedule('this-tab'), time: '20:00' });
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.revision, 2);
  assert.deepEqual(result.state.sessions.map(item => item.id), ['other-tab', 'this-tab']);
});

test('corrupt or future-version data is preserved; new progress is explicitly unsaved memory', async () => {
  const m = await model;
  for (const raw of ['{broken', JSON.stringify({ ...m.emptyState(), schemaVersion: 99 })]) {
    const storage = fakeStorage(raw);
    const store = m.createStore({ storage });
    const initial = store.read();
    assert.equal(initial.persisted, false);
    assert.ok(initial.warning);
    const result = store.transact(state => m.planSession(state, schedule()));
    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.ok(result.warning);
    assert.equal(store.read().state.sessions.length, 1);
    assert.equal(storage.value(), raw);
  }
});

test('unavailable storage and full quota never claim persistence; memory changes survive reread', async () => {
  const m = await model;
  for (const storage of [null, { getItem: () => null, setItem: () => { throw Error('quota'); } }, { getItem: () => { throw Error('blocked'); }, setItem() {} }]) {
    const store = m.createStore({ storage });
    const result = store.transact(state => m.planSession(state, schedule()));
    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.ok(result.warning);
    assert.equal(store.read().state.sessions.length, 1);
    assert.equal(store.read().persisted, false);
  }
});

test('failed operations do not write or advance revision; duplicate completion is rejected', async () => {
  const m = await model;
  const storage = fakeStorage();
  const store = m.createStore({ storage });
  store.transact(state => m.startPractice(m.planSession(state, schedule()), practice()));
  store.transact(state => m.completePractice(state, 'p1', { outcome: 'complete' }));
  const before = storage.value();
  const result = store.transact(state => m.completePractice(state, 'p1', { outcome: 'complete' }));
  assert.equal(result.ok, false);
  assert.equal(storage.value(), before);
  assert.equal(result.state.revision, 2);
  assert.throws(() => m.resumePractice(result.state, 'p1'));
});

test('schedule/practice course mismatch cannot mix progress between courses', async () => {
  const m = await model;
  const state = m.planSession(m.emptyState(), schedule());
  assert.throws(() => m.startPractice(state, { ...practice(), courseId: 'another-course' }));
  assert.throws(() => m.startPractice(state, { ...practice(), moduleId: 'm4' }));
});

test('individual practice attempts retain real dates after a later-day resumption', async () => {
  const m = await model;
  const storage = fakeStorage();
  let now = '2026-10-13T19:00:00.000Z';
  const store = m.createStore({ storage, now: () => now });
  store.transact(state => m.startPractice(m.planSession(state, schedule()), practice()));
  now = '2026-10-13T19:05:00.000Z';
  const partial = store.transact(state => m.completePractice(state, 'p1', { outcome: 'partial' }));
  const historicalSession = JSON.stringify(partial.state.sessions[0]);
  now = '2026-10-14T19:00:00.000Z';
  store.transact(state => m.resumePractice(state, 'p1'));
  now = '2026-10-14T19:10:00.000Z';
  const result = store.transact(state => m.completePractice(state, 'p1', { outcome: 'complete' }));
  const saved = result.state.practices[0];
  assert.equal(saved.createdAt, '2026-10-13T19:00:00.000Z');
  assert.equal(saved.completedAt, '2026-10-14T19:10:00.000Z');
  assert.equal(saved.attempts[0].recordedAt, '2026-10-13T19:05:00.000Z');
  assert.equal(saved.attempts[1].recordedAt, '2026-10-14T19:10:00.000Z');
  assert.equal(saved.sessionId, null);
  assert.equal(JSON.stringify(result.state.sessions[0]), historicalSession);
  assert.equal(result.state.sessions[0].outcome, 'partial');
});

test('planned overlaps are rejected, adjacent sessions and completed slots are allowed', async () => {
  const m = await model;
  let state = m.planSession(m.emptyState(), { ...schedule(), time: '19:00', minutes: 30 });
  assert.throws(() => m.planSession(state, { ...schedule('s2'), time: '19:15', minutes: 10 }), /horário/);
  assert.throws(() => m.planSession(state, { ...schedule('s2'), time: '18:55', minutes: 10 }), /horário/);
  assert.throws(() => m.planSession(state, { ...schedule('s2'), time: '18:30', minutes: 90 }), /horário/);
  state = m.planSession(state, { ...schedule('s2'), time: '19:30', minutes: 15 });
  state = m.planSession(state, { ...schedule('s3'), time: '18:45', minutes: 15 });
  assert.equal(state.sessions.length, 3);
  state = m.completePractice(m.startPractice(state, practice()), 'p1', { outcome: 'partial' });
  state = m.planSession(state, { ...schedule('s4'), time: '19:00', minutes: 30 });
  assert.equal(state.sessions.length, 4);
});

test('reschedule excludes its own slot and rejects new overlap without changing source', async () => {
  const m = await model;
  let state = m.planSession(m.emptyState(), { ...schedule(), time: '19:00', minutes: 30 });
  state = m.planSession(state, { ...schedule('s2'), time: '20:00', minutes: 30 });
  const unchanged = m.rescheduleSession(state, 's1', { time: '19:00' });
  assert.equal(unchanged.sessions[0].time, '19:00');
  assert.throws(() => m.rescheduleSession(state, 's1', { time: '19:45' }), /horário/);
  assert.equal(state.sessions[0].time, '19:00');
  const adjacent = m.rescheduleSession(state, 's1', { time: '19:30' });
  assert.equal(adjacent.sessions[0].time, '19:30');
});

test('collisions spanning midnight, month end and year end are detected in either direction', async () => {
  const m = await model;
  for (const [first, second] of [['2026-10-14', '2026-10-15'], ['2026-10-31', '2026-11-01'], ['2026-12-31', '2027-01-01']]) {
    const late = { ...schedule(), date: first, time: '23:50', minutes: 30 };
    const early = { ...schedule('s2'), date: second, time: '00:05', minutes: 10 };
    const state = m.planSession(m.emptyState(), late);
    assert.throws(() => m.planSession(state, early), /horário/);
    assert.throws(() => m.planSession(m.planSession(m.emptyState(), early), late), /horário/);
    assert.equal(m.planSession(state, { ...early, time: '00:20' }).sessions.length, 2);
    const later = m.planSession(state, { ...early, time: '10:00' });
    assert.throws(() => m.rescheduleSession(later, 's2', { time: '00:10' }), /horário/);
  }
});

test('explicit completed-practice resume starts a new budget and preserves cumulative progress', async () => {
  const m = await model;
  let state = m.startPractice(m.planSession(m.emptyState(), schedule()), practice());
  assert.equal(state.practices[0].budgetStartSeconds, 0);
  state = m.updatePractice(state, 'p1', { elapsedSeconds: 590, stepIndex: 2 });
  state = m.completePractice(state, 'p1', { outcome: 'partial', selfReport: 'Retomar amanhã.' });
  const resumed = m.resumePractice(state, 'p1', { minutes: 15 });
  const run = resumed.practices[0];
  assert.equal(run.minutes, 15);
  assert.equal(run.elapsedSeconds, 590);
  assert.equal(run.budgetStartSeconds, 590);
  assert.equal(run.minutes * 60 - (run.elapsedSeconds - run.budgetStartSeconds), 900);
  assert.equal(run.stepIndex, 2);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.sessionId, null);
  assert.equal(resumed.sessions[0].outcome, 'partial');
  const afterMinute = m.updatePractice(resumed, 'p1', { elapsedSeconds: 650 });
  const pausedAndReopened = m.resumePractice(afterMinute, 'p1');
  assert.strictEqual(pausedAndReopened, afterMinute);
  assert.equal(pausedAndReopened.practices[0].budgetStartSeconds, 590);
  assert.equal(pausedAndReopened.practices[0].minutes, 15);
  assert.equal(pausedAndReopened.practices[0].elapsedSeconds, 650);
  const newBlock = m.resumePractice(afterMinute, 'p1', { minutes: 30 });
  assert.equal(newBlock.practices[0].budgetStartSeconds, 650);
  assert.equal(newBlock.practices[0].minutes, 30);
  assert.equal(newBlock.practices[0].elapsedSeconds, 650);
  assert.equal(newBlock.practices[0].stepIndex, 2);
  assert.equal(newBlock.practices[0].attempts.length, 1);
  assert.throws(() => m.resumePractice(state, 'p1', { minutes: 0 }));
});

test('active practice explicit time choice renews budget but keeps its current planned session', async () => {
  const m = await model;
  let state = m.startPractice(m.planSession(m.emptyState(), schedule()), practice());
  state = m.updatePractice(state, 'p1', { elapsedSeconds: 100, stepIndex: 1 });
  const renewed = m.resumePractice(state, 'p1', { minutes: 10 });
  assert.equal(renewed.practices[0].budgetStartSeconds, 100);
  assert.equal(renewed.practices[0].elapsedSeconds, 100);
  assert.equal(renewed.practices[0].sessionId, 's1');
  assert.equal(renewed.sessions[0].status, 'planned');
  assert.equal(renewed.practices[0].stepIndex, 1);
  assert.throws(() => m.resumePractice(state, 'p1', { minutes: 0 }));
});

test('legacy records without budget offset remain valid; impossible budget offsets are rejected', async () => {
  const m = await model;
  const state = m.startPractice(m.planSession(m.emptyState(), schedule()), practice());
  delete state.practices[0].budgetStartSeconds;
  assert.doesNotThrow(() => m.validateState(state));
  for (const invalid of [-1, 1, 0.5, null, '0']) {
    state.practices[0].budgetStartSeconds = invalid;
    assert.throws(() => m.validateState(state));
  }
  state.practices[0].budgetStartSeconds = 0;
  assert.doesNotThrow(() => m.validateState(state));
});

test('study clock carries time between practices without copying it into a new practice', async () => {
  const m=await model;
  let s=m.startPractice(m.emptyState(),{...practice(),sessionId:null});
  s=m.updatePractice(s,'p1',{elapsedSeconds:90});
  s=m.startStudyClock(s,{id:'clock1',minutes:10,carrySeconds:90});
  s=m.completePractice(s,'p1',{outcome:'complete'});
  s=m.startPractice(s,{...practice(),id:'p2',practiceId:'another',sessionId:null});
  s=m.startStudyClock(s,{id:'unwanted-reset',minutes:30});
  s=m.updatePractice(s,'p2',{elapsedSeconds:35});
  assert.equal(s.studyClock.id,'clock1');assert.equal(s.studyClock.minutes,10);
  assert.equal(m.totalPracticeSeconds(s)-s.studyClock.baselineSeconds,125);
  assert.equal(s.practices[0].elapsedSeconds,90);assert.equal(s.practices[1].elapsedSeconds,35);
  assert.doesNotThrow(()=>m.validateState(s));
});

test('explicit clock reset and goal adjustment preserve all practice history', async () => {
  const m=await model;
  let s=m.startPractice(m.emptyState(),{...practice(),sessionId:null});
  s=m.updatePractice(s,'p1',{elapsedSeconds:120});
  s=m.startStudyClock(s,{id:'clock1',minutes:10,carrySeconds:120});
  const prior=JSON.stringify(s.practices);
  s=m.setStudyClockMinutes(s,15);
  assert.equal(m.totalPracticeSeconds(s)-s.studyClock.baselineSeconds,120);
  s=m.startStudyClock(s,{id:'clock2',minutes:7},{restart:true});
  assert.equal(s.studyClock.baselineSeconds,120);assert.equal(s.studyClock.minutes,7);
  assert.equal(JSON.stringify(s.practices),prior);
  s=m.updatePractice(s,'p1',{elapsedSeconds:150});
  assert.equal(m.totalPracticeSeconds(s)-s.studyClock.baselineSeconds,30);
  assert.doesNotThrow(()=>m.validateState(s));
});

test('legacy state accepts optional clock; corrupt clock cannot overwrite saved progress', async () => {
  const m=await model;const s=m.emptyState();
  assert.doesNotThrow(()=>m.validateState(s));
  for(const clock of [null,{id:'c',minutes:10,baselineSeconds:1},{id:'c',minutes:0,baselineSeconds:0},{id:'c',minutes:10,baselineSeconds:-1}])assert.throws(()=>m.validateState({...s,studyClock:clock}));
  assert.throws(()=>m.startStudyClock(s,{id:'c',minutes:10,carrySeconds:1}));
});
