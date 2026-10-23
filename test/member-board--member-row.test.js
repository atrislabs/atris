const test = require('node:test');
const assert = require('node:assert/strict');

const { memberRow } = require('../lib/member-board');

// memberRow reads no files and no env: it only parses the log text it is
// handed, so every case below is a fixed string and a fixed "now".
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();
const line = (secondsAgo, mission, text) => `${iso(secondsAgo)} ${mission} ${text}`;
const log = (...lines) => `${lines.join('\n')}\n`;

test('memberRow describes a member that is working right now', () => {
  const text = log(
    line(60, 'm-1', 'started: Ship the member board'),
    line(30, 'm-1', 'reading lib/a.js'),
    line(12, 'm-1', 'editing lib/b.js'),
  );
  assert.deepEqual(memberRow('builder', text, NOW), {
    member: 'builder',
    state: 'working',
    last_result: '',
    last_result_ago: '',
    pid: null,
    engine: '',
    alive: null,
    running_for: '',
    job: 'Ship the member board',
    step: 'editing lib/b.js',
    ago: '12s ago',
    at: NOW - 12_000,
    idle: false,
  });
});

test('memberRow turns quiet once the last line is two minutes old', () => {
  const quietAt = (secondsAgo) => memberRow(
    'scout',
    log(line(600, 'm-2', 'started: find stale docs'), line(secondsAgo, 'm-2', 'running: rg stale')),
    NOW,
  );
  assert.equal(quietAt(119).state, 'working');
  assert.equal(quietAt(120).state, 'quiet');
  const quiet = quietAt(300);
  assert.equal(quiet.state, 'quiet');
  assert.equal(quiet.ago, '5m ago');
  assert.equal(quiet.step, 'running: rg stale');
  assert.equal(quiet.idle, false);
});

test('memberRow reports done ok and done failed from the finished line', () => {
  const run = (verdict) => memberRow('shipper', log(
    line(400, 'm-3', 'started: land the fix'),
    line(250, 'm-3', 'running: npm test'),
    line(240, 'm-3', `finished: ${verdict}`),
  ), NOW);

  const ok = run('ok');
  assert.equal(ok.state, 'done ok');
  assert.equal(ok.last_result, 'ok');
  assert.equal(ok.last_result_ago, '4m ago');
  assert.equal(ok.step, 'running: npm test');
  assert.equal(ok.idle, false);

  const failed = run('failed');
  assert.equal(failed.state, 'done failed');
  assert.equal(failed.last_result, 'failed');

  // A finished line is not a step: with nothing else in the run, step is empty.
  const bare = memberRow('shipper', log(line(50, 'm-3', 'started: tiny job'), line(40, 'm-3', 'finished: ok')), NOW);
  assert.equal(bare.step, '');
  assert.equal(bare.job, 'tiny job');
});

test('memberRow marks a finished run idle only after a full hour', () => {
  const finishedAgo = (seconds) => memberRow('shipper', log(
    line(seconds + 60, 'm-3', 'started: old job'),
    line(seconds, 'm-3', 'finished: ok'),
  ), NOW);
  assert.equal(finishedAgo(3599).idle, false);
  assert.equal(finishedAgo(3600).idle, true);
  assert.equal(finishedAgo(3600).ago, '1h ago');
  assert.equal(finishedAgo(2 * 86400).ago, '2d ago');

  // An unfinished run never goes idle, however old.
  const stale = memberRow('scout', log(line(7200, 'm-2', 'started: abandoned'), line(7190, 'm-2', 'running: x')), NOW);
  assert.equal(stale.idle, false);
  assert.equal(stale.state, 'quiet');
});

test('memberRow lets a stop win over a failed finish in either order', () => {
  const stopFirst = memberRow('builder', log(
    line(100, 'm-4', 'started: risky thing'),
    line(90, 'm-4', 'finished: stopped by operator'),
    line(80, 'm-4', 'finished: failed'),
  ), NOW);
  assert.equal(stopFirst.state, 'stopped');
  assert.equal(stopFirst.last_result, 'stopped');
  assert.equal(stopFirst.last_result_ago, '1m ago');

  const stopLast = memberRow('builder', log(
    line(100, 'm-4', 'started: risky thing'),
    line(90, 'm-4', 'finished: failed'),
    line(80, 'm-4', 'finished: stopped'),
  ), NOW);
  assert.equal(stopLast.state, 'stopped');
  assert.equal(stopLast.last_result, 'stopped');
});

test('memberRow only reads the latest run but still shows how the previous one ended', () => {
  const row = memberRow('builder', log(
    line(900, 'm-old', 'started: an older job'),
    line(890, 'm-old', 'finished: failed'),
    line(60, 'm-new', 'started: the new job'),
    line(10, 'm-new', 'editing lib/c.js'),
  ), NOW);
  assert.equal(row.state, 'working');
  assert.equal(row.job, 'the new job');
  assert.equal(row.step, 'editing lib/c.js');
  assert.equal(row.last_result, 'failed');
  assert.equal(row.last_result_ago, '14m ago');
});

test('memberRow skips the member\'s own log writes when naming the last step', () => {
  const ownLogWrite = 'writing atris/team/builder/logs/2026-10-13.md';

  const withRealWork = memberRow('builder', log(
    line(60, 'm-1', 'started: job'),
    line(40, 'm-1', 'editing lib/a.js'),
    line(20, 'm-1', ownLogWrite),
  ), NOW);
  assert.equal(withRealWork.step, 'editing lib/a.js');
  assert.equal(withRealWork.ago, '20s ago', 'ago still follows the true last line');

  // Nothing but housekeeping happened: fall back to the log write.
  const onlyOwnLog = memberRow('builder', log(line(60, 'm-1', 'started: job'), line(20, 'm-1', ownLogWrite)), NOW);
  assert.equal(onlyOwnLog.step, ownLogWrite);

  // Another member's log is real work for this member.
  const otherLog = 'reading atris/team/scout/logs/2026-10-13.md';
  const readsOther = memberRow('builder', log(line(60, 'm-1', 'started: job'), line(20, 'm-1', otherLog)), NOW);
  assert.equal(readsOther.step, otherLog);
});

test('memberRow treats a member name as plain text, not a pattern', () => {
  const lookalike = 'writing atris/team/axb/logs/today.md';
  const row = memberRow('a.b', log(
    line(60, 'm-1', 'started: job'),
    line(40, 'm-1', 'editing lib/a.js'),
    line(20, 'm-1', lookalike),
  ), NOW);
  // "." in the name must not match "x", so the lookalike path is real work.
  assert.equal(row.step, lookalike);
  assert.doesNotThrow(() => memberRow('weird(name[', log(line(5, 'm-1', 'started: job')), NOW));
});

test('memberRow shortens long jobs and steps and collapses whitespace', () => {
  const longJob = 'Ship the member board so the operator sees every member at a glance today';
  const longStep = 'reading '.concat('lib/very/deep/path/'.repeat(5), 'file.js');
  const row = memberRow('builder', log(
    line(60, 'm-1', `started: ${longJob}`),
    line(10, 'm-1', longStep),
  ), NOW);
  assert.equal(row.job.length, 50);
  assert.equal(row.job, `${longJob.slice(0, 47)}...`);
  assert.equal(row.step.length, 50);
  assert.equal(row.step, `${longStep.slice(0, 47)}...`);

  const exact = 'x'.repeat(50);
  assert.equal(memberRow('builder', log(line(5, 'm-1', `started: ${exact}`)), NOW).job, exact);

  const messy = memberRow('builder', log(line(5, 'm-1', 'started: fix   the\t bug   now')), NOW);
  assert.equal(messy.job, 'fix the bug now');
});

test('memberRow reads the pid tag and checks whether that process is alive', () => {
  const tag = (pid) => `[pid ${pid} engine claude run 0123456789abcdef]`;

  const live = memberRow('builder', log(
    line(125, 'm-9', `started: ${tag(process.pid)} ship it`),
    line(3, 'm-9', 'running: npm test'),
  ), NOW);
  assert.equal(live.pid, process.pid);
  assert.equal(live.engine, 'claude');
  assert.equal(live.alive, true);
  assert.equal(live.running_for, '2m');
  assert.equal(live.job, 'ship it', 'the tag is not part of the job');
  assert.equal(live.state, 'working');

  // A pid no machine has: the run died without a finished line.
  const ghost = memberRow('builder', log(
    line(125, 'm-9', `started: ${tag(2147483646)} ship it`),
    line(3, 'm-9', 'running: npm test'),
  ), NOW);
  assert.equal(ghost.pid, 2147483646);
  assert.equal(ghost.alive, false);
  assert.equal(ghost.running_for, '');
  assert.equal(ghost.state, 'stopped');

  // Once a finished line exists the pid is no longer probed.
  const done = memberRow('builder', log(
    line(125, 'm-9', `started: ${tag(process.pid)} ship it`),
    line(3, 'm-9', 'finished: ok'),
  ), NOW);
  assert.equal(done.state, 'done ok');
  assert.equal(done.alive, false);
  assert.equal(done.running_for, '');
});

test('memberRow copes with a log that starts mid-run and with a clock that is behind', () => {
  const noStart = memberRow('builder', log(
    line(30, 'm-1', 'reading lib/a.js'),
    line(10, 'm-1', 'editing lib/b.js'),
  ), NOW);
  assert.equal(noStart.job, '');
  assert.equal(noStart.pid, null);
  assert.equal(noStart.alive, null);
  assert.equal(noStart.running_for, '');
  assert.equal(noStart.step, 'editing lib/b.js');
  assert.equal(noStart.state, 'working');

  const future = memberRow('builder', log(line(-5, 'm-1', 'started: job'), line(-5, 'm-1', 'editing x')), NOW);
  assert.equal(future.ago, '0s ago');
  assert.equal(future.state, 'working');
});

test('memberRow returns null when there is nothing readable in the log', () => {
  assert.equal(memberRow('builder', '', NOW), null);
  assert.equal(memberRow('builder', '\n\n', NOW), null);
  assert.equal(memberRow('builder', 'not a progress line', NOW), null);
  assert.equal(memberRow('builder', 'notadate m-1 started: job', NOW), null);
  assert.equal(memberRow('builder', `${iso(5)} onlytwo`, NOW), null);
});

test('memberRow skips junk lines but still reads the good ones around them', () => {
  const row = memberRow('builder', log(
    'garbage with no timestamp',
    line(30, 'm-1', 'started: real job'),
    'notadate m-1 editing nothing',
    line(10, 'm-1', 'editing lib/a.js'),
  ), NOW);
  assert.equal(row.job, 'real job');
  assert.equal(row.step, 'editing lib/a.js');
  assert.equal(row.ago, '10s ago');
});
