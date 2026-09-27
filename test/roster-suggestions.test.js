'use strict';

// The roster suggests a new order when the run record says the first worker
// keeps missing and a later one keeps landing, and it never changes the
// roster itself. Every room is a scratch project with a scratch home and an
// injected clock, so the real ~/.atris is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
];

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

const ROSTER = `# roster

## small build
- devin, model: swe-2-max, max: 20 min
- cursor
- grok, model: grok 4.7 fast, max: 30 min
`;

async function withRoom(fn, { roster = ROSTER } = {}) {
  const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-suggest-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-suggest-home-'));
  spawnSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, 'atris'));
  if (roster) fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), roster);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_CODEX_CONFIG_PATH = path.join(home, 'no-codex-config.toml');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  readEngineRegistry(root);
  for (const name of ['devin', 'grok', 'cursor', 'codex', 'claude']) setEngineHealth(name, 'ready', root);
  try {
    return await fn({ root, home });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function command(root, args, now = NOW) {
  const { engineCommand } = require('../commands/engine');
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => logs.push(parts.join(' '));
  try {
    const exit = engineCommand(args, { root, now: new Date(now) });
    return { exit, out: logs.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// Runs for one worker, oldest first, a minute apart, ending an hour ago.
function seed(root, engine, outcomes, { model = '', job = 'small build', endAt = NOW - 3600000 } = {}) {
  const { appendRosterRun } = require('../lib/roster-runs');
  outcomes.forEach((outcome, index) => {
    const at = new Date(endAt - (outcomes.length - 1 - index) * 60000).toISOString();
    appendRosterRun(root, { at, job, engine, ...(model ? { model } : {}), outcome, seconds: 120 });
  });
}

const DEVIN = { model: 'swe-2-max' };
// Runs record the model as the roster saved it.
const GROK = { model: 'grok-4.7-build-fast' };

function suggestionOf(root, now = NOW) {
  const report = JSON.parse(command(root, ['roster', '--json'], now).out);
  return report.jobs.find((row) => row.job === 'small build').suggestion || null;
}

function rosterText(root) {
  return fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8');
}

test('a lead that keeps stalling and a later worker that keeps landing gets one plain suggestion', async () => {
  await withRoom(async ({ root }) => {
    const before = rosterText(root);
    seed(root, 'devin', ['landed', 'stalled', 'stalled', 'landed', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed', 'landed', 'landed'], GROK);
    const view = command(root, ['roster']);
    assert.equal(view.exit, 0);
    const lines = view.out.split('\n').filter((line) => /suggestion:/.test(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ {2}suggestion: devin \S.* stalled 3 of its last 5 runs; grok \S.* landed 4 of 4\. to move grok up: atris engine assign "small build" --promote "grok [^"]+"$/);
    assert.equal(rosterText(root), before, 'the roster file is never written');
  });
});

test('--json carries the suggestion as data, and its command really reorders the roster', async () => {
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'failed', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed'], GROK);
    const before = rosterText(root);
    const suggestion = suggestionOf(root);
    assert.ok(suggestion);
    assert.equal(suggestion.job, 'small build');
    assert.deepEqual(suggestion.lead, { engine: 'devin', model: suggestion.lead.model, runs: 3, landed: 0 });
    assert.equal(suggestion.challenger.engine, 'grok');
    assert.equal(suggestion.challenger.runs, 2);
    assert.equal(suggestion.challenger.landed, 2);
    assert.match(suggestion.text, /devin \S.* landed 0 of its last 3 runs; grok/);
    assert.ok(suggestion.command.startsWith('atris engine assign "small build" --promote "grok'));
    assert.equal(rosterText(root), before, 'reading the suggestion never writes the roster');
    // A person running the suggested command puts grok first and keeps devin next.
    assert.equal(command(root, suggestion.args).exit, 0);
    const workers = rosterText(root).split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split(',')[0]);
    assert.deepEqual(workers, ['grok', 'devin', 'cursor']);
  });
});

test('the suggestion appears exactly at the run-count thresholds and not below', async () => {
  const { SUGGEST_MIN_LEAD_RUNS, SUGGEST_MIN_CHALLENGER_RUNS } = require('../lib/roster-suggest');
  assert.equal(SUGGEST_MIN_LEAD_RUNS, 3);
  assert.equal(SUGGEST_MIN_CHALLENGER_RUNS, 2);
  // At both minimums: a suggestion.
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed'], GROK);
    assert.ok(suggestionOf(root));
  });
  // One lead run short: none.
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed'], GROK);
    assert.equal(suggestionOf(root), null);
  });
  // One challenger run short: none.
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed'], GROK);
    assert.equal(suggestionOf(root), null);
  });
});

test('the suggestion appears exactly at the rate thresholds and not past them', async () => {
  const { SUGGEST_LEAD_BELOW_POINTS, SUGGEST_MIN_GAP_POINTS } = require('../lib/roster-suggest');
  assert.equal(SUGGEST_LEAD_BELOW_POINTS, 50);
  assert.equal(SUGGEST_MIN_GAP_POINTS, 25);
  // Lead 25%, challenger 50%: a gap of exactly 25 points suggests.
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['landed', 'stalled', 'stalled', 'failed'], DEVIN);
    seed(root, 'grok', ['landed', 'failed'], GROK);
    const suggestion = suggestionOf(root);
    assert.ok(suggestion);
    assert.match(suggestion.text, /devin \S.* landed 1 of its last 4 runs; grok \S.* landed 1 of 2/);
  });
  // Lead 25%, challenger 40%: a 15 point gap does not.
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['landed', 'stalled', 'stalled', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed', 'failed', 'failed', 'failed'], GROK);
    assert.equal(suggestionOf(root), null);
  });
  // Lead exactly 50%: not below half, so none even against a perfect record.
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['landed', 'landed', 'stalled', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed', 'landed', 'landed'], GROK);
    assert.equal(suggestionOf(root), null);
  });
});

test('only the last 7 days and each worker\'s newest 5 runs count; credit out is not held against a worker', async () => {
  // Old stalls from last week are forgotten.
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled', 'stalled'], { ...DEVIN, endAt: NOW - 8 * 86400000 });
    seed(root, 'grok', ['landed', 'landed'], GROK);
    assert.equal(suggestionOf(root), null);
  });
  // Early misses fall out of the window once the newest 5 are mostly landed.
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled', 'stalled', 'landed', 'landed', 'landed', 'stalled', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed', 'landed'], GROK);
    assert.equal(suggestionOf(root), null);
  });
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['credit out', 'credit out', 'credit out', 'landed'], DEVIN);
    seed(root, 'grok', ['landed', 'landed'], GROK);
    assert.equal(suggestionOf(root), null);
  });
});

test('a challenger that is cooling or expired is never suggested', async () => {
  const { recordEngineRunHealth } = require('../lib/engine-registry');
  // The registry settles a bench against the real clock when it reads, so
  // this room runs on the real time instead of the fixed one.
  const now = Date.now();
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled', 'stalled'], { ...DEVIN, endAt: now - 3600000 });
    seed(root, 'grok', ['landed', 'landed', 'landed'], { ...GROK, endAt: now - 3600000 });
    assert.ok(suggestionOf(root, now), 'ready grok is suggested');
    // A stall a minute ago benches grok for 30 minutes.
    recordEngineRunHealth('grok', { exitCode: null, timed_out: true, max_seconds: 1800 }, root, { now: new Date(now - 60000) });
    assert.equal(suggestionOf(root, now), null);
    assert.doesNotMatch(command(root, ['roster'], now).out, /suggestion:/);
    // Once the bench is over, the same record suggests grok again.
    assert.ok(suggestionOf(root, now + 3600000));
  });
  const dated = ROSTER.replace('- grok, model: grok 4.7 fast, max: 30 min', '- grok, model: grok 4.7 fast, max: 30 min, until 2026-09-01');
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed', 'landed'], GROK);
    assert.equal(suggestionOf(root), null);
  }, { roster: dated });
});

test('the next best ready worker is suggested when a better one is cooling', async () => {
  const { recordEngineRunHealth } = require('../lib/engine-registry');
  const now = Date.now();
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled', 'stalled'], { ...DEVIN, endAt: now - 3600000 });
    seed(root, 'grok', ['landed', 'landed', 'landed'], { ...GROK, endAt: now - 3600000 });
    seed(root, 'cursor', ['landed', 'failed'], { endAt: now - 3600000 });
    // A stall a minute ago benches grok for 30 minutes.
    recordEngineRunHealth('grok', { exitCode: null, timed_out: true, max_seconds: 1800 }, root, { now: new Date(now - 60000) });
    const suggestion = suggestionOf(root, now);
    assert.ok(suggestion);
    assert.equal(suggestion.challenger.engine, 'cursor');
  });
});

test('no record, a single-worker job, or a job with no roster line has no suggestion', async () => {
  await withRoom(async ({ root }) => {
    const report = JSON.parse(command(root, ['roster', '--json']).out);
    assert.ok(report.jobs.every((row) => !row.suggestion));
  });
  await withRoom(async ({ root }) => {
    seed(root, 'devin', ['stalled', 'stalled', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed', 'landed'], GROK);
    assert.equal(suggestionOf(root), null);
  }, { roster: '# roster\n\n## small build\n- devin, model: swe-2-max\n' });
});

test('the boot line gets a short marker only when a job has a suggestion', async () => {
  const { bootTeamLine } = require('../lib/team-lineup');
  await withRoom(async ({ root }) => {
    const plain = bootTeamLine(root, { width: 200, now: new Date(NOW) });
    assert.ok(plain);
    assert.doesNotMatch(plain, /suggestion/);
    seed(root, 'devin', ['stalled', 'landed', 'stalled'], DEVIN);
    seed(root, 'grok', ['landed', 'landed'], GROK);
    const marked = bootTeamLine(root, { width: 200, now: new Date(NOW) });
    assert.ok(marked.endsWith(' · 1 suggestion (atris engine roster)'), marked);
    assert.equal(marked.replace(' · 1 suggestion (atris engine roster)', ''), plain);
    // Narrow lines drop the custom jobs but keep the marker.
    const narrow = bootTeamLine(root, { width: 40, now: new Date(NOW) });
    assert.match(narrow, / · 1 suggestion \(atris engine roster\)$/);
  });
});

test('the real boot shows the marker from the end of the record, and leaves the roster alone', async () => {
  await withRoom(async ({ root, home }) => {
    const before = rosterText(root);
    const endAt = Date.now() - 3600000;
    seed(root, 'devin', ['stalled', 'stalled', 'stalled'], { ...DEVIN, endAt });
    seed(root, 'grok', ['landed', 'landed'], { ...GROK, endAt });
    const boot = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'atris.md'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_MACHINE_ROSTER_PATH: path.join(home, '.atris', 'roster.json'),
        ATRIS_ROSTER_SESSION: '',
        ATRIS_CODEX_CONFIG_PATH: path.join(home, 'no-codex-config.toml'),
        ATRIS_RUNNER_MODEL: '',
        ATRIS_ROUTER_EXPLAIN: '0',
        ATRIS_TASKS_DB: path.join(home, 'tasks.db'),
        NODE_NO_WARNINGS: '1',
      },
    });
    assert.equal(boot.status, 0, boot.stderr);
    const [line] = boot.stdout.split('\n').filter((text) => /^ {2}team /.test(text));
    assert.match(line, / · 1 suggestion \(atris engine roster\)$/);
    assert.equal(rosterText(root), before);
  });
});

test('the router ranks the same with no record, and shifts toward the worker that lands', async () => {
  const { rankEnginesDetailed, loadRouterHistory } = require('../lib/router-brain');
  const candidates = [{ id: 'codex', fallback_order: 10 }, { id: 'cursor', fallback_order: 30 }];
  await withRoom(async ({ root }) => {
    assert.deepEqual(loadRouterHistory(root, { now: NOW }), []);
    const none = rankEnginesDetailed(candidates, { root, taskType: 'executor', now: NOW });
    assert.deepEqual(none.candidates.map((row) => row.id), ['codex', 'cursor']);
    assert.equal(none.used_track_record, false);
    seed(root, 'codex', ['stalled', 'failed', 'stalled'], { job: 'build' });
    seed(root, 'cursor', ['landed', 'landed', 'landed'], { job: 'small build' });
    // Credit out says nothing about the work and is left out.
    seed(root, 'codex', ['credit out'], { job: 'build' });
    const history = loadRouterHistory(root, { now: NOW });
    assert.equal(history.length, 6);
    assert.ok(history.every((row) => row.task_type === 'executor'));
    const shifted = rankEnginesDetailed(candidates, { root, taskType: 'executor', now: NOW });
    assert.equal(shifted.used_track_record, true);
    assert.deepEqual(shifted.candidates.map((row) => row.id), ['cursor', 'codex']);
    // Review runs rank reviewers, not builders.
    const review = rankEnginesDetailed(candidates, { root, taskType: 'validator', now: NOW });
    assert.deepEqual(review.candidates.map((row) => row.id), ['codex', 'cursor']);
  });
});
