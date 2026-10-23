'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { ninetyNineAtris } = require('../commands/ninety-nine');
const { foldSessions, parseSessionLog, sessionsToday } = require('../lib/ninety-nine');

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
    assert.deepEqual(f.records()[1], { v: 1, type: 'end', id: f.records()[0].id, status: 'done', at: end, source: 'cli' });
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
  assert.match(f.run('today').output, /^0 finished minutes today$/);
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
  assert.deepEqual(result.sessions.map((session) => session.status), ['done', 'done', 'partial', 'running']);
  assert.equal(result.date, '2026-10-23');
  assert.equal(f.run('today').output, 'focus 25 minutes: done\nmeditate 10 minutes: done\nfocus 50 minutes: partial\nmeditate 30 minutes: running\n35 finished minutes today');
  assert.doesNotMatch(f.run('today').output, /xp/i);
});

test('today assigns finished minutes to the local end date, including sessions across midnight', (t) => {
  const f = fixture(t);
  f.setTime(new Date(2026, 9, 22, 23, 50));
  f.run('focus', '25');
  f.setTime(new Date(2026, 9, 23, 0, 20));
  const today = JSON.parse(f.run('today', '--json').output);
  assert.equal(today.finished_minutes, 25);
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
