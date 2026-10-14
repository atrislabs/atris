const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readBoard, renderBoard, ago } = require('../lib/member-board');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

function fakeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-'));
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.log`), lines.map((l) => `${l}\n`).join(''));
  }
  return dir;
}

test('ago reads like a person would say it', () => {
  assert.equal(ago(12_000), '12s ago');
  assert.equal(ago(4 * 60_000 + 5_000), '4m ago');
  assert.equal(ago(3 * 3600_000), '3h ago');
  assert.equal(ago(2 * 86400_000), '2d ago');
});

test('board shows working, quiet, done ok, and done failed from fake logs', () => {
  const longJob = 'Ship the member board so the operator sees every member at a glance today';
  const dir = fakeDir({
    builder: [
      `${at(900)} m-old started: an older job`,
      `${at(890)} m-old finished: ok`,
      `${at(60)} m-1 started: ${longJob}`,
      `${at(30)} m-1 reading lib/a.js`,
      `${at(12)} m-1 editing lib/b.js`,
    ],
    scout: [
      `${at(600)} m-2 started: find stale docs`,
      `${at(300)} m-2 running: rg stale`,
    ],
    shipper: [
      `${at(400)} m-3 started: land the fix`,
      `${at(250)} m-3 running: npm test`,
      `${at(240)} m-3 finished: ok`,
    ],
    breaker: [
      `${at(100)} m-4 started: try the risky thing`,
      `${at(90)} m-4 running: node boom.js`,
      `${at(80)} m-4 finished: failed`,
    ],
    junk: ['not a progress line'],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    const by = Object.fromEntries(rows.map((r) => [r.member, r]));
    assert.deepEqual(rows.map((r) => r.member), ['builder', 'breaker', 'shipper', 'scout']);

    assert.equal(by.builder.state, 'working');
    assert.equal(by.builder.ago, '12s ago');
    assert.equal(by.builder.step, 'editing lib/b.js');
    assert.equal(by.builder.job.length, 50);
    assert.ok(by.builder.job.startsWith('Ship the member board'));

    assert.equal(by.scout.state, 'quiet');
    assert.equal(by.scout.ago, '5m ago');
    assert.equal(by.scout.step, 'running: rg stale');

    assert.equal(by.shipper.state, 'done ok');
    assert.equal(by.shipper.step, 'running: npm test');
    assert.equal(by.breaker.state, 'done failed');

    const screen = renderBoard(rows, dir);
    assert.equal(screen.split('\n').length, 5, 'one header plus one row per member');
    assert.match(screen, /^member\s+state\s+ago\s+job\s+last step$/m);
    assert.match(screen, /^scout\s+quiet\s+5m ago\s+find stale docs\s+running: rg stale$/m);
    assert.match(screen, /^breaker\s+done failed\s+1m ago\s+try the risky thing\s+running: node boom\.js$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('last step skips writes to the member own log', () => {
  const dir = fakeDir({
    architect: [
      `${at(300)} m-5 started: plan the board`,
      `${at(200)} m-5 running: node --test test/member-board.test.js`,
      `${at(100)} m-5 running: mkdir -p atris/team/architect/logs && cat >> atris/team/architect/logs/2026-10-13.md`,
      `${at(50)} m-5 running: cat >> atris/team/architect/logs/2026-10-13.md <<'EOF'`,
    ],
    scribe: [
      `${at(40)} m-6 started: only log today`,
      `${at(30)} m-6 running: cat >> atris/team/scribe/logs/2026-10-13.md`,
    ],
    helper: [
      `${at(40)} m-7 started: write a teammate note`,
      `${at(30)} m-7 running: cat >> atris/team/scribe/logs/2026-10-13.md`,
    ],
  });
  try {
    const by = Object.fromEntries(readBoard({ dir, now: NOW }).map((r) => [r.member, r]));
    assert.equal(by.architect.step, 'running: node --test test/member-board.test.js');
    assert.equal(by.architect.ago, '50s ago', 'the log write still counts as activity');
    assert.match(by.scribe.step, /^running: cat >> atris\/team\/scribe\/logs/, 'falls back when only housekeeping happened');
    assert.match(by.helper.step, /scribe\/logs/, 'another member log is real work');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('members that finished over an hour ago hide unless --all', () => {
  const dir = fakeDir({
    old: [`${at(7200)} m-8 started: yesterday's job`, `${at(3700)} m-8 finished: ok`],
    fresh: [`${at(600)} m-9 started: just landed`, `${at(500)} m-9 finished: failed`],
    stuck: [`${at(9000)} m-10 started: long quiet`, `${at(8000)} m-10 running: npm test`],
  });
  try {
    assert.deepEqual(readBoard({ dir, now: NOW }).map((r) => r.member), ['fresh', 'stuck']);
    assert.deepEqual(readBoard({ dir, now: NOW, all: true }).map((r) => r.member), ['fresh', 'old', 'stuck']);

    const env = { ...process.env, ATRIS_PROGRESS_DIR: dir };
    // Real clock: the fake logs are from 2026-10-13, so every finished member is old.
    const res = spawnSync(process.execPath, [cliPath, 'member', 'board'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /^(old|fresh)\s/m);
    assert.match(res.stdout, /^stuck\s+quiet/m);
    assert.match(res.stdout, /^2 finished over an hour ago, hidden\. --all shows them$/m);

    const all = spawnSync(process.execPath, [cliPath, 'member', 'board', '--all'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /^old\s+done ok/m);
    assert.match(all.stdout, /^fresh\s+done failed/m);
    assert.doesNotMatch(all.stdout, /hidden/);

    const json = spawnSync(process.execPath, [cliPath, 'member', 'board', '--json'], { cwd: dir, env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(json.stdout).members.map((r) => r.member), ['stuck']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('board says nobody is working when every member is hidden', () => {
  assert.equal(renderBoard([], '/x', 3), 'nobody is working right now. 3 finished over an hour ago, hidden. --all shows them');
});

test('atris member board reads ATRIS_PROGRESS_DIR for real', () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const dir = fakeDir({ navigator: [`${recent} m-9 started: map the repo`, `${recent} m-9 reading atris/MAP.md`] });
  try {
    const env = { ...process.env, ATRIS_PROGRESS_DIR: dir };
    const once = spawnSync(process.execPath, [cliPath, 'member', 'board'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(once.status, 0, once.stderr);
    assert.match(once.stdout, /^navigator\s+working\s+\d+s ago\s+map the repo\s+reading atris\/MAP\.md$/m);

    const watch = spawnSync(process.execPath, [cliPath, 'member', 'board', '--watch'], { cwd: dir, env, encoding: 'utf8', timeout: 3700 });
    assert.equal(watch.signal, 'SIGTERM', 'watch stays open until stopped');
    assert.equal(watch.stdout.split('redraws every 3s').length - 1, 2, 'drew once, then redrew at 3s');
    assert.match(watch.stdout, /\x1b\[2J\x1b\[H/);
    assert.match(watch.stdout, /navigator\s+working/);
    assert.match(watch.stdout, /redraws every 3s/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris member board says so plainly when no member has a log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-empty-'));
  try {
    const res = spawnSync(process.execPath, [cliPath, 'member', 'board'], {
      cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir }, encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), `no member progress yet in ${dir}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('progress lines turn into stream events', () => {
  const { progressEvent } = require('../lib/member-board');
  assert.deepEqual(progressEvent('builder', '2026-10-13T12:00:00.000Z m-1 started: ship the stream'),
    { member: 'builder', mission: 'm-1', at: '2026-10-13T12:00:00.000Z', kind: 'started', text: 'ship the stream' });
  assert.deepEqual(progressEvent('builder', '2026-10-13T12:00:01Z m-1 running: npm test'),
    { member: 'builder', mission: 'm-1', at: '2026-10-13T12:00:01.000Z', kind: 'step', text: 'running: npm test' });
  assert.deepEqual(progressEvent('builder', '2026-10-13T12:00:02.000Z m-1 finished: ok'),
    { member: 'builder', mission: 'm-1', at: '2026-10-13T12:00:02.000Z', kind: 'finished', text: 'ok', ok: true });
  assert.equal(progressEvent('builder', '2026-10-13T12:00:03.000Z m-1 finished: failed').ok, false);
  assert.equal(progressEvent('builder', 'not a progress line'), null);
  assert.equal(progressEvent('builder', 'yesterday m-1 started: x'), null);
});

test('follow emits only new full lines, picks up new members, survives truncation', () => {
  const { followBoard } = require('../lib/member-board');
  const dir = fakeDir({ builder: [`${at(60)} m-1 started: old job`] });
  const events = [];
  const follower = followBoard({ dir, emit: (e) => events.push(e), pollMs: 60_000 });
  try {
    follower.scan();
    assert.deepEqual(events, [], 'lines already on disk belong to the snapshot');

    const log = path.join(dir, 'builder.log');
    fs.appendFileSync(log, `${at(30)} m-1 reading lib/a.js\n${at(20)} m-1 edit`);
    follower.scan();
    assert.deepEqual(events.map((e) => e.text), ['reading lib/a.js'], 'half-written line waits');

    fs.appendFileSync(log, 'ing lib/b.js\n');
    fs.writeFileSync(path.join(dir, 'scout.log'), `${at(10)} m-2 started: find stale docs\njunk line\n`);
    follower.scan();
    assert.deepEqual(events.slice(1).map((e) => [e.member, e.kind, e.text]), [
      ['builder', 'step', 'editing lib/b.js'],
      ['scout', 'started', 'find stale docs'],
    ]);

    fs.writeFileSync(log, `${at(5)} m-3 finished: ok\n`);
    follower.scan();
    assert.deepEqual(events[events.length - 1], {
      member: 'builder', mission: 'm-3', at: at(5), kind: 'finished', text: 'ok', ok: true,
    });
    assert.equal(events.length, 4);
  } finally {
    follower.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris member board --json --follow streams one JSON object per line', async () => {
  const { spawn } = require('node:child_process');
  const recent = new Date(Date.now() - 5_000).toISOString();
  const dir = fakeDir({ navigator: [`${recent} m-9 started: map the repo`] });
  const child = spawn(process.execPath, [cliPath, 'member', 'board', '--json', '--follow'], {
    cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (n) => {
    const until = Date.now() + 8000;
    while (lines().length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return lines();
  };
  try {
    const [snapshot] = await waitFor(1);
    assert.equal(snapshot.kind, 'snapshot');
    assert.equal(snapshot.dir, dir);
    assert.deepEqual(snapshot.members.map((m) => [m.member, m.state]), [['navigator', 'working']]);

    const now = new Date().toISOString();
    fs.appendFileSync(path.join(dir, 'navigator.log'), `${now} m-9 reading atris/MAP.md\n`);
    fs.writeFileSync(path.join(dir, 'scout.log'), `${now} m-10 finished: failed\n`);
    const got = await waitFor(3);
    assert.equal(got.length, 3, out);
    const byMember = Object.fromEntries(got.slice(1).map((e) => [e.member, e]));
    assert.deepEqual(byMember.navigator, { member: 'navigator', mission: 'm-9', at: now, kind: 'step', text: 'reading atris/MAP.md' });
    assert.deepEqual(byMember.scout, { member: 'scout', mission: 'm-10', at: now, kind: 'finished', text: 'failed', ok: false });
    assert.equal(child.exitCode, null, 'still following');
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
