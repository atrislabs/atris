const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { readBoard, renderBoard, ago, isAlive, stopMember } = require('../lib/member-board');

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
    assert.match(screen, /^member\s+state\s+last result\s+alive\s+engine\s+running for\s+ago\s+job\s+last step$/m);
    assert.match(screen, /^scout\s+quiet\s+-\s+-\s+-\s+-\s+5m ago\s+find stale docs\s+running: rg stale$/m);
    assert.match(screen, /^breaker\s+done failed\s+failed \(after 20s\) 1m ago\s+-\s+-\s+-\s+1m ago\s+try the risky thing\s+running: node boom\.js$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed row says why when the finished line gives a reason', () => {
  const dir = fakeDir({
    slow: [`${at(100)} m-5 started: long job`, `${at(80)} m-5 finished: failed (timed out)`],
    broke: [`${at(100)} m-6 started: engine job`, `${at(70)} m-6 finished: failed (engine error)`],
    exit: [`${at(100)} m-7 started: exit job`, `${at(60)} m-7 finished: failed (bad exit 2)`],
    plain: [`${at(100)} m-8 started: old runner`, `${at(50)} m-8 finished: failed`],
    wordy: [`${at(100)} m-9 started: chatty job`, `${at(40)} m-9 finished: failed the engine wrote a very long story about why`],
    fine: [`${at(100)} m-10 started: good job`, `${at(30)} m-10 finished: ok (all green)`],
    bare: [`${at(20)} m-11 finished: failed`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    const by = Object.fromEntries(rows.map((r) => [r.member, r]));
    assert.equal(by.slow.state, 'done failed', 'the state word stays the same for scripts');
    assert.equal(by.slow.last_result_reason, 'timed out');
    assert.equal(by.broke.last_result_reason, 'engine error');
    assert.equal(by.exit.last_result_reason, 'bad exit 2');
    assert.equal(by.plain.last_result_reason, '', 'the written reason field stays empty');
    assert.equal(by.plain.last_result_ran, '50s');
    assert.equal(by.bare.last_result_ran, '', 'no started line, no run length');
    assert.equal(by.wordy.last_result_reason.length, 30);
    assert.equal(by.fine.last_result_reason, '', 'only a failure carries a reason');

    const screen = renderBoard(rows, dir);
    assert.match(screen, /^slow\s+done failed\s+failed \(timed out\) 1m ago\s/m);
    assert.match(screen, /^broke\s+done failed\s+failed \(engine error\) 1m ago\s/m);
    assert.match(screen, /^exit\s+done failed\s+failed \(bad exit 2\) 1m ago\s/m);
    assert.match(screen, /^plain\s+done failed\s+failed \(after 50s\) 50s ago\s/m, 'no reason written: how long it ran');
    assert.match(screen, /^bare\s+done failed\s+failed 20s ago\s/m);
    assert.match(screen, /^fine\s+done ok\s+ok 30s ago\s/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a narrow terminal trims job and last step so every line fits', () => {
  const dir = fakeDir({
    builder: [
      `${at(60)} m-1 started: Ship the member board so the operator sees every member at a glance today`,
      `${at(12)} m-1 running: node --test test/member-board.test.js test/member-result.test.js`,
    ],
    breaker: [`${at(100)} m-4 started: risky fix`, `${at(80)} m-4 finished: failed (timed out)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    const wide = renderBoard(rows, dir);
    assert.ok(wide.split('\n').some((l) => l.length > 120), 'the untrimmed board is wider than the terminal');
    assert.match(wide, /operator sees ever\.\.\.\s+running: node --test test\/member-board\.test\.js \.\.\.$/m, 'width 0 keeps the usual 50 characters');

    const narrow = renderBoard(rows, dir, 0, 120);
    for (const l of narrow.split('\n')) assert.ok(l.length <= 120, `fits in 120: ${l.length}`);
    assert.match(narrow, /^member\s+state\s+last result\s+ago\s+job\s+last step$/m, 'columns that are all dashes leave');
    assert.match(narrow, /^builder\s+working\s.*\s+Ship the member [^.]+\.\.\.\s+running: node [^.]+\.\.\.$/m);
    assert.match(narrow, /^breaker\s+done failed\s+failed \(timed out\) 1m ago\s.*risky fix\s+-$/m, 'short text stays whole');

    const tiny = renderBoard(rows, dir, 0, 80);
    for (const l of tiny.split('\n')) assert.ok(l.length <= 80, `fits in 80: ${l.length}`);
    assert.match(tiny, /^breaker\s+done failed\s+failed \(timed out\) 1m ago\s+1m ago\s/m, 'the reason survives at 80');

    const live = [{ ...rows[0], alive: true, engine: 'claude', running_for: '1m' }, rows[1]];
    assert.match(renderBoard(live, dir, 0, 120), /^member\s+state\s+last result\s+alive\s+engine\s+running for\s+ago\s+job\s+last step$/m,
      'one live run keeps them');
    const folded = renderBoard(live, dir, 0, 100);
    for (const l of folded.split('\n')) assert.ok(l.length <= 100, `a live run fits in 100: ${l.length}`);
    assert.match(folded, /^member\s+state\s+last result\s+run\s+ago\s+job\s+last step$/m, 'too narrow: one run column');
    assert.match(folded, /^builder\s+working\s+-\s+claude 1m\s+12s ago\s/m);
    assert.match(folded, /^breaker\s+done failed\s+timed out\s+-\s+1m ago\s+risky fix\s+-$/m, 'a done row keeps only the reason');
    const live80 = renderBoard(live, dir, 0, 80);
    for (const l of live80.split('\n')) assert.ok(l.length <= 80, `a live run and a reason fit in 80: ${l.length}`);
    assert.match(live80, /^builder\s+working\s+-\s+claude 1m\s/m);

    const roomy = renderBoard(rows, dir, 0, 400);
    assert.match(roomy, /^member\s+state\s+last result\s+ago\s+job\s+last step$/m);
    assert.match(roomy, /operator sees ever\.\.\./, 'a wide terminal trims no text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy row with an earlier failure shrinks its last result before it overflows', () => {
  const dir = fakeDir({
    'chat-experience-lead': [
      `${at(900)} m-1 started: fix it`,
      `${at(840)} m-1 finished: failed (bad exit 2)`,
      `${at(60)} m-2 started: try again on the chat page`,
      `${at(5)} m-2 running: npm test`,
    ],
    builder: [`${at(100)} m-3 started: build`, `${at(80)} m-3 finished: failed (engine error)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.match(renderBoard(rows, dir, 0, 120), /^chat-experience-lead\s+working\s+failed \(bad exit 2\) 14m ago\s/m, 'room to spare: all of it');
    const mid = renderBoard(rows, dir, 0, 90);
    for (const l of mid.split('\n')) assert.ok(l.length <= 90, `fits in 90: ${l.length}`);
    assert.match(mid, /^chat-experience-lead\s+working\s+failed \(bad exit 2\) 14m\s/m, 'first "ago" goes');
    const tiny = renderBoard(rows, dir, 0, 80);
    for (const l of tiny.split('\n')) assert.ok(l.length <= 80, `fits in 80: ${l.length}`);
    assert.match(tiny, /^chat-experience-lead\s+working\s+failed 14m\s/m, 'then the reason goes');
    assert.match(tiny, /^builder\s+done failed\s+engine error\s/m, 'a done row keeps its reason');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a live run with a long name drops last step before it overflows 80', () => {
  const dir = fakeDir({
    'objective-generator': [
      `${at(900)} m-1 started: fix it`,
      `${at(840)} m-1 finished: failed (bad exit 2)`,
      `${at(60)} m-2 started: try again on the chat page`,
      `${at(5)} m-2 running: npm test`,
    ],
    builder: [`${at(100)} m-3 started: build`, `${at(80)} m-3 finished: failed (engine error)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW }).map((r) => (r.member === 'objective-generator'
      ? { ...r, alive: true, engine: 'claude', running_for: '1m' } : r));
    const roomy = renderBoard(rows, dir, 0, 100);
    for (const l of roomy.split('\n')) assert.ok(l.length <= 100, `fits in 100: ${l.length}`);
    assert.match(roomy, /^member\s+state\s+last result\s+run\s+ago\s+job\s+last step$/m, 'room for both: both stay');
    const tiny = renderBoard(rows, dir, 0, 80);
    for (const l of tiny.split('\n')) assert.ok(l.length <= 80, `fits in 80: ${l.length}`);
    assert.match(tiny, /^member\s+state\s+last result\s+run\s+ago\s+job$/m, 'last step leaves');
    assert.match(tiny, /^objective-generator\s+working\s+failed 14m\s+claude 1m\s+5s ago\s+try again \.\.\.$/m, 'the job gets the room');
    assert.match(tiny, /^builder\s+done failed\s+engine error\s+-\s+1m ago\s+build$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a short window keeps the header and the newest rows, and says how many did not fit', () => {
  const logs = {};
  for (let i = 1; i <= 8; i++) logs[`m${i}`] = [`${at(i * 10)} m-${i} started: job ${i}`, `${at(i * 10 - 5)} m-${i} running: step ${i}`];
  const dir = fakeDir(logs);
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.equal(renderBoard(rows, dir).split('\n').length, 9, 'height 0 shows every row');
    assert.equal(renderBoard(rows, dir, 0, 0, 9), renderBoard(rows, dir), 'a tall enough window changes nothing');

    const lines = renderBoard(rows, dir, 0, 0, 6).split('\n');
    assert.equal(lines.length, 6);
    assert.match(lines[0], /^member\s+state/, 'the header stays');
    assert.deepEqual(lines.slice(1, 4).map((l) => l.split(/\s+/)[0]), ['m1', 'm2', 'm3'], 'the newest rows stay');
    assert.equal(lines[4], '');
    assert.equal(lines[5], '5 more not shown, the window is too short');

    const both = renderBoard(rows, dir, 2, 0, 6).split('\n');
    assert.equal(both.length, 6);
    assert.equal(both[5], '5 more not shown, the window is too short. 2 finished over an hour ago, hidden. --all shows them');

    const at80 = renderBoard(rows, dir, 2, 80, 6).split('\n');
    assert.equal(at80.length, 6, 'a narrow footer still takes one line');
    assert.equal(at80[5], '5 more not shown. 2 finished over an hour ago, hidden. --all shows them', 'first the why goes');
    const at60 = renderBoard(rows, dir, 2, 60, 6).split('\n');
    assert.equal(at60[5], '5 more not shown. 2 older runs hidden, --all shows them', 'then the hidden count shortens');
    const at30 = renderBoard(rows, dir, 2, 30, 6).split('\n');
    assert.equal(at30[5].length, 30, 'then it is cut to the window');
    assert.equal(renderBoard(rows, dir, 0, 80, 6).split('\n')[5], '5 more not shown, the window is too short', 'room for the why: it stays');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a short window keeps failed and stopped rows on screen ahead of newer ones', () => {
  const logs = {};
  for (let i = 1; i <= 6; i++) logs[`m${i}`] = [`${at(i * 10)} m-${i} started: job ${i}`, `${at(i * 10 - 5)} m-${i} running: step ${i}`];
  logs.broke = [`${at(900)} m-7 started: old job`, `${at(800)} m-7 finished: failed (engine error)`];
  logs.halted = [`${at(950)} m-8 started: other job`, `${at(850)} m-8 finished: stopped`];
  const dir = fakeDir(logs);
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.deepEqual(rows.slice(-2).map((r) => r.member), ['broke', 'halted'], 'by recency they are last');
    const lines = renderBoard(rows, dir, 0, 0, 7).split('\n');
    assert.equal(lines.length, 7);
    assert.deepEqual(lines.slice(1, 5).map((l) => l.split(/\s+/)[0]), ['m1', 'm2', 'broke', 'halted'],
      'they stay, and rows keep board order');
    assert.match(lines[3], /^broke\s+done failed\s+failed \(engine error\) 13m ago\s/);
    assert.equal(lines[6], '4 more not shown, the window is too short', 'no count when every failure is on screen');

    const tiny = renderBoard(rows, dir, 0, 0, 4).split('\n');
    assert.equal(tiny.length, 4);
    assert.match(tiny[1], /^broke\s+done failed/, 'the newest failure wins the one row');
    assert.equal(tiny[3], '7 more not shown (1 stopped), the window is too short');
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
    assert.match(once.stdout, /^navigator\s+working\s+-\s+-\s+-\s+-\s+\d+s ago\s+map the repo\s+reading atris\/MAP\.md$/m);

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

test('follow finishes a line that was half written before it started', () => {
  const { followBoard } = require('../lib/member-board');
  const dir = fakeDir({ builder: [`${at(60)} m-1 started: verify stream`] });
  const log = path.join(dir, 'builder.log');
  fs.appendFileSync(log, `${at(30)} m-1 reading par`);
  fs.writeFileSync(path.join(dir, 'blank.log'), `${at(20)} m-2 no newline yet`);
  const events = [];
  const follower = followBoard({ dir, emit: (e) => events.push(e), pollMs: 60_000 });
  try {
    follower.scan();
    assert.deepEqual(events, [], 'nothing complete yet');
    fs.appendFileSync(log, 'tial at startup\n');
    fs.appendFileSync(path.join(dir, 'blank.log'), ' until now\n');
    follower.scan();
    assert.deepEqual(events.map((e) => [e.member, e.text]), [
      ['blank', 'no newline yet until now'],
      ['builder', 'reading partial at startup'],
    ]);
  } finally {
    follower.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A spawned sleeper stands in for a member's engine run. detached makes it a
// process group leader, the same way the mission runner spawns the engine.
// The sleepers are node processes; stand in for a real engine command line.
// agoSec matches the started line's age, so the run's start time lines up.
const TOKEN = '0123456789abcdef';
const engineAs = (program, agoSec = 60, member = 'builder', token = TOKEN) => {
  const startedAt = Date.now() - agoSec * 1000;
  return {
    readProcess: (pid) => (pid === process.pid
      ? { pgid: -1, command: 'node test', startedAt: Date.now() }
      : { pgid: pid, command: `${program} -p atris-run ${member} ${token}\\012work --model x`, startedAt }),
  };
};
const asEngine = engineAs('claude');

function spawnSleeper(script) {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const ready = new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.trim()); });
  });
  return { child, ready };
}

const waitFor = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (check()) return true;
  return check();
};

const killAll = (pid) => { try { process.kill(-pid, 'SIGKILL'); } catch {} };
const isoAgo = (s) => new Date(Date.now() - s * 1000).toISOString();

test('board shows a live run as alive with its engine, and a dead one as stopped', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({
    builder: [`${isoAgo(90)} m-1 started: [pid ${child.pid} engine claude run ${TOKEN}] ship the board`, `${isoAgo(5)} m-1 reading lib/a.js`],
    legacy: [`${isoAgo(30)} m-2 started: old line with no pid`, `${isoAgo(5)} m-2 reading x`],
  });
  try {
    let by = Object.fromEntries(readBoard({ dir }).map((r) => [r.member, r]));
    assert.equal(by.builder.state, 'working');
    assert.equal(by.builder.alive, true);
    assert.equal(by.builder.engine, 'claude');
    assert.equal(by.builder.running_for, '1m');
    assert.equal(by.builder.job, 'ship the board', 'the run tag stays out of the job column');
    assert.equal(by.legacy.alive, null, 'no pid means the board cannot tell');
    assert.equal(by.legacy.state, 'working');
    assert.match(renderBoard(readBoard({ dir }), dir), /^builder\s+working\s+-\s+yes\s+claude\s+1m\s+\d+s ago\s+ship the board/m);

    child.kill('SIGKILL');
    assert.ok(await waitFor(() => !isAlive(child.pid)), 'sleeper should be gone');
    by = Object.fromEntries(readBoard({ dir }).map((r) => [r.member, r]));
    assert.equal(by.builder.state, 'stopped', 'marked working but the process is gone');
    assert.equal(by.builder.alive, false);
    assert.equal(by.builder.running_for, '');
    assert.equal(by.builder.no_result, true, 'it ended without a finished line');
    assert.equal(by.legacy.no_result, false, 'no pid: the board cannot tell');
    assert.match(renderBoard(readBoard({ dir }), dir), /^builder\s+stopped\s+ended, no result\s+no\s+claude\s+-\s+/m);
    assert.match(renderBoard(readBoard({ dir }), dir, 0, 60), /^builder\s+stopped\s+ended, no result\s/m, 'a narrow board keeps it whole');
  } finally {
    killAll(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop ends the run and everything it started, then logs finished: stopped', async () => {
  // The sleeper starts its own grandchild, like an engine running a shell command.
  const { child, ready } = spawnSleeper(
    "const c = require('child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)",
  );
  const grandchild = Number(await ready);
  const dir = fakeDir({ builder: [`${isoAgo(125)} m-9 started: [pid ${child.pid} engine claude run ${TOKEN}] long job`, `${isoAgo(3)} m-9 running: npm test`] });
  try {
    assert.ok(isAlive(grandchild));
    const result = await stopMember('builder', { dir, deps: engineAs('claude', 125) });
    assert.equal(result.ok, true);
    assert.equal(result.forced, false);
    assert.equal(result.message, 'stopped builder after 2m of work');
    assert.ok(await waitFor(() => !isAlive(child.pid)), 'member run is gone');
    assert.ok(await waitFor(() => !isAlive(grandchild)), 'what it started is gone too');
    const log = fs.readFileSync(path.join(dir, 'builder.log'), 'utf8');
    assert.match(log.trim().split('\n').pop(), /^\S+ m-9 finished: stopped$/);
    const [row] = readBoard({ dir });
    assert.equal(row.state, 'stopped');
    assert.equal((await stopMember('builder', { dir, deps: asEngine })).message, 'nothing running', 'second stop finds nothing');
  } finally {
    killAll(child.pid);
    try { process.kill(grandchild, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop forces a run that ignores the polite signal', async () => {
  const { child, ready } = spawnSleeper("process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({ stubborn: [`${isoAgo(10)} m-5 started: [pid ${child.pid} engine codex run ${TOKEN}] dig in`] });
  try {
    const result = await stopMember('stubborn', { dir, graceMs: 300, deps: engineAs('/opt/homebrew/bin/codex', 10, 'stubborn') });
    assert.equal(result.ok, true);
    assert.equal(result.forced, true);
    assert.match(result.message, /^stopped stubborn after \d+s of work, it had to be forced$/);
    assert.ok(await waitFor(() => !isAlive(child.pid)));
  } finally {
    killAll(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop says nothing running for unknown, finished, untagged, or dead runs', async () => {
  const dir = fakeDir({
    done: [`${isoAgo(60)} m-1 started: [pid ${process.pid} engine claude] x`, `${isoAgo(30)} m-1 finished: ok`],
    legacy: [`${isoAgo(60)} m-2 started: no pid here`],
    ghost: [`${isoAgo(60)} m-3 started: [pid 2147483646 engine claude] gone`],
  });
  try {
    for (const name of ['nobody', 'done', 'legacy', 'ghost', '', '../done']) {
      assert.equal((await stopMember(name, { dir, deps: asEngine })).message, 'nothing running', name);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'done.log'), 'utf8').includes('stopped'), false);
    const res = spawnSync(process.execPath, [cliPath, 'member', 'stop', 'nobody'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim().split('\n').pop(), 'nothing running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop leaves a reused pid alone when its command is no longer the engine', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({ builder: [`${isoAgo(60)} m-7 started: [pid ${child.pid} engine claude] old job`] });
  try {
    const result = await stopMember('builder', { dir, deps: { readProcess: (pid) => ({ pgid: pid, command: 'node /usr/local/bin/some-other-app', startedAt: Date.now() - 60000 }) } });
    assert.equal(result.message, 'nothing running');
    assert.equal(isAlive(child.pid), true, 'the unrelated process keeps running');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop refuses system pids, its own group, and engines it does not know', async () => {
  const lines = (pid, engine) => [`${isoAgo(20)} m-8 started: [pid ${pid} engine ${engine}] forged`];
  for (const [pid, engine] of [[1, 'launchd'], [1, 'claude'], [process.pid, 'claude'], [4242, 'launchd']]) {
    const dir = fakeDir({ forged: lines(pid, engine) });
    try {
      const deps = { readProcess: (p) => ({ pgid: p, command: `${engine} -p`, startedAt: Date.now() - 20000 }) };
      const result = await stopMember('forged', { dir, graceMs: 50, deps });
      assert.equal(result.message, 'nothing running', `pid ${pid} engine ${engine}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('member stop leaves a same-named engine alone when it started at a different time', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({ builder: [`${isoAgo(600)} m-6 started: [pid ${child.pid} engine claude] long gone`] });
  try {
    const result = await stopMember('builder', { dir, deps: engineAs('claude', 5) });
    assert.equal(result.message, 'nothing running');
    assert.equal(isAlive(child.pid), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop ignores engine names that are object keys', async () => {
  for (const engine of ['constructor', '__proto__', 'toString']) {
    const dir = fakeDir({ odd: [`${isoAgo(20)} m-4 started: [pid 4242 engine ${engine}] odd`] });
    try {
      const result = await stopMember('odd', { dir, deps: engineAs('claude', 20) });
      assert.equal(result.message, 'nothing running', engine);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('member stop needs the run token of that member in the live command', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  try {
    for (const [line, deps, label] of [
      [`started: [pid ${child.pid} engine claude] no token`, engineAs('claude', 20), 'no token in the log'],
      [`started: [pid ${child.pid} engine claude run ${TOKEN}] x`, engineAs('claude', 20, 'someone-else'), 'token belongs to another member'],
      [`started: [pid ${child.pid} engine claude run ${TOKEN}] x`, engineAs('claude', 20, 'builder', 'ffffffffffffffff'), 'different token'],
    ]) {
      const dir = fakeDir({ builder: [`${isoAgo(20)} m-2 ${line}`] });
      try {
        assert.equal((await stopMember('builder', { dir, graceMs: 50, deps })).message, 'nothing running', label);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(isAlive(child.pid), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

test('member stop does not hard-kill a process that replaced the run during the grace wait', async () => {
  const { child, ready } = spawnSleeper("process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({ builder: [`${isoAgo(20)} m-3 started: [pid ${child.pid} engine claude run ${TOKEN}] x`] });
  let calls = 0;
  const first = engineAs('claude', 20).readProcess;
  const deps = {
    readProcess: (pid) => {
      if (pid === process.pid) return first(pid);
      calls += 1;
      const info = first(pid);
      // After the polite signal, the pid now belongs to a newer process.
      return calls === 1 ? info : { ...info, startedAt: info.startedAt + 10000 };
    },
  };
  try {
    const result = await stopMember('builder', { dir, graceMs: 200, deps });
    assert.equal(result.forced, false);
    assert.equal(isAlive(child.pid), true, 'the replacement was not hard-killed');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop needs the marker to open the prompt, as whole words', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  try {
    for (const command of [
      `claude -p hello atris-run builder ${TOKEN}`,
      `claude -p atris-run builder ${TOKEN}ff more`,
      `claude -p atris-run builderx ${TOKEN}`,
      `claude --resume x atris-run builder ${TOKEN}`,
      `claude -p other prompt -p atris-run builder ${TOKEN} more`,
      `node claude -p atris-run builder ${TOKEN} x`,
    ]) {
      const dir = fakeDir({ builder: [`${isoAgo(20)} m-2 started: [pid ${child.pid} engine claude run ${TOKEN}] x`] });
      const deps = { readProcess: (pid) => (pid === process.pid ? { pgid: -1, command: 'node', startedAt: Date.now() } : { pgid: pid, command, startedAt: Date.now() - 20000 }) };
      try {
        assert.equal((await stopMember('builder', { dir, graceMs: 50, deps })).message, 'nothing running', command);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(isAlive(child.pid), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});
