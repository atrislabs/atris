'use strict';

// A heavy roster worker can ask for a prep pass ("prep: search"): the search
// job's lead reads the task first and writes a trimmed brief, and the heavy
// worker works from that brief. Also covers the run record's own upkeep: the
// file is trimmed when it grows past its cap, and a hand-edited line with odd
// field types never crashes the view. Every room is a scratch project with a
// scratch home, fake engines sit on PATH, and the clock is injected, so the
// real ~/.atris is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
  'PATH',
];

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

async function withRoom(fn, { roster = '' } = {}) {
  const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prep-brief-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prep-brief-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prep-brief-bin-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prep-brief-wt-'));
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['init', '-q', wt]);
  fs.mkdirSync(path.join(root, 'atris'));
  if (roster) fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), roster);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) if (key !== 'PATH') delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
  readEngineRegistry(root);
  for (const name of ['devin', 'grok', 'cursor', 'codex', 'claude', 'haiku']) setEngineHealth(name, 'ready', root);
  try {
    return await fn({ root, home, bin, wt });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home, bin, wt]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function command(root, args) {
  const { engineCommand } = require('../commands/engine');
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => logs.push(parts.join(' '));
  try {
    const exit = engineCommand(args, { root, now: new Date(NOW + 3600000) });
    return { exit, out: logs.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// --- the run record's own upkeep ------------------------------------------

test('the run record is trimmed to its newest whole lines once it passes its size cap', async () => {
  await withRoom(async ({ root }) => {
    const runs = require('../lib/roster-runs');
    const file = runs.rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (i) => JSON.stringify({ at: new Date(NOW).toISOString(), job: 'build', engine: 'cursor', outcome: 'landed', task: `CLI-${i}`, detail: 'x'.repeat(200) });
    const lines = [];
    let bytes = 0;
    for (let i = 0; bytes <= runs.RUNS_ROTATE_BYTES; i += 1) {
      const text = `${line(i)}\n`;
      lines.push(text);
      bytes += Buffer.byteLength(text);
    }
    fs.writeFileSync(file, lines.join(''));
    runs.appendRosterRun(root, { at: new Date(NOW).toISOString(), job: 'build', engine: 'devin', outcome: 'landed', task: 'CLI-LAST' });
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(after) <= runs.RUNS_KEEP_BYTES, `kept ${Buffer.byteLength(after)} bytes`);
    const kept = after.split('\n').filter(Boolean);
    for (const row of kept) JSON.parse(row);
    assert.equal(JSON.parse(kept[kept.length - 1]).task, 'CLI-LAST');
    assert.ok(kept.length > 100);
    assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp')).length, 0);
  });
});

test('a record line with odd field types reads cleanly and never crashes the runs view', async () => {
  await withRoom(async ({ root }) => {
    const runs = require('../lib/roster-runs');
    const file = runs.rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date(NOW).toISOString();
    fs.writeFileSync(file, [
      JSON.stringify({ at, job: 'build', engine: 'cursor', outcome: 'landed', cost_usd: '0.42', tokens: '1200', seconds: 'soon', max_seconds: {}, model: 7, detail: ['x'], task: '  CLI-1  ' }),
      JSON.stringify({ at, job: 5, engine: 'devin', outcome: 'failed', tokens: null, handed_over_to: { who: 'x' }, brief_bytes: 'big' }),
      '',
    ].join('\n'));
    const rows = runs.readRosterRuns(root, { now: NOW + 60000 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].cost_usd, 0.42);
    assert.equal(rows[0].tokens, 1200);
    assert.equal('seconds' in rows[0], false);
    assert.equal('max_seconds' in rows[0], false);
    assert.equal('model' in rows[0], false);
    assert.equal('detail' in rows[0], false);
    assert.equal(rows[0].task, 'CLI-1');
    assert.equal('handed_over_to' in rows[1], false);
    assert.equal('brief_bytes' in rows[1], false);
    for (const row of rows) runs.renderRunLine(row);
    const listed = command(root, ['roster', '--runs']);
    assert.equal(listed.exit, 0);
    assert.match(listed.out, /\$0\.42/);
  });
});

// --- the prep field on a roster line ---------------------------------------

const PREP_ROSTER = `# roster

## search
- claude, model: haiku, max: 2 min

## build
- cursor, max: 20 min, prep: search
- devin, model: swe-2-max
`;

test('a worker line reads "prep: search" and the roster view says "prepped by search"', async () => {
  await withRoom(async ({ root }) => {
    const { readRosterState } = require('../lib/engine-registry');
    const picks = readRosterState(root).project.picks;
    assert.equal(picks.executor.workers[0].prep, 'navigator');
    assert.equal('prep' in picks.executor.workers[1], false);
    const view = command(root, ['roster']);
    assert.equal(view.exit, 0);
    assert.match(view.out, /build .*prepped by search/);
    const json = JSON.parse(command(root, ['roster', '--json']).out);
    const build = json.jobs.find((row) => row.job === 'build');
    assert.equal(build.prep, 'search');
    assert.deepEqual(build.workers.map((worker) => worker.prep), ['search', null]);
  }, { roster: PREP_ROSTER });
});

test('prep naming its own job warns in plain words and the worker still counts', async () => {
  await withRoom(async ({ root }) => {
    const { readRosterState } = require('../lib/engine-registry');
    const layer = readRosterState(root).project;
    assert.equal(layer.picks.executor.engine, 'cursor');
    assert.equal('prep' in layer.picks.executor.workers[0], false);
    assert.match(layer.warnings.map((w) => w.message).join('\n'), /asks build to prep for itself, so this worker runs without prep/);
    const view = command(root, ['roster']);
    assert.equal(view.exit, 0);
    assert.doesNotMatch(view.out, /prepped by/);
  }, { roster: '# roster\n\n## build\n- cursor, prep: build\n' });
});

test('assign --prep writes the field, and refuses a job prepping for itself', async () => {
  await withRoom(async ({ root }) => {
    const written = command(root, ['assign', 'review', 'claude', '--prep', 'search']);
    assert.equal(written.exit, 0, written.out);
    assert.match(fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8'), /## review\n- claude code, prep: search\n/);
    assert.match(written.out, /review .*prepped by search/);
    const refused = command(root, ['assign', 'build', 'cursor', '--prep', 'build']);
    assert.equal(refused.exit, 2);
    assert.match(refused.out, /build cannot prep for itself/);
    const bad = command(root, ['assign', 'build', 'cursor', '--prep', '???']);
    assert.equal(bad.exit, 2);
    assert.match(bad.out, /is not a job name/);
  });
});
