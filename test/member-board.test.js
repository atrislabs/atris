const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { readBoard, renderBoard, changeTracker, ago, memberRow, isAlive, stopMember } = require('../lib/member-board');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
// Every CLI run below copies this env. Without it, a newer version on npm
// adds an update notice to the board output (and may start an update).
process.env.ATRIS_SKIP_UPDATE_CHECK = '1';

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
    assert.deepEqual(rows.map((r) => r.member), ['breaker', 'builder', 'shipper', 'scout'], 'a failed run goes first');

    assert.equal(by.builder.state, 'working');
    assert.deepEqual(by.builder.before, ['ok'], 'the older run that finished ok');
    assert.deepEqual(by.scout.before, []);
    assert.equal(by.builder.ago, '12s ago');
    assert.equal(by.builder.step, 'editing lib/b.js');
    assert.equal(by.builder.job, longJob, 'rows keep the whole job for --json');

    assert.equal(by.scout.state, 'quiet');
    assert.equal(by.scout.ago, '5m ago');
    assert.equal(by.scout.step, 'running: rg stale');

    assert.equal(by.shipper.state, 'done ok');
    assert.equal(by.shipper.step, 'running: npm test');
    assert.equal(by.breaker.state, 'done failed');
    assert.equal(by.shipper.lasted, '2m', 'an ended run shows how long it took');
    assert.equal(by.breaker.lasted, '20s');
    assert.equal(by.scout.lasted, '', 'a run that may still be going has no length yet');
    assert.equal(by.scout.running_for, '10m', 'no pid, but the start time is known');
    assert.equal(by.builder.running_for, '1m');
    assert.equal(by.shipper.running_for, '', 'an ended run uses lasted instead');

    const screen = renderBoard(rows, dir);
    assert.ok(screen.includes(`${longJob.slice(0, 47)}...`), 'with no terminal width the job cuts at 50');
    const wide = renderBoard(rows, dir, 0, 220);
    assert.ok(wide.includes(longJob), 'a wide terminal shows the whole job');
    const narrow = renderBoard(rows, dir, 0, 140);
    assert.ok(narrow.split('\n').every((l) => l.length <= 140), 'every line fits a 140 column terminal');
    assert.match(narrow, /^builder\s.*editing lib\/b\.js$/m, 'the short step keeps its length');
    assert.equal(screen.split('\n').length, 9, 'a summary, a blank line, one header, one row per member, a blank line, the pid note');
    assert.equal(screen.split('\n').pop(), '2 unfinished runs recorded no process id, so a crash there shows as working or quiet, not died', 'builder and scout cannot be checked');
    assert.equal(screen.split('\n')[0], '4 members: 1 done failed, 1 working, 1 quiet, 1 done ok', 'the summary counts states, trouble first');
    assert.match(screen, /^member\s+state\s+before\s+run time\s+ago\s+job\s+last step$/m, 'no run has a pid or engine, so those columns leave');
    assert.match(screen, /^scout\s+quiet\s+-\s+10m\s+5m ago\s+find stale docs\s+running: rg stale$/m);
    assert.match(screen, /^breaker\s+done failed\s+-\s+20s\s+1m ago\s+try the risky thing\s+running: node boom\.js$/m);
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

test('before shows how the last three runs ended, newest first', () => {
  const dir = fakeDir({
    builder: [
      `${at(900)} m-1 started: oldest`, `${at(890)} m-1 finished: ok`,
      `${at(800)} m-2 started: broke`, `${at(790)} m-2 finished: failed`,
      `${at(700)} m-3 started: halted`, `${at(695)} m-3 finished: failed`, `${at(690)} m-3 finished: stopped`,
      `${at(600)} m-4 started: cut off`, `${at(590)} m-4 reading lib/a.js`,
      `${at(30)} m-5 started: now`, `${at(10)} m-5 reading lib/b.js`,
    ],
  });
  try {
    const [row] = readBoard({ dir, now: NOW });
    assert.deepEqual(row.before, ['replaced', 'stopped', 'failed'], 'a stop wins over failed; the oldest run drops off');
    assert.match(renderBoard([row], dir), /^builder\s+working\s+replaced stopped failed\s+\d+s\s+\d+s ago\s+/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('died and failed members sort to the top, newest first inside each group', () => {
  const gone = 2147483646;
  const dir = fakeDir({
    busy: [`${at(20)} m-1 started: x`, `${at(5)} m-1 reading a`],
    halted: [`${at(40)} m-2 started: x`, `${at(10)} m-2 finished: stopped`],
    broke: [`${at(900)} m-3 started: x`, `${at(800)} m-3 finished: failed`],
    crashed: [`${at(600)} m-4 started: [pid ${gone} engine claude] x`, `${at(500)} m-4 reading b`],
    fine: [`${at(300)} m-5 started: x`, `${at(200)} m-5 finished: ok`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.deepEqual(rows.map((r) => [r.member, r.state]), [
      ['crashed', 'died'], ['broke', 'done failed'],
      ['busy', 'working'], ['halted', 'stopped'], ['fine', 'done ok'],
    ], 'a clean stop is not trouble');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('members that ended over an hour ago, finished or died, hide unless --all', () => {
  const gone = 2147483646;
  const dir = fakeDir({
    old: [`${at(7200)} m-8 started: yesterday's job`, `${at(3700)} m-8 finished: ok`],
    fresh: [`${at(600)} m-9 started: just landed`, `${at(500)} m-9 finished: failed`],
    stuck: [`${at(9000)} m-10 started: long quiet`, `${at(8000)} m-10 running: npm test`],
    crashed: [`${at(9000)} m-11 started: [pid ${gone} engine claude] old crash`, `${at(8000)} m-11 running: npm test`],
    broke: [`${at(300)} m-12 started: [pid ${gone} engine claude] new crash`, `${at(200)} m-12 running: npm test`],
  });
  try {
    assert.deepEqual(readBoard({ dir, now: NOW }).map((r) => r.member), ['broke', 'fresh', 'stuck'], 'a crash under an hour old stays');
    assert.deepEqual(readBoard({ dir, now: NOW, all: true }).map((r) => r.member), ['broke', 'fresh', 'crashed', 'old', 'stuck']);

    const env = { ...process.env, ATRIS_PROGRESS_DIR: dir };
    // Real clock: the fake logs are from 2026-10-13, so every finished member is old.
    const res = spawnSync(process.execPath, [cliPath, 'member', 'board'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /^(old|fresh|crashed|broke)\s/m);
    assert.match(res.stdout, /^stuck\s+quiet/m);
    assert.match(res.stdout, /^4 ended over an hour ago, hidden\. --all shows them$/m);

    const all = spawnSync(process.execPath, [cliPath, 'member', 'board', '--all'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /^old\s+done ok/m);
    assert.match(all.stdout, /^fresh\s+done failed/m);
    assert.match(all.stdout, /^crashed\s+died/m);
    assert.doesNotMatch(all.stdout, /hidden/);

    const json = spawnSync(process.execPath, [cliPath, 'member', 'board', '--json'], { cwd: dir, env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(json.stdout).members.map((r) => r.member), ['stuck']);
    assert.equal(JSON.parse(json.stdout).members[0].mission, 'm-10', 'each row names its mission');
    assert.equal(JSON.parse(json.stdout).hidden, 4, 'json counts what it left out, like the screen');
    const jsonAll = spawnSync(process.execPath, [cliPath, 'member', 'board', '--json', '--all'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(JSON.parse(jsonAll.stdout).hidden, 0);
    assert.equal(JSON.parse(json.stdout).unchecked, 1, 'stuck has no pid, so json warns like the screen note');
    assert.equal(JSON.parse(jsonAll.stdout).unchecked, 1, 'crashed and broke have pids and read died, so only stuck counts');
    assert.equal(JSON.parse(jsonAll.stdout).members.length, 5);
    assert.deepEqual(JSON.parse(json.stdout).counts, { died: 0, 'done failed': 0, working: 0, quiet: 1, stopped: 0, 'done ok': 0 }, 'counts cover only the members shown');
    assert.deepEqual(JSON.parse(jsonAll.stdout).counts, { died: 2, 'done failed': 1, working: 0, quiet: 1, stopped: 0, 'done ok': 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('board summary says one member, not one members', () => {
  const row = { member: 'builder', state: 'stopped', before: [], alive: false, engine: 'claude', running_for: '', lasted: '1m', ago: '5s ago', job: 'ship', step: 'edit' };
  assert.equal(renderBoard([row], '/x').split('\n')[0], '1 member: 1 stopped');
});

test('watch names state changes from the last minute, then drops them', () => {
  const row = (member, state) => ({ member, state, before: [], alive: null, engine: '', running_for: '', lasted: '', ago: '1s ago', job: 'j', step: 's' });
  const changed = changeTracker(60_000);
  assert.deepEqual(changed([row('builder', 'working'), row('scout', 'working')], 0), [], 'the first redraw has nothing to compare');
  assert.deepEqual(changed([row('builder', 'died'), row('scout', 'working')], 3_000), ['builder working -> died']);
  const rows = [row('builder', 'died'), row('scout', 'stopped')];
  const both = changed(rows, 6_000);
  assert.deepEqual(both, ['builder working -> died', 'scout working -> stopped'], 'oldest first, kept across redraws');
  assert.match(renderBoard(rows, '/x', 0, null, both).split('\n')[1], /^changed in the last minute: builder working -> died, scout working -> stopped$/);
  assert.deepEqual(changed(rows, 64_000), ['scout working -> stopped'], 'a change older than a minute drops off');
  assert.doesNotMatch(renderBoard(rows, '/x'), /changed in the last minute/, 'no changes, no line');
});

test('watch names a member whose first run appears between redraws', () => {
  const row = (member, state) => ({ member, state, before: [], alive: null, engine: '', running_for: '', lasted: '', ago: '1s ago', job: 'j', step: 's' });
  const changed = changeTracker(60_000);
  assert.deepEqual(changed([row('builder', 'working')], 0), [], 'members on the first redraw are not new');
  assert.deepEqual(changed([row('builder', 'working'), row('scout', 'working')], 3_000), ['scout new -> working']);
  assert.deepEqual(changed([row('builder', 'working'), row('scout', 'done ok')], 6_000), ['scout new -> working -> done ok'], 'a later change extends it');
  assert.deepEqual(changed([row('builder', 'working'), row('scout', 'done ok')], 67_000), [], 'and it drops off a minute after its last change');
});

test('watch says more runs ended between redraws than the board keeps', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const first = '2026-10-14T12:58:00Z m-1 started: [pid 11 engine claude] build\n2026-10-14T12:58:30Z m-1 finished: ok\n';
  const quick = (n, how) => `2026-10-14T13:00:0${n}Z m-${n + 1} started: [pid ${20 + n} engine claude] try ${n}\n2026-10-14T13:00:0${n}Z m-${n + 1} finished: ${how}\n`;
  const busy = first + quick(1, 'failed') + quick(2, 'ok') + quick(3, 'failed') + quick(4, 'failed')
    + `2026-10-14T13:00:05Z m-6 started: [pid ${process.pid} engine claude] try 5\n`;
  const done = changeTracker(60_000);
  done([memberRow('builder', first, now)], now);
  assert.equal(memberRow('builder', busy, now + 6_000).earlier_runs, 5, 'every earlier run in the log, not just the 3 kept');
  assert.deepEqual(done([memberRow('builder', busy, now + 6_000)], now + 6_000), ['builder done ok -> 1 more run -> done ok -> done failed -> done failed -> working'],
    'the run seen last time fell off the 3 kept, so the note says how many are not shown');
  const open = changeTracker(60_000);
  open([{ ...memberRow('builder', '2026-10-14T12:58:00Z m-1 started: [pid 11 engine claude] build\n', now), state: 'working' }], now);
  assert.deepEqual(open([memberRow('builder', busy, now + 6_000)], now + 6_000), ['builder working -> 2 more runs -> done ok -> done failed -> done failed -> working'],
    'how the watched run ended is not kept either');
  const unknown = changeTracker(60_000);
  unknown([memberRow('builder', first, now)], now);
  assert.deepEqual(unknown([{ ...memberRow('builder', busy, now + 6_000), earlier_runs: null }], now + 6_000),
    ['builder done ok -> more runs -> done ok -> done failed -> done failed -> working'], 'a log too long to count still says some are not shown');
  const fresh = changeTracker(60_000);
  fresh([{ ...memberRow('scout', first, now), state: 'working' }], now);
  assert.deepEqual(fresh([{ ...memberRow('scout', first, now), state: 'working' }, memberRow('builder', busy, now + 6_000)], now + 6_000),
    ['builder new -> 2 more runs -> done ok -> done failed -> done failed -> working'], 'a new member with more ended runs than kept says so too');
  const fits = changeTracker(60_000);
  fits([memberRow('builder', first, now)], now);
  const three = first + quick(1, 'failed') + quick(2, 'ok') + `2026-10-14T13:00:05Z m-6 started: [pid ${process.pid} engine claude] try 3\n`;
  assert.deepEqual(fits([memberRow('builder', three, now + 6_000)], now + 6_000), ['builder done ok -> done failed -> done ok -> working'],
    'when the run seen last time is still kept, nothing is missing');
});

test('board moves the last step under its row when the screen is too narrow for both', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const rows = [
    memberRow('builder', `2026-10-14T12:50:00Z m-1 started: [pid ${process.pid} engine claude] make the table fit an 80 column terminal\n2026-10-14T12:59:30Z m-1 running: node --test test/member-board.test.js\n`, now),
    memberRow('scout', '2026-10-14T12:55:00Z m-3 started: map the repo for stale refs\n', now),
  ];
  const screen = renderBoard(rows, '/x', 0, 80).split('\n');
  const table = screen.slice(screen.indexOf('') + 1, screen.lastIndexOf(''));
  assert.ok(table.every((l) => l.length <= 80), `the table fits 80 columns:\n${table.join('\n')}`);
  assert.match(table[0], /\sjob$/, 'the header has no last step column');
  assert.match(table[1], /^builder\s+working\s.*make the table fit/);
  assert.match(table[2], /^ {2}last step: running: node --test test\//, 'the step sits under its member');
  assert.match(table[3], /^scout\s+quiet\s/, 'a run with no step gets no step line');
  assert.match(renderBoard(rows, '/x', 0, 160), /^member\s.*\sjob\s+last step$/m, 'wide enough for both, the column stays');
  assert.match(renderBoard(rows, '/x'), /^member\s.*\sjob\s+last step$/m, 'piped output keeps the column');
});

test('board wraps a footer note at word boundaries to the screen width', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const rows = [memberRow('scout', '2026-10-14T12:59:00Z m-3 started: map the repo\n', now)];
  const note = '1 unfinished run recorded no process id, so a crash there shows as working or quiet, not died';
  const lines = renderBoard(rows, '/x', 0, 80).split('\n');
  const footer = lines.slice(lines.lastIndexOf('') + 1);
  assert.deepEqual(footer, ['1 unfinished run recorded no process id, so a crash there shows as working or', '  quiet, not died']);
  assert.equal(footer.map((l) => l.trim()).join(' '), note, 'no word is lost or cut');
  assert.equal(renderBoard(rows, '/x').split('\n').pop(), note, 'piped output keeps one line');
  assert.equal(renderBoard(rows, '/x', 0, 160).split('\n').pop(), note, 'a note that fits stays on one line');
});

test('board gives each change its own line when the shared line is wider than the screen', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const row = memberRow('builder', '2026-10-14T12:59:00Z m-1 started: build\n', now);
  const changes = ['scout new -> 1 more run -> done ok -> done failed -> working', 'builder done ok -> done failed -> working'];
  const wide = renderBoard([row], '/x', 0, 80, changes).split('\n');
  assert.deepEqual(wide.slice(1, 4), ['changed in the last minute:', '  scout new -> 1 more run -> done ok -> done failed -> working', '  builder done ok -> done failed -> working']);
  assert.ok(wide.slice(1, 4).every((l) => l.length <= 80), 'the change lines do not wrap at 80 columns');
  assert.match(renderBoard([row], '/x', 0, 200, changes), /^changed in the last minute: scout new .*, builder done ok -> done failed -> working$/m, 'one line when it fits');
  assert.match(renderBoard([row], '/x', 0, null, changes), /^changed in the last minute: scout new .*, builder done ok/m, 'piped output has no width, so it keeps one line');
  assert.match(renderBoard([], '/x', 2, 40, changes), /^changed in the last minute:\n {2}scout new/, 'the empty board splits it too');
  const long = 'builder done ok -> 1 more run -> done ok -> done failed -> done failed -> working';
  assert.deepEqual(renderBoard([row], '/x', 0, 80, [long]).split('\n').slice(1, 4),
    ['changed in the last minute:', '  builder done ok -> 1 more run -> done ok -> done failed -> done failed ->', '    working'],
    'one member too long for the screen breaks after an arrow');
});

test('board leaves the earlier run count empty when the log is too long to read whole', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const run = (n) => `2026-10-14T12:${String(n % 60).padStart(2, '0')}:00Z m-${n} started: try ${n}\n2026-10-14T12:${String(n % 60).padStart(2, '0')}:00Z m-${n} finished: ok`;
  const dir = fakeDir({ short: [run(1), run(2), '2026-10-14T12:59:00Z m-3 started: now'], long: [...Array.from({ length: 4000 }, (_, i) => run(i)), '2026-10-14T12:59:00Z m-x started: now'] });
  try {
    const by = Object.fromEntries(readBoard({ dir, now, all: true }).map((r) => [r.member, r]));
    assert.equal(by.short.earlier_runs, 2);
    assert.ok(fs.statSync(path.join(dir, 'long.log')).size > 256 * 1024, 'the long log is past what the board reads');
    assert.equal(by.long.earlier_runs, null, 'only the end of the log was read, so the count is not known');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch names the runs a new member already ended before its current one', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const builder = { ...memberRow('builder', '2026-10-14T12:58:00Z m-1 started: build\n', now), state: 'working' };
  const scout = '2026-10-14T13:00:01Z m-2 started: [pid 22 engine claude] map\n2026-10-14T13:00:02Z m-2 finished: failed\n'
    + `2026-10-14T13:00:02Z m-3 started: [pid ${process.pid} engine claude] map again\n`;
  const changed = changeTracker(60_000);
  changed([builder], now);
  assert.deepEqual(changed([builder, memberRow('scout', scout, now + 3_000)], now + 3_000), ['scout new -> done failed -> working'],
    'its first run failed before the second started, all between two redraws');
  assert.deepEqual(changed([builder, memberRow('scout', scout, now + 6_000)], now + 6_000), ['scout new -> done failed -> working'], 'the same run again is not a new change');
});

test('watch keeps a crash in view when the same member restarts within the minute', () => {
  const row = (member, state) => ({ member, state, before: [], alive: null, engine: '', running_for: '', lasted: '', ago: '1s ago', job: 'j', step: 's' });
  const changed = changeTracker(60_000);
  changed([row('builder', 'working')], 0);
  changed([row('builder', 'died')], 3_000);
  assert.deepEqual(changed([row('builder', 'working')], 9_000), ['builder working -> died -> working'], 'the restart does not erase the crash');
  assert.deepEqual(changed([row('builder', 'done ok')], 80_000), ['builder working -> done ok'], 'past the minute, a new change starts fresh');
});

test('watch names a run that ended and was replaced between two redraws', () => {
  const run = (mission, pid, before) => ({ member: 'builder', state: 'working', mission, pid, before, ago: '1s ago' });
  const changed = changeTracker(60_000);
  changed([run('m-1', 11, [])], 0);
  assert.deepEqual(changed([run('m-2', 22, ['died'])], 3_000), ['builder working -> died -> working'], 'working both times, but a crash in between');
  const clean = changeTracker(60_000);
  clean([run('m-1', 11, [])], 0);
  assert.deepEqual(clean([run('m-2', 22, ['ok', 'died'])], 3_000), ['builder working -> done ok -> working'], 'how the replaced run ended, not an older one');
  assert.deepEqual(clean([run('m-2', 22, ['ok', 'died'])], 6_000), ['builder working -> done ok -> working'], 'the same run again is not a new change');
});

test('watch names a quick run that started and ended between two redraws', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const first = '2026-10-14T12:58:00Z m-1 started: [pid 11 engine claude] build\n2026-10-14T12:58:30Z m-1 finished: ok\n';
  const quick = `${first}2026-10-14T13:00:01Z m-2 started: [pid 22 engine claude] fix\n2026-10-14T13:00:02Z m-2 finished: failed\n`;
  const next = `${quick}2026-10-14T13:00:02Z m-3 started: [pid ${process.pid} engine claude] retry\n`;
  assert.deepEqual(memberRow('builder', next, now + 3_000).before_started, ['2026-10-14T13:00:01.000Z', '2026-10-14T12:58:00.000Z'],
    'when each run in the before column started, newest first');
  const done = changeTracker(60_000);
  done([memberRow('builder', first, now)], now);
  assert.deepEqual(done([memberRow('builder', next, now + 3_000)], now + 3_000), ['builder done ok -> done failed -> working'],
    'the failed run in between is named');
  const again = changeTracker(60_000);
  again([memberRow('builder', quick, now + 2_000)], now + 2_000);
  const twice = `${quick}2026-10-14T13:00:03Z m-3 started: [pid 33 engine claude] retry\n2026-10-14T13:00:04Z m-3 finished: failed\n`;
  assert.deepEqual(again([memberRow('builder', twice, now + 5_000)], now + 5_000), ['builder done failed -> done failed'],
    'a second failure is a change, though the state reads the same');
  assert.deepEqual(again([memberRow('builder', twice, now + 8_000)], now + 8_000), ['builder done failed -> done failed'], 'the same run again is not a new change');
  const busy = changeTracker(60_000);
  busy([{ ...memberRow('builder', '2026-10-14T12:58:00Z m-1 started: [pid 11 engine claude] build\n', now), state: 'working' }], now);
  assert.deepEqual(busy([memberRow('builder', next, now + 3_000)], now + 3_000), ['builder working -> done ok -> done failed -> working'],
    'the watched run finished ok; the failure was the quick one after it');
});

test('watch rewrites replaced to died once the old run turns out to be dead', () => {
  const run = (mission, pid, before) => ({ member: 'builder', state: 'working', mission, pid, before, ago: '1s ago' });
  const changed = changeTracker(60_000);
  changed([run('m-1', 11, [])], 0);
  assert.deepEqual(changed([run('m-2', 22, ['replaced'])], 3_000), ['builder working -> replaced -> working'], 'its process was still alive');
  assert.deepEqual(changed([run('m-2', 22, ['replaced'])], 6_000), ['builder working -> replaced -> working']);
  assert.deepEqual(changed([run('m-2', 22, ['died'])], 9_000), ['builder working -> died -> working'], 'the note agrees with the before column');
  assert.deepEqual(changed([run('m-3', 33, ['ok', 'died'])], 12_000), ['builder working -> died -> working -> done ok -> working'],
    'a later run does not touch the word already fixed');
  assert.deepEqual(changed([run('m-3', 33, ['ok', 'died'])], 72_000), ['builder working -> died -> working -> done ok -> working'],
    'the fix did not restart the minute');
  assert.deepEqual(changed([run('m-3', 33, ['ok', 'died'])], 73_000), []);

  const done = changeTracker(60_000);
  done([run('m-1', 11, [])], 0);
  done([run('m-2', 22, ['replaced'])], 3_000);
  done([{ ...run('m-2', 22, ['replaced']), state: 'done ok' }], 6_000);
  assert.deepEqual(done([{ ...run('m-2', 22, ['died']), state: 'done ok' }], 9_000), ['builder working -> died -> working -> done ok'],
    'the new run finishing first does not drop the fix');
});

test('watch rewrites replaced to stopped when stop ends the old run by its pid', () => {
  const run = (mission, pid, before) => ({ member: 'builder', state: 'working', mission, pid, before, ago: '1s ago' });
  const changed = changeTracker(60_000);
  changed([run('m-1', 11, [])], 0);
  changed([run('m-2', 22, ['replaced'])], 3_000);
  assert.deepEqual(changed([run('m-2', 22, ['stopped'])], 6_000), ['builder working -> stopped -> working'], 'the note agrees with the before column');

  // A redraw can land after the old process exits and before the stop line
  // is written: the column reads died for that one redraw, then stopped.
  const race = changeTracker(60_000);
  race([run('m-1', 11, [])], 0);
  race([run('m-2', 22, ['replaced'])], 3_000);
  assert.deepEqual(race([run('m-2', 22, ['died'])], 6_000), ['builder working -> died -> working']);
  assert.deepEqual(race([run('m-2', 22, ['stopped'])], 9_000), ['builder working -> stopped -> working'], 'the stop line wins over the guess');
  assert.deepEqual(race([run('m-2', 22, ['stopped'])], 63_000), ['builder working -> stopped -> working'], 'the fix did not restart the minute');
  assert.deepEqual(race([run('m-2', 22, ['stopped'])], 64_000), []);
});

test('watch tells apart two runs with no process id on the same mission by their start', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const first = '2026-10-14T12:59:00Z m-1 started: build\n2026-10-14T12:59:30Z m-1 running: npm test\n';
  const again = `${first}2026-10-14T12:59:58Z m-1 started: build\n`;
  assert.equal(memberRow('builder', first, now).started_at, '2026-10-14T12:59:00.000Z', 'a readable start time');
  const changed = changeTracker(60_000);
  changed([memberRow('builder', first, now)], now);
  assert.deepEqual(changed([memberRow('builder', again, now)], now + 3_000), ['builder working -> replaced -> working'],
    'no process id to check, so the board does not claim a crash');
});

test('before says died only when the cut-off run had a process id that is gone', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const cut = (pid) => `2026-10-14T12:50:00Z m-1 started: [pid ${pid} engine claude] build\n2026-10-14T12:59:00Z m-2 started: next\n`;
  assert.deepEqual(memberRow('builder', cut(2147483646), now).before, ['died'], 'its process is gone');
  assert.deepEqual(memberRow('builder', cut(process.pid), now).before, ['replaced'], 'its process lives, so it did not die');
  assert.deepEqual(memberRow('builder', '2026-10-14T12:50:00Z m-1 started: build\n2026-10-14T12:59:00Z m-2 started: next\n', now).before, ['replaced']);
});

test('board names an earlier run whose process is still running', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const cut = (pid) => `2026-10-14T12:50:00Z m-1 started: [pid ${pid} engine claude] build\n2026-10-14T12:59:00Z m-2 started: next\n`;
  const twice = memberRow('builder', cut(process.pid), now);
  assert.deepEqual(twice.earlier_alive, [process.pid], 'two runs at once');
  assert.deepEqual(memberRow('builder', cut(2147483646), now).earlier_alive, [], 'its process is gone');
  const nopid = memberRow('scout', '2026-10-14T12:50:00Z m-1 started: build\n2026-10-14T12:59:00Z m-2 started: next\n', now);
  assert.deepEqual(nopid.earlier_alive, [], 'no process id to check');
  const stopped = memberRow('builder', `2026-10-14T12:50:00Z m-1 started: [pid ${process.pid} engine claude] build\n2026-10-14T12:55:00Z m-1 finished: ok\n2026-10-14T12:59:00Z m-2 started: next\n`, now);
  assert.deepEqual(stopped.earlier_alive, [], 'it said how it ended');
  assert.match(renderBoard([twice, nopid], '/x'), new RegExp(`^still running from an earlier run: builder \\(pid ${process.pid}\\); atris member stop <name> ends only the newest run, add --pid <pid> for an older one$`, 'm'));
  assert.doesNotMatch(renderBoard([nopid], '/x'), /^still running/m);
});

test('board explains replaced only when a replaced run is shown', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const cut = memberRow('scout', '2026-10-14T12:50:00Z m-1 started: build\n2026-10-14T12:59:00Z m-2 started: next\n', now);
  const plain = memberRow('builder', '2026-10-14T12:59:00Z m-3 started: build\n', now);
  assert.match(renderBoard([cut, plain], '/x'), /^replaced \(scout\): the next run started before that run said how it ended$/m);
  assert.doesNotMatch(renderBoard([plain], '/x'), /^replaced/m);
});

test('board explains replaced when only the change note says it', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  // builder's old run was alive when the next one started, then exited: the
  // column now says died, but the note from that redraw still says replaced.
  const builder = memberRow('builder', '2026-10-14T12:59:00Z m-3 started: build\n', now);
  const cut = memberRow('scout', '2026-10-14T12:50:00Z m-1 started: build\n2026-10-14T12:59:00Z m-2 started: next\n', now);
  const screen = renderBoard([builder, cut], '/x', 0, null, ['builder working -> replaced -> working', 'scout working -> replaced -> working']);
  assert.match(screen, /^replaced \(scout, builder\): the next run started before that run said how it ended$/m);
  assert.doesNotMatch(renderBoard([builder], '/x', 0, null, ['builder working -> done ok -> working']), /^replaced/m);
});

test('watch names a put-away run with when it last did anything, even once it is hidden', () => {
  const now = Date.parse('2026-10-14T13:00:00Z');
  const quiet = memberRow('launcher', '2026-10-14T05:00:00Z m-4 started: score\n2026-10-14T06:00:00Z m-4 running: npm test\n', now);
  const away = memberRow('launcher', '2026-10-14T05:00:00Z m-4 started: score\n2026-10-14T06:00:00Z m-4 running: npm test\n2026-10-14T13:00:00Z m-4 finished: stopped\n', now);
  assert.equal(away.idle, true, 'it leaves the default board at once');
  const changed = changeTracker(60_000);
  changed([quiet], now);
  assert.deepEqual(changed([away], now + 3_000), ['launcher quiet -> stopped, last active 7h ago']);
  const live = memberRow('builder', '2026-10-14T12:50:00Z m-1 started: [pid 4242 engine claude] x\n2026-10-14T12:59:00Z m-1 finished: stopped\n', now);
  const tracker = changeTracker(60_000);
  tracker([{ ...live, state: 'working' }], now);
  assert.deepEqual(tracker([live], now + 3_000), ['builder working -> stopped'], 'a live stop reads as before');
  const gone = 2147483646;
  const dug = memberRow('digger', `2026-10-14T10:00:00Z m-7 started: [pid ${gone} engine claude] dig\n2026-10-14T11:00:00Z m-7 running: npm test\n`, now);
  assert.deepEqual([dug.state, dug.idle], ['died', true], 'a crash on a run silent for 2h hides at once');
  const crashes = changeTracker(60_000);
  crashes([{ ...dug, state: 'quiet', idle: false }], now);
  assert.deepEqual(crashes([dug], now + 3_000), ['digger quiet -> died, last active 2h ago'], 'hidden, so the note says when it last did anything');
});

test('board says nobody is working when every member is hidden', () => {
  assert.equal(renderBoard([], '/x', 3), 'nobody is working right now. 3 ended over an hour ago, hidden. --all shows them');
  assert.equal(
    renderBoard([], '/x', 1, null, ['launcher quiet -> stopped, last active 7h ago']),
    'changed in the last minute: launcher quiet -> stopped, last active 7h ago\n\nnobody is working right now. 1 ended over an hour ago, hidden. --all shows them',
    'the last shown run hiding as it changes is still named',
  );
});

test('atris member board reads ATRIS_PROGRESS_DIR for real', () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const dir = fakeDir({ navigator: [`${recent} m-9 started: map the repo`, `${recent} m-9 reading atris/MAP.md`] });
  try {
    const env = { ...process.env, ATRIS_PROGRESS_DIR: dir };
    const once = spawnSync(process.execPath, [cliPath, 'member', 'board'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(once.status, 0, once.stderr);
    assert.match(once.stdout, /^navigator\s+working\s+\d+s\s+\d+s ago\s+map the repo\s+reading atris\/MAP\.md$/m, 'columns that are empty on every row leave');
    assert.match(once.stdout, /^member\s+state\s+run time\s+ago\s+job\s+last step$/m, 'before, alive and engine leave; run time stays');

    const watch = spawnSync(process.execPath, [cliPath, 'member', 'board', '--watch'], { cwd: dir, env, encoding: 'utf8', timeout: 3700 });
    assert.equal(watch.signal, 'SIGTERM', 'watch stays open until stopped');
    assert.equal(watch.stdout.split('redraws every 3s').length - 1, 2, 'drew once, then redrew at 3s');
    assert.match(watch.stdout, /\x1b\[2J\x1b\[H/);
    assert.match(watch.stdout, /navigator\s+working/);
    const times = [...watch.stdout.matchAll(/^redrawn at (\d\d:\d\d:\d\d), redraws every 3s, ctrl-c to stop$/gm)].map((m) => m[1]);
    assert.equal(times.length, 2, 'every redraw says when it happened');
    assert.notEqual(times[0], times[1], 'the time moves, so a frozen screen shows an old one');
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

test('atris member board tells a missing progress folder from an empty one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-empty-'));
  const missing = path.join(dir, 'not-made-yet');
  const board = (where, ...args) => spawnSync(process.execPath, [cliPath, 'member', 'board', ...args], {
    cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: where }, encoding: 'utf8',
  });
  try {
    let res = board(dir, '--json');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).dir_exists, true, 'empty, but there');
    res = board(missing, '--json');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).dir_exists, false);
    res = board(missing);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), `no progress folder at ${missing}; a member's first run makes it, so if members have run, the board is looking in the wrong place`);
    assert.equal(fs.existsSync(missing), false, 'looking does not make the folder');
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
  assert.equal(progressEvent('builder', '2026-10-13T12:00:03.000Z m-1 finished: failed').stopped, undefined);
  assert.deepEqual(progressEvent('builder', '2026-10-13T12:00:04.000Z m-1 finished: stopped'),
    { member: 'builder', mission: 'm-1', at: '2026-10-13T12:00:04.000Z', kind: 'finished', text: 'stopped', ok: false, stopped: true });
  assert.equal(progressEvent('builder', 'not a progress line'), null);
  assert.equal(progressEvent('builder', 'yesterday m-1 started: x'), null);
});

test('follow sends a line written while the snapshot is being taken', () => {
  const { followBoard } = require('../lib/member-board');
  const dir = fakeDir({ launcher: [`${at(60)} m-4 started: score launcher`] });
  const events = [];
  const order = [];
  // ready() is where the stream reads and prints its snapshot. A stop that
  // lands right then must still come through, not fall before the mark.
  const follower = followBoard({
    dir, pollMs: 60_000,
    emit: (e) => { events.push(e); order.push('event'); },
    ready: () => {
      order.push('snapshot');
      fs.appendFileSync(path.join(dir, 'launcher.log'), `${at(0)} m-4 finished: stopped\n`);
    },
  });
  try {
    follower.scan();
    assert.deepEqual(events.map((e) => [e.kind, e.text]), [['finished', 'stopped']], 'the stop is sent');
    assert.deepEqual(order, ['snapshot', 'event'], 'the snapshot still comes first');
  } finally {
    follower.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    assert.equal(snapshot.members[0].last_active, recent, 'a readable time for its last line');
    assert.equal(snapshot.hidden, 0);
    assert.equal(snapshot.unchecked, 1, 'navigator started without a pid');
    assert.equal(snapshot.counts.working, 1, 'the snapshot counts states like --json');
    assert.equal(snapshot.counts.stopped, 0);

    const now = new Date().toISOString();
    fs.appendFileSync(path.join(dir, 'navigator.log'), `${now} m-9 reading atris/MAP.md\n`);
    fs.writeFileSync(path.join(dir, 'scout.log'), `${now} m-10 finished: failed\n`);
    const got = await waitFor(3);
    assert.equal(got.length, 3, out);
    const byMember = Object.fromEntries(got.slice(1).map((e) => [e.member, e]));
    assert.deepEqual(byMember.navigator, { member: 'navigator', mission: 'm-9', at: now, kind: 'step', text: 'reading atris/MAP.md' });
    assert.deepEqual(byMember.scout, { member: 'scout', mission: 'm-10', at: now, kind: 'finished', text: 'failed', ok: false });

    // navigator was the one run with no pid; once it finishes, the count drops.
    const later = new Date().toISOString();
    fs.appendFileSync(path.join(dir, 'navigator.log'), `${later} m-9 finished: ok\n`);
    const after = await waitFor(5);
    assert.equal(after.length, 5, out);
    assert.deepEqual(after[3], { member: 'navigator', mission: 'm-9', at: later, kind: 'finished', text: 'ok', ok: true });
    assert.equal(after[4].kind, 'unchecked');
    assert.equal(after[4].unchecked, 0, 'the stream says the warning is gone');
    assert.equal(child.exitCode, null, 'still following');
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that died before logging past its start has no run time, not 0s', () => {
  const gone = 2147483646;
  const now = Date.parse('2026-10-14T12:00:00Z');
  const quick = memberRow('quick', '2026-10-14T11:50:00Z m-1 started: [pid ' + gone + ' engine claude] build\n', now);
  assert.equal(quick.state, 'died');
  assert.equal(quick.lasted, '', 'the board never saw it run');
  assert.doesNotMatch(renderBoard([quick], '/x'), /0s/, 'no made-up run time on screen');
  assert.match(renderBoard([quick], '/x'), /^quick\s+died\s+no\s+claude\s+10m ago\s+build/m);
  const stopped = memberRow('fast', '2026-10-14T11:50:00Z m-2 started: build\n2026-10-14T11:50:00Z m-2 finished: failed\n', now);
  assert.equal(stopped.lasted, '0s', 'a run that finished right away really took 0s');
  assert.equal(stopped.lasted_at_least, false, 'a finished run says its plain time');
  const soon = memberRow('soon', '2026-10-14T11:00:00Z m-3 started: build\n2026-10-14T11:20:00Z m-3 running: x\n2026-10-14T11:30:00Z m-3 finished: stopped\n', now);
  assert.deepEqual([soon.lasted, soon.lasted_at_least], ['30m', false], 'a stop under an hour after its last line is when it ended');
  const bare = memberRow('bare', '2026-10-14T06:00:00Z m-4 started: build\n2026-10-14T11:00:00Z m-4 finished: stopped\n', now);
  assert.equal(bare.lasted, '', 'put away with nothing logged past its start: no made-up time');
});

test('a run with no pid that has been silent for over an hour is named as likely ended', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const old = memberRow('launcher', '2026-10-14T04:00:00Z m-1 started: score launcher\n2026-10-14T05:00:00Z m-1 running: npm test\n', now);
  const fresh = memberRow('scout', '2026-10-14T11:00:00Z m-2 started: look\n2026-10-14T11:50:00Z m-2 running: rg x\n', now);
  const done = memberRow('shipper', '2026-10-14T04:00:00Z m-3 started: ship\n2026-10-14T05:00:00Z m-3 finished: ok\n', now);
  assert.equal(old.state, 'quiet', 'still a guess, so the state does not change');
  assert.equal(old.likely_ended, true);
  assert.equal(fresh.likely_ended, false, '10 minutes quiet is a pause');
  assert.equal(done.likely_ended, false, 'a finished run is not a guess');
  const screen = renderBoard([old, fresh, done], '/x');
  assert.match(screen, /^launcher has logged nothing for over an hour with no process id to check, so it most likely ended without saying so$/m);
  const two = memberRow('orb', '2026-10-14T04:00:00Z m-4 started: x\n', now);
  assert.match(renderBoard([old, two], '/x'), /^launcher, orb have logged nothing for over an hour with no process id to check, so they most likely ended without saying so$/m);
  assert.doesNotMatch(renderBoard([fresh, done], '/x'), /most likely ended/);
});

test('watchCrashes reports each newly died run once, not ones dead at start', () => {
  const { watchCrashes } = require('../lib/member-board');
  const row = (member, state, pid) => ({ member, mission: `m-${member}`, state, pid, job: `${member} job`, step: 'npm test', lasted: '4m' });
  let rows = [row('old', 'died', 11), row('live', 'working', 22), row('legacy', 'quiet', null)];
  const events = [];
  const check = watchCrashes(rows, (e) => events.push(e), () => rows);
  check();
  assert.deepEqual(events, [], 'old was dead before the stream started');
  rows = [row('old', 'died', 11), row('live', 'died', 22), row('legacy', 'quiet', null)];
  check();
  check();
  assert.deepEqual(events.map((e) => [e.kind, e.member, e.mission, e.pid, e.job, e.step, e.lasted]), [['died', 'live', 'm-live', 22, 'live job', 'npm test', '4m']]);
});

test('watchCrashes still reports a replaced run whose process dies later', () => {
  const { watchCrashes, previousRun } = require('../lib/member-board');
  const now = Date.now();
  const t = (s) => new Date(now - s * 1000).toISOString();
  const first = `${t(30)} m-1 started: [pid ${process.pid} engine claude] build\n${t(20)} m-1 running: npm test\n`;
  const restarted = `${first}${t(1)} m-2 started: build again\n`;
  const events = [];
  let oldLives = true;
  const check = watchCrashes([memberRow('builder', first, now)], (e) => events.push(e),
    () => [memberRow('builder', restarted, now)], (member) => previousRun(member, restarted, now),
    (pid) => (pid === process.pid ? oldLives : false));
  check();
  assert.deepEqual(events, [], 'still alive when the next run started: replaced, not died');
  oldLives = false;
  check();
  check();
  assert.deepEqual(events.map((e) => [e.kind, e.member, e.mission, e.pid, e.job, e.step, e.lasted, e.last_active]),
    [['died', 'builder', 'm-1', process.pid, 'build', 'running: npm test', '10s', t(20)]], 'named once, once its process is gone');
});

test('watchCrashes sends no died line for an earlier run that stop ended by its pid', () => {
  const { watchCrashes, previousRun, stoppedEarlier } = require('../lib/member-board');
  const now = Date.now();
  const t = (s) => new Date(now - s * 1000).toISOString();
  const first = `${t(30)} m-1 started: [pid ${process.pid} engine claude] build\n${t(20)} m-1 running: npm test\n`;
  let log = `${first}${t(5)} m-2 started: build again\n`;
  const events = [];
  let oldLives = true;
  const check = watchCrashes([memberRow('builder', first, now)], (e) => events.push(e),
    () => [memberRow('builder', log, now)], (member) => previousRun(member, log, now),
    (pid) => (pid === process.pid ? oldLives : false),
    (member, mission, pid) => stoppedEarlier(log, mission, pid));
  check();
  // The stop writes its line just after the process exits, so a check can
  // land in between: the process is gone and the line is not there yet.
  oldLives = false;
  check();
  log += `${t(0)} m-1 finished: stopped [pid ${process.pid}]\n`;
  check();
  check();
  assert.deepEqual(events, [], 'a stopped run is not a crash');
  assert.equal(stoppedEarlier(log, 'm-1', process.pid), true);
  assert.equal(stoppedEarlier(log, 'm-9', process.pid), false, 'another mission with the same pid');
  assert.equal(stoppedEarlier(first, 'm-1', process.pid), false, 'no stop line');
});

test('watchCrashes reports a run that died and was replaced between two checks', () => {
  const { watchCrashes, previousRun } = require('../lib/member-board');
  const now = Date.now();
  const t = (s) => new Date(now - s * 1000).toISOString();
  const gone = 2147483646;
  const first = `${t(30)} m-1 started: [pid ${gone} engine claude] build\n${t(20)} m-1 running: npm test\n`;
  const restarted = `${first}${t(1)} m-2 started: [pid ${process.pid} engine claude] retry\n`;
  const events = [];
  // Alive at the first check, then dead and replaced before the next one.
  const check = watchCrashes([{ ...memberRow('builder', first, now), state: 'working' }], (e) => events.push(e),
    () => [memberRow('builder', restarted, now)], (member) => previousRun(member, restarted, now));
  check();
  check();
  assert.deepEqual(events.map((e) => [e.kind, e.member, e.mission, e.pid, e.job, e.step, e.lasted, e.last_active]),
    [['died', 'builder', 'm-1', gone, 'build', 'running: npm test', '10s', t(20)]], 'named once, from its own lines');

  // A replaced run whose process still lives did not die.
  const both = `${t(30)} m-1 started: [pid ${process.pid} engine claude] build\n${t(1)} m-2 started: [pid ${process.pid} engine claude] retry\n`;
  const quiet = [];
  watchCrashes([{ ...memberRow('builder', both, now), mission: 'm-1' }], (e) => quiet.push(e),
    () => [memberRow('builder', both, now)], (member) => previousRun(member, both, now))();
  assert.deepEqual(quiet, []);
});

test('atris member board --json --follow says when a running process dies', async () => {
  const { spawn } = require('node:child_process');
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const base = Date.now();
  const recent = new Date(base - 5_000).toISOString();
  const later = new Date(base - 2_000).toISOString();
  const dir = fakeDir({ builder: [`${recent} m-4 started: [pid ${victim.pid} engine claude] long build`, `${later} m-4 running: npm test`] });
  const child = spawn(process.execPath, [cliPath, 'member', 'board', '--json', '--follow'], {
    cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (pred) => {
    const until = Date.now() + 8000;
    while (!pred(lines()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return lines();
  };
  try {
    const [snapshot] = await waitFor((l) => l.length >= 1);
    assert.equal(snapshot.members[0].state, 'working', 'alive at the start');
    victim.kill('SIGKILL');
    await new Promise((r) => victim.once('exit', r));
    const got = await waitFor((l) => l.some((e) => e.kind === 'died'));
    const died = got.find((e) => e.kind === 'died');
    assert.ok(died, out);
    assert.deepEqual([died.member, died.mission, died.pid, died.job], ['builder', 'm-4', victim.pid, 'long build']);
    assert.equal(died.step, 'running: npm test', 'the crash line says what the run was doing');
    assert.equal(died.lasted, '3s', 'start to its last line');
    assert.equal(died.last_active, later, 'when it last logged, not when the crash was found');
    assert.equal(got.filter((e) => e.kind === 'died').length, 1);
  } finally {
    victim.kill('SIGKILL');
    child.kill('SIGINT');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris member board --json --follow sends a crash before the restart that replaced it', async () => {
  const { spawn } = require('node:child_process');
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const recent = new Date(Date.now() - 5_000).toISOString();
  const dir = fakeDir({ builder: [`${recent} m-4 started: [pid ${victim.pid} engine claude] long build`] });
  const child = spawn(process.execPath, [cliPath, 'member', 'board', '--json', '--follow'], {
    cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (pred) => {
    const until = Date.now() + 8000;
    while (!pred(lines()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return lines();
  };
  try {
    await waitFor((l) => l.length >= 1);
    victim.kill('SIGKILL');
    await new Promise((r) => victim.once('exit', r));
    fs.appendFileSync(path.join(dir, 'builder.log'), `${new Date().toISOString()} m-5 started: [pid ${process.pid} engine claude] retry\n`);
    const got = await waitFor((l) => l.some((e) => e.kind === 'died') && l.some((e) => e.kind === 'started'));
    const order = got.filter((e) => e.kind === 'died' || e.kind === 'started').map((e) => `${e.kind} ${e.mission}`);
    assert.deepEqual(order, ['died m-4', 'started m-5'], 'an app reading in order never sees the new run before the crash');
    assert.equal(got.find((e) => e.kind === 'started').before, 'died', 'the new run says how the last one ended');
  } finally {
    victim.kill('SIGKILL');
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

test('board shows a live run as alive with its engine, and a dead one as died, not stopped', async () => {
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
    assert.match(renderBoard(readBoard({ dir }), dir), /^builder\s+working\s+yes\s+claude\s+1m\s+\d+s ago\s+ship the board/m);
    assert.match(renderBoard(readBoard({ dir }), dir), /^1 unfinished run recorded no process id, so a crash there shows as working or quiet, not died$/m, 'only legacy counts; builder has a pid');

    child.kill('SIGKILL');
    assert.ok(await waitFor(() => !isAlive(child.pid)), 'sleeper should be gone');
    by = Object.fromEntries(readBoard({ dir }).map((r) => [r.member, r]));
    assert.equal(by.builder.state, 'died', 'gone without a finished line is not a clean stop');
    assert.equal(by.builder.alive, false);
    assert.equal(by.builder.running_for, '');
    assert.equal(by.builder.lasted, '1m', 'a died run lasts from start to its last line');
    assert.match(renderBoard(readBoard({ dir }), dir), /^builder\s+died\s+no\s+claude\s+at least 1m\s+/m, 'the crash came some time after the last line');
    assert.equal(by.builder.lasted, '1m', 'json keeps the bare length');
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
    for (const name of ['done', 'legacy', 'ghost']) {
      assert.equal((await stopMember(name, { dir, deps: asEngine })).message, 'nothing running', name);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'done.log'), 'utf8').includes('stopped'), false);
    // A typo is not a member with nothing running: say there is no log by that name.
    for (const name of ['nobody', '../done']) {
      assert.equal((await stopMember(name, { dir, deps: asEngine })).message,
        `no progress log for ${name} in ${dir}, so there is nothing to stop; atris member board lists who has one`, name);
    }
    for (const name of ['', '--pid']) {
      assert.equal((await stopMember(name, { dir, deps: asEngine })).message, 'say which member to stop, like: atris member stop builder', name);
    }
    const cli = (...args) => spawnSync(process.execPath, [cliPath, 'member', 'stop', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
    });
    const last = (res) => res.stdout.trim().split('\n').pop();
    let res = cli('done');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(last(res), 'nothing running');
    res = cli('nobody');
    assert.equal(res.status, 1, 'a name with no log is a mistake, not a quiet success');
    assert.match(last(res), /^no progress log for nobody in /);
    res = cli('--pid', '4242');
    assert.equal(res.status, 1);
    assert.equal(last(res), 'say which member to stop, like: atris member stop builder');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop puts away a run with no pid that went silent for over an hour, and only that', async () => {
  const dir = fakeDir({
    launcher: [`${isoAgo(8 * 3600)} m-4 started: score launcher`, `${isoAgo(7 * 3600)} m-4 running: npm test`],
    recent: [`${isoAgo(3 * 3600)} m-6 started: long think`, `${isoAgo(600)} m-6 running: grep`],
  });
  try {
    assert.equal(readBoard({ dir }).find((r) => r.member === 'launcher').likely_ended, true);
    const result = await stopMember('launcher', { dir });
    assert.equal(result.ok, true);
    assert.equal(result.pid, null);
    assert.equal(result.message, 'marked launcher stopped, it logged nothing for 7h and had no process to end');
    assert.match(fs.readFileSync(path.join(dir, 'launcher.log'), 'utf8').trim().split('\n').pop(), /^\S+ m-4 finished: stopped$/);
    const by = Object.fromEntries(readBoard({ dir, all: true }).map((r) => [r.member, r]));
    assert.equal(by.launcher.state, 'stopped');
    assert.equal(by.launcher.likely_ended, false);
    assert.equal(by.launcher.lasted, '1h', 'start to its last real line, not to the stop 7h later');
    assert.equal(by.launcher.lasted_at_least, true);
    assert.match(renderBoard(readBoard({ dir, all: true }), dir), /^launcher\s+stopped\s+at least 1h\s+7h ago\s+/m, 'ago counts from its last real line, not the stop');
    assert.deepEqual(readBoard({ dir }).map((r) => r.member), ['recent'], 'a put-away run ended hours ago, so it leaves the board at once');
    assert.equal((await stopMember('launcher', { dir })).message, 'nothing running', 'second stop finds nothing');
    assert.equal((await stopMember('recent', { dir })).message, 'nothing running', '10m quiet may still be going');
    assert.equal(fs.readFileSync(path.join(dir, 'recent.log'), 'utf8').includes('finished'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the live stream marks a put-away run as put away, with when it last did anything', async () => {
  const { spawn } = require('node:child_process');
  const lastLine = isoAgo(7 * 3600);
  const dir = fakeDir({ launcher: [`${isoAgo(8 * 3600)} m-4 started: score launcher`, `${lastLine} m-4 running: npm test`] });
  const child = spawn(process.execPath, [cliPath, 'member', 'board', '--json', '--follow'], {
    cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
    assert.ok(await waitFor(() => lines().length >= 1, 8000), out);
    assert.equal((await stopMember('launcher', { dir })).ok, true);
    assert.ok(await waitFor(() => lines().length >= 3, 8000), out);
    const [, finished, unchecked] = lines();
    assert.equal(finished.kind, 'finished');
    assert.equal(finished.stopped, true);
    assert.equal(finished.put_away, true);
    assert.equal(finished.last_active, lastLine, 'its last line, not the stop');
    assert.deepEqual([unchecked.kind, unchecked.unchecked], ['unchecked', 0]);
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => child.once('exit', r));
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

test('the stream notes list every way the before column can say a run ended', () => {
  const { ENDED_AS } = require('../lib/member-board');
  const source = fs.readFileSync(path.join(repoRoot, 'lib', 'member-board.js'), 'utf8');
  const notes = source.slice(source.indexOf('// Live stream format'), source.indexOf('function progressEvent'));
  const line = notes.split('\n').find((l) => l.includes('"before"'));
  assert.ok(line, 'stream notes have a line about "before"');
  for (const value of Object.keys(ENDED_AS)) assert.ok(line.includes(`"${value}"`), value);
});

test('atris member board --json --follow says how the last run ended when a new one starts', async () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const dir = fakeDir({ navigator: [`${recent} m-9 started: map the repo`] });
  const child = spawn(process.execPath, [cliPath, 'member', 'board', '--json', '--follow'], {
    cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (pred) => {
    const until = Date.now() + 8000;
    while (!pred(lines()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return lines();
  };
  const started = (l) => l.filter((e) => e.kind === 'started');
  try {
    await waitFor((l) => l.length >= 1);
    // navigator never said how m-9 ended and has no pid to check.
    fs.appendFileSync(path.join(dir, 'navigator.log'), `${new Date().toISOString()} m-10 started: map again\n`);
    fs.writeFileSync(path.join(dir, 'scout.log'), `${new Date().toISOString()} m-11 started: first look\n`);
    const got = started(await waitFor((l) => started(l).length >= 2));
    const byMember = Object.fromEntries(got.map((e) => [e.member, e]));
    assert.equal(byMember.navigator.before, 'replaced', out);
    assert.equal('before' in byMember.scout, false, 'a first run has no earlier one');
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop ends only the newest run, and the board still names the older one', async () => {
  const older = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  const newer = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await Promise.all([older.ready, newer.ready]);
  const dir = fakeDir({ builder: [
    `${isoAgo(120)} m-1 started: [pid ${older.child.pid} engine claude run ${TOKEN}] first try`,
    `${isoAgo(60)} m-2 started: [pid ${newer.child.pid} engine claude run ${TOKEN}] second try`,
  ] });
  try {
    const result = await stopMember('builder', { dir, deps: engineAs('claude', 60) });
    assert.equal(result.pid, newer.child.pid);
    assert.ok(await waitFor(() => !isAlive(newer.child.pid)), 'the newest run is gone');
    assert.equal(isAlive(older.child.pid), true, 'the older run is left alone');
    const [row] = readBoard({ dir });
    assert.equal(row.state, 'stopped');
    assert.deepEqual(row.earlier_alive, [older.child.pid]);
    assert.match(renderBoard([row], dir), /^still running from an earlier run: builder \(pid \d+\); atris member stop <name> ends only the newest run, add --pid <pid> for an older one$/m);
  } finally {
    killAll(older.child.pid);
    killAll(newer.child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop --pid ends an older run that is still going, and the board reads it stopped', async () => {
  const { progressEvent } = require('../lib/member-board');
  const older = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  const newer = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await Promise.all([older.ready, newer.ready]);
  const dir = fakeDir({ builder: [
    `${isoAgo(120)} m-1 started: [pid ${older.child.pid} engine claude run ${TOKEN}] first try`,
    `${isoAgo(60)} m-2 started: [pid ${newer.child.pid} engine claude run ${TOKEN}] second try`,
    `${isoAgo(5)} m-2 running: npm test`,
  ] });
  try {
    assert.equal((await stopMember('builder', { dir, pid: 999999, deps: engineAs('claude', 120) })).message, 'nothing running', 'a pid from no run in the log');
    const result = await stopMember('builder', { dir, pid: older.child.pid, deps: engineAs('claude', 120) });
    assert.equal(result.ok, true);
    assert.equal(result.pid, older.child.pid);
    assert.equal(result.message, `stopped builder's earlier run (pid ${older.child.pid}) after 2m of work`);
    assert.ok(await waitFor(() => !isAlive(older.child.pid)), 'the older run is gone');
    assert.equal(isAlive(newer.child.pid), true, 'the newest run is left alone');
    const log = fs.readFileSync(path.join(dir, 'builder.log'), 'utf8').trim().split('\n');
    assert.match(log[log.length - 1], new RegExp(`^\\S+ m-1 finished: stopped \\[pid ${older.child.pid}\\]$`));
    const [row] = readBoard({ dir });
    assert.equal(row.state, 'working', 'the newest run is still working, not stopped');
    assert.equal(row.step, 'running: npm test', 'the stop line is not the newest run\'s step');
    assert.deepEqual(row.before, ['stopped'], 'the older run reads stopped, not died');
    assert.deepEqual(row.earlier_alive, []);
    assert.doesNotMatch(renderBoard([row], dir), /still running from an earlier run/);
    assert.equal((await stopMember('builder', { dir, pid: older.child.pid, deps: engineAs('claude', 120) })).message, 'nothing running', 'second stop finds nothing');
    const event = progressEvent('builder', log[log.length - 1]);
    assert.equal(event.kind, 'finished');
    assert.equal(event.text, 'stopped');
    assert.equal(event.stopped, true);
    assert.equal(event.pid, older.child.pid, 'the stream names which run stopped');
    assert.equal(event.earlier, true);
  } finally {
    killAll(older.child.pid);
    killAll(newer.child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
