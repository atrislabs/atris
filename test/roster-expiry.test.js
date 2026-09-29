'use strict';

// A roster worker with an end date gets a heads-up a week before it ends,
// and a plain "ended" mark once it has, so a job never falls to its backup
// without anyone seeing it coming.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineCommand, expiringWorkers, bootExpiringLine } = require('../commands/engine');
const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');

// Noon local time on 2026-09-24, so the day math holds in any time zone.
const NOW = new Date(2026, 8, 24, 12, 0, 0);

function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-expiry-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-expiry-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const previous = process.env.ATRIS_MACHINE_ROSTER_PATH;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  try { return fn(root); } finally {
    if (previous === undefined) delete process.env.ATRIS_MACHINE_ROSTER_PATH;
    else process.env.ATRIS_MACHINE_ROSTER_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function ready(root, ...names) {
  readEngineRegistry(root);
  for (const name of names) setEngineHealth(name, 'ready', root);
}

function writeRoster(root, text) {
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), text);
}

function command(root, args, now = NOW) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => errors.push(parts.join(' '));
  try {
    const exit = engineCommand(args, { root, now });
    return { exit, out: logs.join('\n'), err: errors.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const MIXED = [
  '## build',
  '- claude code, until 2026-09-27',
  '- codex, until 2026-10-24',
  '- cursor, until 2026-09-23',
  '',
  '## review',
  '- haiku, until 2026-09-24',
  '',
].join('\n');

test('the roster view marks ends in 3 days, ends today, ended yesterday, and leaves 30 days alone', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'cursor', 'haiku');
  writeRoster(root, MIXED);
  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  const lines = view.out.split('\n');
  const build = lines.find((line) => line.startsWith('build'));
  assert.match(build, /until sep 27, ends in 3 days, this project/);
  const review = lines.find((line) => line.startsWith('review'));
  assert.match(review, /until sep 24, ends today, this project/);
  assert.match(view.out, /1\. claude.*leads now, until 2026-09-27, ends in 3 days/);
  const codex = lines.find((line) => /^\s+2\. codex/.test(line));
  assert.match(codex, /backup, until 2026-10-24$/);
  assert.match(view.out, /3\. cursor.*ended sep 23, skipped$/m);
  assert.doesNotMatch(view.out, /skipped, expired/);
  const heads = lines.filter((line) => line.startsWith('heads up:'));
  assert.equal(heads.length, 1);
  assert.match(heads[0], /^heads up: claude.* on build ends in 3 days, haiku.* on review ends today\. to keep them 30 more days, run: atris engine roster confirm$/);
  assert.doesNotMatch(heads[0], /codex|cursor/);
  assert.doesNotMatch(heads[0], /\u2014/);
  // The heads-up sits right under the jobs, before the closing hint.
  assert.ok(view.out.indexOf('heads up:') < view.out.indexOf('see which tools'));
}));

test('roster --json carries ends_in_days and expiring_soon on each worker and job', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'cursor', 'haiku');
  writeRoster(root, MIXED);
  const result = command(root, ['roster', '--json']);
  assert.equal(result.exit, 0, result.err);
  const report = JSON.parse(result.out);
  const build = report.jobs.find((row) => row.job === 'build');
  assert.deepEqual(build.workers.map((worker) => worker.ends_in_days), [3, 30, -1]);
  assert.deepEqual(build.workers.map((worker) => worker.expiring_soon), [true, false, false]);
  assert.equal(build.ends_in_days, 3);
  assert.equal(build.expiring_soon, true);
  const review = report.jobs.find((row) => row.job === 'review');
  assert.equal(review.ends_in_days, 0);
  assert.equal(review.expiring_soon, true);
  const search = report.jobs.find((row) => row.job === 'search');
  assert.equal(search.ends_in_days, null);
  assert.equal(search.expiring_soon, false);
  assert.deepEqual(report.expiring.map((item) => [item.job, item.engine, item.until, item.ends_in_days]), [
    ['build', 'claude', '2026-09-27', 3],
    ['review', 'haiku', '2026-09-24', 0],
  ]);
  assert.equal(report.renew_command, 'atris engine roster confirm');
}));

test('a worker 30 days out gets no heads-up, and confirm clears the warning', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  writeRoster(root, '## build\n- claude code, until 2026-10-24\n- codex\n');
  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  assert.match(view.out, /until oct 24, this project/);
  assert.doesNotMatch(view.out, /heads up|ends in|ends today/);
  const json = JSON.parse(command(root, ['roster', '--json']).out);
  assert.deepEqual(json.expiring, []);
  assert.equal(json.renew_command, null);

  // Four days out it warns; confirm renews it for 30 days and the warning goes.
  writeRoster(root, '## build\n- claude code, until 2026-09-28\n- codex\n');
  assert.match(command(root, ['roster']).out, /heads up: claude.* on build ends in 4 days/);
  const confirmed = command(root, ['roster', 'confirm']);
  assert.equal(confirmed.exit, 0, confirmed.err);
  assert.match(confirmed.out, /until oct 24, this project/);
  assert.doesNotMatch(confirmed.out, /heads up/);
}));

test('a lead that ended yesterday reads ended and skipped, and falls to its backup', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  writeRoster(root, '## build\n- claude code, until 2026-09-23\n- codex\n');
  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  assert.match(view.out, /build\s+claude.*ended sep 23, skipped, using backup, this project/);
  assert.doesNotMatch(view.out, /heads up/);
  const build = JSON.parse(command(root, ['roster', '--json']).out).jobs.find((row) => row.job === 'build');
  assert.equal(build.ends_in_days, -1);
  assert.equal(build.expiring_soon, false);
  assert.equal(build.status, 'expired');
}));

test('the boot line names the first worker that ends soon and the renew command', () => {
  assert.equal(bootExpiringLine([]), '');
  const jobs = [{
    job: 'build',
    from: 'this project',
    workers: [
      { engine: 'claude', model: null, until: '2026-09-27', ends_in_days: 3, expiring_soon: true, runs: { text: 'claude' } },
      { engine: 'codex', model: null, until: '2026-10-24', ends_in_days: 30, expiring_soon: false, runs: { text: 'codex' } },
    ],
  }, {
    job: 'review',
    from: 'this project',
    workers: [{ engine: 'haiku', model: null, until: '2026-09-24', ends_in_days: 0, expiring_soon: true, runs: { text: 'haiku' } }],
  }];
  const expiring = expiringWorkers(jobs);
  assert.equal(expiring.length, 2);
  assert.equal(bootExpiringLine(expiring), 'claude on build ends in 3 days and 1 more. renew: atris engine roster confirm');
  assert.equal(bootExpiringLine(expiring.slice(1)), 'haiku on review ends today. renew: atris engine roster confirm');
});

test('a job set for this shell only gets no renew heads-up', () => {
  const worker = { engine: 'claude', model: 'opus 5.5', until: '2026-09-27', ends_in_days: 3, expiring_soon: true };
  const jobs = [
    { job: 'build', session_pick: { engine: 'claude' }, workers: [worker] },
    { job: 'review', session_pick: null, workers: [{ ...worker }] },
  ];
  assert.deepEqual(expiringWorkers(jobs).map((item) => item.job), ['review']);
});
