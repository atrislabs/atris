'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { ninetyNineAtris } = require('../commands/ninety-nine');
const {
  foldSessions, parseSessionLog, sessionsToday, runningSession, sessionStatus,
  automaticEndRecord, pauseRecord, resumeRecord, activeMilliseconds, endRecord,
} = require('../lib/ninety-nine');

const cli = path.resolve(__dirname, '../bin/atris.js');
const minute = 60000;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-99-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'private', 'sessions.jsonl');
  let time = new Date(2026, 9, 23, 12, 0, 0);
  return {
    dir,
    logPath,
    setTime(value) { time = new Date(value); },
    advance(minutes) { time = new Date(time.getTime() + minutes * minute); },
    now() { return new Date(time); },
    text() { return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''; },
    records() { return parseSessionLog(this.text()); },
    seed(records, trailingNewline = true) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, records.map((record) => JSON.stringify(record)).join('\n') + (trailingNewline ? '\n' : ''));
    },
    run(...args) {
      const lines = [];
      const code = ninetyNineAtris(args, { logPath, now: () => new Date(time), log: (line) => lines.push(line) });
      return { code, output: lines.join('\n') };
    },
    env() {
      return { ...process.env, HOME: dir, ATRIS_99_LOG: logPath };
    },
    cli(...args) {
      const result = spawnSync(process.execPath, [cli, '99', ...args], {
        cwd: dir, env: this.env(), encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

function start(at, { id = '11111111-1111-4111-8111-111111111111', kind = 'focus', minutes = 25, source = 'mac' } = {}) {
  return { v: 1, type: 'start', id, kind, planned_min: minutes, at: at.toISOString(), source };
}

function event(type, session, at, extra = {}) {
  return { v: 1, type, id: session.id, at: at.toISOString(), source: 'mac', ...extra };
}

test('every allowed length writes the exact start and end contract with a unique uuid', (t) => {
  const f = fixture(t);
  const ids = new Set();
  for (const [kind, lengths] of [['focus', [25, 50, 90]], ['meditate', [10, 20, 30]]]) {
    for (const length of lengths) {
      const began = f.now().toISOString();
      const previous = f.text();
      assert.deepEqual(f.run(kind, String(length)), { code: 0, output: `${kind} started for ${length} minutes` });
      const record = f.records().at(-1);
      assert.deepEqual(record, { v: 1, type: 'start', id: record.id, kind, planned_min: length, at: began, source: 'cli' });
      assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.ok(!ids.has(record.id));
      ids.add(record.id);
      assert.ok(f.text().startsWith(previous));
      f.advance(length);
      assert.equal(f.run('stop').code, 0);
      assert.deepEqual(f.records().at(-1), { v: 1, type: 'end', id: record.id, status: 'done', at: f.now().toISOString(), source: 'cli' });
    }
  }
});

test('unsupported lengths and extra arguments fail on one line without writing', (t) => {
  const f = fixture(t);
  for (const kind of ['focus', 'meditate']) {
    const invalid = ['', '0', '-1', '1', '15', '45', '120', '25.0', '025', '2.5e1', 'Infinity', 'NaN', 'twenty', ' 25 '];
    invalid.push(...(kind === 'focus' ? ['10', '20', '30'] : ['25', '50', '90']));
    for (const length of invalid) {
      const result = f.run(kind, length);
      assert.equal(result.code, 2, `${kind} ${length}`);
      assert.equal(result.output.split('\n').length, 1);
      assert.match(result.output, /choose/);
      assert.equal(f.text(), '');
    }
    assert.equal(f.run(kind).code, 2);
    assert.equal(f.run(kind, kind === 'focus' ? '25' : '10', '--json').code, 2);
  }
});

test('a second start of either kind is refused and leaves the first untouched', (t) => {
  const f = fixture(t);
  for (const kind of ['focus', 'meditate']) {
    assert.equal(f.run(kind, kind === 'focus' ? '25' : '10').code, 0);
    const before = f.text();
    for (const args of [['focus', '90'], ['meditate', '30']]) {
      const result = f.run(...args);
      assert.equal(result.code, 1);
      assert.match(result.output, /^a session is already running;.*$/);
      assert.equal(f.text(), before);
    }
    f.run('stop');
  }
});

test('stop just before the planned end is partial, earns nothing, and normalizes the optional note', (t) => {
  const f = fixture(t);
  f.run('focus', '25');
  const id = f.records()[0].id;
  f.advance(25);
  f.setTime(f.now().getTime() - 1);
  const before = f.text();
  assert.deepEqual(f.run('stop', 'phone\n rang', '  back\r\nlater  '), { code: 0, output: 'focus partial: 0 finished minutes' });
  assert.deepEqual(f.records()[1], { v: 1, type: 'end', id, status: 'partial', at: f.now().toISOString(), source: 'cli', note: 'phone rang back later' });
  assert.ok(f.text().startsWith(before));
  assert.equal(JSON.parse(f.run('today', '--json').output).finished_minutes, 0);
});

test('stop at or after the planned end is done at the planned timestamp and keeps the note', (t) => {
  for (const delay of [0, 1, 60]) {
    const f = fixture(t);
    f.run('meditate', '20');
    const expected = new Date(f.now().getTime() + 20 * minute).toISOString();
    f.advance(20 + delay);
    assert.deepEqual(f.run('stop', 'felt', 'calm'), { code: 0, output: 'meditate done: 20 finished minutes' });
    assert.deepEqual(f.records()[1], { v: 1, type: 'end', id: f.records()[0].id, status: 'done', at: expected, source: 'cli', note: 'felt calm' });
    assert.equal(JSON.parse(f.run('today', '--json').output).finished_minutes, 20);
  }
});

test('stop without a note omits the note field and stopping again appends nothing', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.run('stop'), { code: 1, output: 'nothing running' });
  f.run('focus', '50');
  f.run('stop');
  assert.ok(!Object.hasOwn(f.records()[1], 'note'));
  const before = f.text();
  assert.deepEqual(f.run('stop', 'already stopped'), { code: 1, output: 'nothing running' });
  assert.equal(f.text(), before);
});

test('status is empty or shows the kind and seconds left using the injected clock', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.run('status'), { code: 0, output: 'nothing running' });
  assert.deepEqual(JSON.parse(f.run('status', '--json').output), { running: null });
  f.run('focus', '25');
  const before = f.text();
  f.advance(1.5);
  assert.deepEqual(f.run('status'), { code: 0, output: 'focus: 23:30 left' });
  const result = JSON.parse(f.run('status', '--json').output);
  assert.equal(result.running.id, f.records()[0].id);
  assert.equal(result.running.kind, 'focus');
  assert.equal(result.running.planned_min, 25);
  assert.equal(result.running.remaining_seconds, 1410);
  f.setTime(f.now().getTime() + 100);
  assert.equal(JSON.parse(f.run('status', '--json').output).running.remaining_seconds, 1410);
  assert.equal(f.text(), before);
});

test('status and today auto-complete overdue starts exactly once, even long after they ended', (t) => {
  for (const action of ['status', 'today']) {
    const f = fixture(t);
    f.run('focus', '90');
    const end = new Date(f.now().getTime() + 90 * minute).toISOString();
    f.advance(24 * 60);
    const before = f.text();
    assert.equal(f.run(action, '--json').code, 0);
    assert.ok(f.text().startsWith(before));
    assert.deepEqual(f.records()[1], { v: 1, type: 'end', id: f.records()[0].id, status: 'done', at: end, source: 'cli', inferred: true });
    const completed = f.text();
    f.run(action);
    assert.equal(f.text(), completed);
    assert.equal(JSON.parse(f.run('today', '--json').output).finished_minutes, 0);
  }
});

test('status auto-completes at the exact end boundary', (t) => {
  const f = fixture(t);
  f.run('meditate', '10');
  f.advance(10);
  assert.deepEqual(f.run('status'), { code: 0, output: 'nothing running' });
  assert.equal(f.records()[1].status, 'done');
});

test('a new start auto-completes an expired session before appending the new start', (t) => {
  const f = fixture(t);
  f.run('focus', '25');
  const previous = f.text();
  const plannedEnd = new Date(f.now().getTime() + 25 * minute).toISOString();
  f.advance(26);
  assert.equal(f.run('meditate', '10').code, 0);
  assert.ok(f.text().startsWith(previous));
  assert.deepEqual(f.records().map((record) => record.type), ['start', 'end', 'start']);
  assert.equal(f.records()[1].at, plannedEnd);
  assert.equal(f.records()[1].status, 'done');
  assert.equal(JSON.parse(f.run('status', '--json').output).running.kind, 'meditate');
});

test('today lists done, partial and running sessions but only sums done planned minutes', (t) => {
  const f = fixture(t);
  assert.equal(f.run('today').output, '0 finished minutes today\nToday: 0 focus, 0 meditate, 0 min');
  f.run('focus', '25');
  f.advance(25);
  f.run('stop');
  f.run('meditate', '10');
  f.advance(10);
  f.run('stop');
  f.run('focus', '50');
  f.advance(49);
  f.run('stop');
  f.run('meditate', '30');
  const result = JSON.parse(f.run('today', '--json').output);
  assert.equal(result.finished_minutes, 35);
  assert.deepEqual(result.counts, { focus: 1, meditate: 1 });
  assert.deepEqual(result.sessions.map((session) => session.status), ['done', 'done', 'partial', 'running']);
  assert.equal(result.date, '2026-10-23');
  assert.equal(f.run('today').output, 'focus 25 minutes: done\nmeditate 10 minutes: done\nfocus 50 minutes: partial\nmeditate 30 minutes: running\n35 finished minutes today\nToday: 1 focus, 1 meditate, 35 min');
  assert.doesNotMatch(f.run('today').output, /xp/i);
});

test('today assigns finished minutes to the local end date, including sessions across midnight', (t) => {
  const f = fixture(t);
  f.setTime(new Date(2026, 9, 22, 23, 50));
  f.run('focus', '25');
  f.setTime(new Date(2026, 9, 23, 0, 20));
  const today = JSON.parse(f.run('today', '--json').output);
  assert.equal(today.finished_minutes, 25);
  assert.deepEqual(today.counts, { focus: 1, meditate: 0 });
  assert.equal(today.sessions.length, 1);
  assert.equal(today.sessions[0].ended_at, new Date(2026, 9, 23, 0, 15).toISOString());
  f.setTime(new Date(2026, 9, 24, 0, 0));
  assert.equal(JSON.parse(f.run('today', '--json').output).sessions.length, 0);
});

test('local date scoring is distinct from UTC and handles a daylight saving change', () => {
  const script = `
    const { foldSessions, sessionsToday } = require(${JSON.stringify(path.resolve(__dirname, '../lib/ninety-nine'))});
    const records = [
      {v:1,type:'start',id:'night',kind:'focus',planned_min:25,at:'2026-10-24T06:25:00.000Z',source:'cli'},
      {v:1,type:'end',id:'night',status:'done',at:'2026-10-24T06:50:00.000Z',source:'cli'},
      {v:1,type:'start',id:'dst',kind:'focus',planned_min:90,at:'2026-11-01T08:30:00.000Z',source:'ios'},
      {v:1,type:'end',id:'dst',status:'done',at:'2026-11-01T10:00:00.000Z',source:'cli'}
    ];
    const sessions = foldSessions(records);
    console.log(JSON.stringify([
      sessionsToday(sessions, new Date('2026-10-23T19:00:00.000Z')),
      sessionsToday(sessions, new Date('2026-10-24T19:00:00.000Z')),
      sessionsToday(sessions, new Date('2026-11-01T20:00:00.000Z'))
    ]));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [yesterday, today, dst] = JSON.parse(result.stdout);
  assert.equal(yesterday.date, '2026-10-23');
  assert.equal(yesterday.finished_minutes, 25);
  assert.equal(today.finished_minutes, 0);
  assert.equal(dst.finished_minutes, 90);
});

test('all faces share the record: mac and ios sessions are read and stopped by cli', (t) => {
  const f = fixture(t);
  for (const source of ['mac', 'ios']) {
    f.seed([start(f.now(), { source, kind: 'meditate', minutes: 30 })]);
    assert.equal(JSON.parse(f.run('status', '--json').output).running.kind, 'meditate');
    assert.equal(f.run('focus', '25').code, 1);
    f.advance(30);
    assert.equal(f.run('stop').code, 0);
    assert.equal(f.records()[1].source, 'cli');
    assert.equal(JSON.parse(f.run('today', '--json').output).finished_minutes, 30);
  }
});

test('mac and ios ends and duplicate completion observations are counted only once', () => {
  const began = new Date(2026, 9, 23, 12);
  const ended = new Date(began.getTime() + 25 * minute).toISOString();
  const first = start(began);
  const end = { v: 1, type: 'end', id: first.id, status: 'done', at: ended, source: 'ios' };
  const sessions = foldSessions(parseSessionLog([first, end, { ...end, source: 'mac' }].map(JSON.stringify).join('\n')));
  assert.equal(sessionsToday(sessions, began).finished_minutes, 25);
});

test('a face may leave an expired start without an end before starting its next session', (t) => {
  const f = fixture(t);
  const expired = start(new Date(f.now().getTime() - 30 * minute));
  const active = start(f.now(), { id: '22222222-2222-4222-8222-222222222222', kind: 'meditate', minutes: 10, source: 'ios' });
  f.seed([expired, active]);
  const status = f.run('status', '--json');
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.output).running.id, active.id);
  assert.equal(f.records()[2].id, expired.id);
  assert.equal(f.records()[2].status, 'done');
  assert.equal(JSON.parse(f.run('today', '--json').output).finished_minutes, 25);
  assert.equal(f.run('stop', 'rest').code, 0);
  assert.equal(f.records()[3].id, active.id);
  assert.equal(f.records()[3].status, 'partial');
});

test('append preserves a valid final record that has no trailing newline', (t) => {
  const f = fixture(t);
  f.seed([start(f.now())], false);
  const before = f.text();
  assert.equal(f.run('stop').code, 0);
  assert.ok(f.text().startsWith(before + '\n'));
  assert.equal(f.records().length, 2);
});

test('new log directories and records are private and an override leaves its existing parent permissions alone', (t) => {
  const f = fixture(t);
  f.run('focus', '25');
  assert.equal(fs.statSync(path.dirname(f.logPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.logPath).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(`${f.logPath}.lock`));
  const parentMode = fs.statSync(f.dir).mode;
  const result = ninetyNineAtris(['meditate', '10'], { logPath: path.join(f.dir, 'override.jsonl'), log: () => {} });
  assert.equal(result, 0);
  assert.equal(fs.statSync(f.dir).mode, parentMode);
});

test('help and invalid commands do not create or change a session log', (t) => {
  const f = fixture(t);
  for (const args of [[], ['break', '5'], ['status', '--wat'], ['today', 'extra'], ['status', '--json', '--json']]) {
    assert.equal(f.run(...args).code, 2);
    assert.equal(f.text(), '');
  }
  for (const args of [['--help'], ['help'], ['focus', '--help'], ['stop', '--help']]) {
    const result = f.run(...args);
    assert.equal(result.code, 0);
    assert.match(result.output, /usage: atris 99 focus/);
    assert.equal(f.text(), '');
  }
  assert.ok(!fs.existsSync(path.dirname(f.logPath)));
  f.run('focus', '25');
  assert.equal(f.run('stop', 'help', 'me').code, 0);
  assert.equal(f.records()[1].note, 'help me');
});

test('an invalid log fails clearly without changing any existing bytes', (t) => {
  const f = fixture(t);
  f.seed([start(f.now())]);
  fs.appendFileSync(f.logPath, '{broken\n');
  const before = f.text();
  const result = f.run('focus', '25');
  assert.equal(result.code, 1);
  assert.match(result.output, /invalid record on line 2/);
  assert.equal(f.text(), before);
  assert.ok(!fs.existsSync(`${f.logPath}.lock`));
});

test('unwritable log destinations and an occupied lock give one-line failures', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'private'), 'a file, not a folder');
  const failed = f.run('focus', '25');
  assert.equal(failed.code, 1);
  assert.equal(failed.output.split('\n').length, 1);
  fs.unlinkSync(path.join(f.dir, 'private'));
  fs.mkdirSync(path.dirname(f.logPath));
  fs.writeFileSync(`${f.logPath}.lock`, 'another writer');
  const busy = f.run('focus', '25');
  assert.equal(busy.code, 1);
  assert.match(busy.output, /session log is busy/);
  assert.equal(fs.readFileSync(`${f.logPath}.lock`, 'utf8'), 'another writer');
  assert.equal(f.text(), '');
});

test('the actual dispatcher uses the environment override and persists across short-lived invocations', (t) => {
  const f = fixture(t);
  assert.equal(f.cli('focus', '25').status, 0);
  assert.equal(f.cli('resume').status, 1);
  assert.equal(f.cli('pause').status, 0);
  assert.equal(f.cli('pause').status, 1);
  const paused = f.cli('status', '--json');
  assert.equal(paused.status, 0, paused.stderr);
  assert.equal(JSON.parse(paused.stdout).running.status, 'paused');
  assert.equal(f.cli('resume').status, 0);
  const status = f.cli('status', '--json');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).running.kind, 'focus');
  const second = f.cli('meditate', '10');
  assert.equal(second.status, 1);
  assert.match(second.stdout, /already running/);
  assert.equal(f.cli('stop', 'manual', 'check').status, 0);
  const today = f.cli('today', '--json');
  assert.equal(today.status, 0, today.stderr);
  assert.equal(JSON.parse(today.stdout).finished_minutes, 0);
  assert.equal(JSON.parse(today.stdout).sessions[0].note, 'manual check');
  assert.equal(f.cli('status').stdout, 'nothing running\n');
  assert.equal(f.cli('pause').status, 1);
  assert.equal(f.cli('resume').status, 1);
  assert.equal(f.cli('focus', '15').status, 2);
  assert.match(f.cli('--help').stdout, /usage: atris 99 focus/);
  assert.ok(!fs.existsSync(path.join(f.dir, '.atris', '99', 'sessions.jsonl')));
});

test('the actual dispatcher defaults to the private home path', (t) => {
  const f = fixture(t);
  const env = f.env();
  delete env.ATRIS_99_LOG;
  const result = spawnSync(process.execPath, [cli, '99', 'meditate', '10'], {
    cwd: f.dir, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(f.dir, '.atris', '99');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const records = parseSessionLog(fs.readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8'));
  assert.equal(records[0].kind, 'meditate');
  assert.equal(records[0].source, 'cli');
});

test('simultaneous real CLI starts leave exactly one running session', async (t) => {
  const f = fixture(t);
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '99', ...args], { cwd: f.dir, env: f.env() });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
  const results = await Promise.all([run(['focus', '25']), run(['meditate', '10'])]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
  assert.match(results.find((result) => result.code === 1).output, /already running|session log is busy/);
  assert.equal(f.records().length, 1);
  assert.equal(foldSessions(f.records())[0].status, 'running');
});

test('legacy logs keep the same session shape and timestamps without pause records', (t) => {
  const f = fixture(t);
  const began = start(f.now());
  const planned = new Date(f.now().getTime() + 25 * minute).toISOString();
  const expected = {
    id: began.id, kind: 'focus', planned_min: 25, started_at: began.at,
    planned_end_at: planned, ended_at: null, status: 'running',
  };
  assert.deepEqual(foldSessions([began]), [expected]);
  const end = event('end', began, new Date(planned), { status: 'done', note: 'calm' });
  assert.deepEqual(foldSessions([began, end]), [{ ...expected, ended_at: planned, status: 'done', note: 'calm' }]);
  f.advance(25);
  assert.deepEqual(automaticEndRecord(expected, f.now()), {
    v: 1, type: 'end', id: began.id, status: 'done', at: planned, source: 'cli', inferred: true,
  });
});

test('pause and resume records use the shared contract and freeze the countdown past the original end', (t) => {
  const f = fixture(t);
  f.run('focus', '25');
  const began = f.records()[0];
  const originalEnd = f.now().getTime() + 25 * minute;
  f.advance(10);
  const pausedAt = f.now().toISOString();
  const before = f.text();
  assert.deepEqual(f.run('pause'), { code: 0, output: 'focus paused' });
  assert.deepEqual(f.records()[1], { v: 1, type: 'pause', id: began.id, at: pausedAt, source: 'cli' });
  assert.ok(f.text().startsWith(before));
  const pausedText = f.text();
  for (const elapsed of [0, 5, 20]) {
    f.setTime(Date.parse(pausedAt) + elapsed * minute);
    assert.deepEqual(f.run('status'), { code: 0, output: 'focus: 15:00 left (paused)' });
    const status = JSON.parse(f.run('status', '--json').output).running;
    assert.equal(status.status, 'paused');
    assert.equal(status.remaining_seconds, 900);
    assert.equal(activeMilliseconds(foldSessions(f.records())[0], f.now()), 10 * minute);
    assert.equal(f.text(), pausedText);
  }
  assert.deepEqual(f.run('resume'), { code: 0, output: 'focus resumed' });
  assert.deepEqual(f.records()[2], { v: 1, type: 'resume', id: began.id, at: f.now().toISOString(), source: 'cli' });
  const resumed = JSON.parse(f.run('status', '--json').output).running;
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.planned_end_at, new Date(originalEnd + 20 * minute).toISOString());
  f.advance(14.5);
  assert.equal(f.run('status').output, 'focus: 0:30 left');
  f.advance(0.5);
  assert.equal(f.run('status').output, 'nothing running');
  assert.deepEqual(f.records().at(-1), {
    v: 1, type: 'end', id: began.id, status: 'done', at: f.now().toISOString(), source: 'cli', inferred: true,
  });
  const today = JSON.parse(f.run('today', '--json').output);
  assert.equal(today.finished_minutes, 25);
  assert.deepEqual(today.counts, { focus: 1, meditate: 0 });
});

test('pure pause actions reject idle, finished, expired, and incompatible states', (t) => {
  const f = fixture(t);
  const began = start(f.now());
  const running = foldSessions([began])[0];
  assert.throws(() => pauseRecord(null, f.now()), /nothing running/);
  assert.throws(() => resumeRecord(null, f.now()), /nothing paused/);
  assert.throws(() => resumeRecord(running, f.now()), /not paused/);
  f.advance(5);
  const pause = pauseRecord(running, f.now());
  const paused = foldSessions([began, pause])[0];
  assert.throws(() => pauseRecord(paused, f.now()), /already paused/);
  assert.deepEqual(resumeRecord(paused, f.now()), { ...pause, type: 'resume' });
  const ended = foldSessions([began, endRecord(running, f.now())])[0];
  assert.throws(() => pauseRecord(ended, f.now()), /nothing running/);
  assert.throws(() => resumeRecord(ended, f.now()), /not paused/);
  f.advance(31);
  assert.throws(() => pauseRecord(running, f.now()), /nothing running/);
  assert.throws(() => resumeRecord(paused, f.now()), /nothing paused/);
});

test('invalid pause and resume commands fail on one line without appending an action', (t) => {
  const f = fixture(t);
  const refused = (action, message) => {
    const before = f.text();
    assert.deepEqual(f.run(action), { code: 1, output: message });
    assert.equal(f.text(), before);
  };
  refused('pause', 'nothing running');
  refused('resume', 'nothing paused');
  for (const action of ['pause', 'resume']) {
    for (const extra of ['extra', '--json']) {
      assert.deepEqual(f.run(action, extra), { code: 2, output: `usage: atris 99 ${action}` });
      assert.equal(f.text(), '');
    }
    assert.match(f.run(action, '--help').output, /atris 99 pause\n.*atris 99 resume/);
  }
  f.run('focus', '25');
  refused('resume', 'session is not paused');
  f.run('pause');
  refused('pause', 'session is already paused; use atris 99 resume');
  for (const args of [['focus', '25'], ['meditate', '10']]) {
    const before = f.text();
    assert.equal(f.run(...args).code, 1);
    assert.equal(f.text(), before);
  }
  f.run('stop');
  refused('pause', 'nothing running');
  refused('resume', 'nothing paused');
});

test('multiple pauses exclude every paused stretch and each may last exactly thirty minutes', (t) => {
  const f = fixture(t);
  f.run('meditate', '20');
  const began = f.now();
  for (const active of [5, 7]) {
    f.advance(active);
    f.run('pause');
    f.advance(30);
    assert.equal(f.run('status').code, 0);
    assert.equal(f.records().at(-1).type, 'pause');
    assert.equal(f.run('resume').code, 0);
  }
  const session = foldSessions(f.records())[0];
  assert.equal(session.paused_ms, 60 * minute);
  assert.equal(session.planned_end_at, new Date(began.getTime() + 80 * minute).toISOString());
  assert.equal(activeMilliseconds(session, f.now()), 12 * minute);
  assert.equal(sessionStatus(session, f.now()).running.remaining_seconds, 8 * 60);
  f.advance(8);
  assert.equal(f.run('stop').code, 0);
  assert.equal(f.records().at(-1).status, 'done');
  assert.equal(f.records().at(-1).at, f.now().toISOString());
  assert.ok(!Object.hasOwn(f.records().at(-1), 'inferred'));
  assert.equal(activeMilliseconds(foldSessions(f.records())[0], f.now()), 20 * minute);
  assert.equal(JSON.parse(f.run('today', '--json').output).finished_minutes, 20);
});

test('a pause expires only after thirty minutes and writes one inferred partial at the pause time', (t) => {
  for (const action of ['status', 'today', 'pause', 'resume', 'stop', 'focus']) {
    const f = fixture(t);
    f.run('focus', '25');
    f.advance(3);
    f.run('pause');
    const pausedAt = f.now().toISOString();
    f.advance(30);
    const paused = foldSessions(f.records())[0];
    assert.equal(automaticEndRecord(paused, f.now()), null);
    assert.equal(runningSession([paused], f.now()).id, paused.id);
    f.setTime(f.now().getTime() + 1);
    const expected = { v: 1, type: 'end', id: paused.id, status: 'partial', at: pausedAt, source: 'cli', inferred: true };
    assert.deepEqual(automaticEndRecord(paused, f.now()), expected);
    assert.equal(runningSession([paused], f.now()), null);
    const before = f.text();
    const result = action === 'focus' ? f.run(action, '50') : f.run(action);
    assert.equal(result.code, ['pause', 'resume', 'stop'].includes(action) ? 1 : 0, action);
    assert.ok(f.text().startsWith(before));
    assert.deepEqual(f.records()[2], expected);
    const completed = f.text();
    f.run('status');
    assert.equal(f.text(), completed);
    const today = JSON.parse(f.run('today', '--json').output);
    assert.equal(today.finished_minutes, 0);
    assert.deepEqual(today.counts, { focus: 0, meditate: 0 });
  }
});

test('a late resume from another face cannot bypass the pause limit', (t) => {
  const f = fixture(t);
  const began = start(f.now(), { kind: 'meditate', minutes: 10 });
  f.advance(2);
  const pause = event('pause', began, f.now(), { source: 'ios' });
  f.advance(31);
  const resume = event('resume', began, f.now(), { source: 'mac' });
  f.seed([began, pause, resume]);
  const session = foldSessions(f.records())[0];
  assert.deepEqual(automaticEndRecord(session, f.now()), {
    v: 1, type: 'end', id: began.id, status: 'partial', at: pause.at, source: 'cli', inferred: true,
  });
  f.advance(20);
  assert.equal(f.run('status').output, 'nothing running');
  assert.equal(f.records().at(-1).status, 'partial');
  assert.equal(f.records().at(-1).at, pause.at);
});

test('stop while paused is a real partial at the stop time, even past the original deadline', (t) => {
  for (const pauseLength of [0, 10, 30]) {
    const f = fixture(t);
    f.run('meditate', '10');
    f.advance(2);
    f.run('pause');
    f.advance(pauseLength);
    const session = foldSessions(f.records())[0];
    const before = f.text();
    const expected = {
      v: 1, type: 'end', id: session.id, status: 'partial', at: f.now().toISOString(), source: 'cli', note: 'back later',
    };
    assert.deepEqual(endRecord(session, f.now(), 'back later'), expected);
    assert.deepEqual(f.run('stop', 'back later'), { code: 0, output: 'meditate partial: 0 finished minutes' });
    assert.deepEqual(f.records().at(-1), expected);
    assert.ok(f.text().startsWith(before));
    assert.equal(activeMilliseconds(foldSessions(f.records())[0], f.now()), 2 * minute);
    assert.equal(JSON.parse(f.run('today', '--json').output).finished_minutes, 0);
  }
});

test('pausing or resuming at an elapsed active deadline completes it instead of writing a transition', (t) => {
  for (const action of ['pause', 'resume']) {
    const f = fixture(t);
    f.run('focus', '25');
    f.advance(25);
    assert.deepEqual(f.run(action), { code: 1, output: action === 'pause' ? 'nothing running' : 'nothing paused' });
    assert.deepEqual(f.records().map((record) => record.type), ['start', 'end']);
    assert.equal(f.records()[1].inferred, true);
    assert.equal(f.records()[1].status, 'done');
  }
});

test('real ends beat inferred ends in either append order and the earliest real timestamp wins', (t) => {
  const f = fixture(t);
  const began = start(f.now());
  const at = (minutes) => new Date(f.now().getTime() + minutes * minute);
  const inferred = event('end', began, at(25), { status: 'done', inferred: true, note: 'automatic' });
  const early = event('end', began, at(3), { status: 'partial', note: 'phone' });
  const late = event('end', began, at(20), { status: 'done', source: 'ios', note: 'late' });
  for (const ends of [
    [inferred, early, late], [late, inferred, early], [early, late, inferred], [late, early],
    [early, late], [inferred, { ...early, inferred: false }],
  ]) {
    const session = foldSessions([began, ...ends])[0];
    assert.equal(session.status, 'partial');
    assert.equal(session.ended_at, early.at);
    assert.equal(session.note, 'phone');
    assert.ok(!Object.hasOwn(session, 'inferred'));
    assert.equal(sessionsToday([session], f.now()).finished_minutes, 0);
  }
  const timeout = { ...inferred, at: at(2).toISOString(), status: 'partial' };
  const realDone = { ...late, at: at(25).toISOString() };
  for (const ends of [[timeout, realDone], [realDone, timeout]]) {
    const session = foldSessions([began, ...ends])[0];
    assert.equal(session.status, 'done');
    assert.equal(session.ended_at, realDone.at);
    assert.deepEqual(sessionsToday([session], f.now()).counts, { focus: 1, meditate: 0 });
  }
  const withoutNote = { ...early };
  delete withoutNote.note;
  assert.ok(!Object.hasOwn(foldSessions([began, inferred, withoutNote])[0], 'note'));
});

test('a real stop appended after an automatic completion updates today without rewriting prior bytes', (t) => {
  const f = fixture(t);
  f.run('focus', '25');
  const began = f.records()[0];
  f.advance(30);
  assert.equal(JSON.parse(f.run('today', '--json').output).finished_minutes, 25);
  const before = f.text();
  const real = event('end', began, new Date(Date.parse(began.at) + 5 * minute), { status: 'partial', source: 'ios' });
  fs.appendFileSync(f.logPath, JSON.stringify(real) + '\n');
  assert.deepEqual(JSON.parse(f.run('today', '--json').output).counts, { focus: 0, meditate: 0 });
  assert.ok(f.text().startsWith(before));
  assert.equal(f.records().length, 3);
});

test('pause and resume records from both other faces are read, including a paused session across midnight', (t) => {
  const f = fixture(t);
  f.setTime(new Date(2026, 9, 22, 23, 40));
  const began = start(f.now(), { kind: 'meditate', minutes: 20 });
  f.advance(5);
  const pause = event('pause', began, f.now(), { source: 'ios' });
  f.seed([began, pause]);
  f.advance(20);
  assert.equal(f.run('status').output, 'meditate: 15:00 left (paused)');
  const resume = event('resume', began, f.now(), { source: 'mac' });
  fs.appendFileSync(f.logPath, JSON.stringify(resume) + '\n');
  f.advance(15);
  const today = JSON.parse(f.run('today', '--json').output);
  assert.equal(today.date, '2026-10-23');
  assert.equal(today.finished_minutes, 20);
  assert.deepEqual(today.counts, { focus: 0, meditate: 1 });
  assert.equal(today.sessions[0].ended_at, f.now().toISOString());
});

test('today prints the exact count line and excludes partial, paused, and other-day completions', (t) => {
  const f = fixture(t);
  f.setTime(new Date(2026, 9, 22, 12));
  f.run('focus', '90');
  f.advance(90);
  f.run('stop');
  f.setTime(new Date(2026, 9, 23, 8));
  for (const [kind, minutes] of [['focus', 25], ['focus', 50], ['focus', 50], ['meditate', 20]]) {
    f.run(kind, String(minutes));
    f.advance(minutes);
    f.run('stop');
  }
  f.run('focus', '90');
  f.advance(10);
  f.run('stop');
  f.run('meditate', '10');
  f.advance(1);
  f.run('pause');
  assert.equal(f.run('today').output.split('\n').at(-1), 'Today: 3 focus, 1 meditate, 145 min');
  const today = JSON.parse(f.run('today', '--json').output);
  assert.deepEqual(today.counts, { focus: 3, meditate: 1 });
  assert.equal(today.finished_minutes, 145);
  assert.equal(today.sessions.at(-1).status, 'paused');
});

test('pause records and inferred ends are validated before any append', (t) => {
  const f = fixture(t);
  const began = start(f.now());
  for (const type of ['pause', 'resume']) {
    for (const extra of [{ v: 2 }, { source: 'unknown' }, { at: 'yesterday' }, { id: '' }]) {
      f.seed([began, event(type, began, f.now(), extra)]);
      const before = f.text();
      assert.equal(f.run('status').code, 1);
      assert.equal(f.text(), before);
    }
    f.seed([event(type, began, f.now())]);
    const before = f.text();
    assert.equal(f.run('status').code, 1);
    assert.equal(f.text(), before);
  }
  for (const inferred of ['true', 1, null]) {
    f.seed([began, event('end', began, f.now(), { status: 'done', inferred })]);
    assert.match(f.run('status').output, /invalid record on line 2/);
  }
  for (const source of ['cli', 'mac', 'ios']) {
    const records = [began, event('pause', began, f.now(), { source }), event('resume', began, f.now(), { source })];
    assert.deepEqual(parseSessionLog(records.map(JSON.stringify).join('\n')), records);
  }
});
