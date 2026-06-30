'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { routeLoop, renderLoopHome, startLocalOptions, loopFront, localRunSummary, loopStatusJson, loopReport, renderLoopReport } = require('../commands/loop-front');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loop-front-'));
}

function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

test('routeLoop maps bare invocation to the loop home', () => {
  assert.deepEqual(routeLoop([]), { action: 'home' });
});

test('routeLoop maps start to a local run, and --once carries through', () => {
  assert.deepEqual(routeLoop(['start']), { action: 'start-local', once: false });
  assert.deepEqual(routeLoop(['start', '--once']), { action: 'start-local', once: true });
});

test('routeLoop maps --overnight and --cloud to the durable heartbeat', () => {
  assert.equal(routeLoop(['start', '--overnight']).action, 'start-overnight');
  assert.equal(routeLoop(['start', '--cloud']).action, 'start-overnight');
});

test('routeLoop maps status and stop to the watch/stop actions', () => {
  assert.equal(routeLoop(['status']).action, 'status');
  assert.equal(routeLoop(['stop']).action, 'stop');
});

test('routeLoop forwards wiki upkeep with its remaining flags', () => {
  assert.deepEqual(routeLoop(['wiki']), { action: 'wiki', rest: [] });
  assert.deepEqual(routeLoop(['wiki', '--json']), { action: 'wiki', rest: ['--json'] });
});

test('routeLoop parses `add` and joins its multi-word text', () => {
  assert.deepEqual(routeLoop(['add', 'ship', 'dark', 'mode']), { action: 'add', text: 'ship dark mode' });
  assert.equal(routeLoop(['add']).text, '');
});

test('`atris loop add` puts a bounded task into the queue', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['loop', 'add', 'ship it'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /added to the loop: ship it/);
    assert.match(fs.readFileSync(path.join(dir, 'ROADMAP.md'), 'utf8'), /- \[ \] ship it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('`atris loop add` with no text prints usage and writes nothing', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['loop', 'add'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /usage: atris loop add/);
    assert.equal(fs.existsSync(path.join(dir, 'ROADMAP.md')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routeLoop falls back to home for an unknown subcommand', () => {
  const r = routeLoop(['frobnicate']);
  assert.equal(r.action, 'home');
  assert.equal(r.unknown, 'frobnicate');
});

test('routeLoop flags a stray start flag, and home hints the fix', () => {
  const r = routeLoop(['--overnight']);
  assert.equal(r.action, 'home');
  assert.equal(r.strayStartFlag, '--overnight');
  assert.match(renderLoopHome(r), /did you mean: atris loop start --overnight/);
});

test('localRunSummary counts run logs and names the latest', () => {
  const dir = makeTempDir();
  try {
    assert.deepEqual(localRunSummary(path.join(dir, 'absent')), { count: 0, latest: null });
    fs.writeFileSync(path.join(dir, '2026-06-25-100000-cycle-1.md'), 'x');
    fs.writeFileSync(path.join(dir, '2026-06-25-100001-cycle-2.md'), 'x');
    const s = localRunSummary(dir);
    assert.equal(s.count, 2);
    assert.equal(s.latest, '2026-06-25-100001-cycle-2.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loopReport groups roadmap state and renders without an em dash', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'),
      '# R\n\n## Open loop items\n\n- [x] did it\n- [~] doing it\n- [ ] todo\n', 'utf8');
    const rep = loopReport(dir);
    assert.equal(rep.action, 'loop_report');
    assert.deepEqual(rep.roadmap.done, ['did it']);
    assert.deepEqual(rep.roadmap.claimed, ['doing it']);
    assert.deepEqual(rep.roadmap.open, ['todo']);
    const out = renderLoopReport(rep);
    assert.match(out, /1 done, 1 in flight, 1 queued/);
    assert.match(out, /\[x\] did it/);
    assert.equal(out.includes('—'), false, 'no em dash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loop ranked source combines roadmap, active missions, and endgame', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'),
      '# R\n\n## Open loop items\n\n- [ ] roadmap gate\n', 'utf8');
    fs.appendFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-ranked',
      objective: 'active mission gate',
      owner: 'mission-lead',
      status: 'planning',
      runner: 'codex_goal',
      verifier: 'true',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'state.json'), JSON.stringify({
      endgame: { horizon: 'endgame gate', source: 'test horizon' },
    }), 'utf8');

    const moves = require('../lib/next-moves').nextMoves(dir, 3);
    assert.deepEqual(moves.map((move) => move.source), ['roadmap', 'mission', 'endgame']);
    assert.deepEqual(moves.map((move) => move.title), ['roadmap gate', 'active mission gate', 'endgame gate']);

    const status = loopStatusJson(dir);
    assert.deepEqual(status.next_moves.map((move) => move.source).slice(0, 3), ['roadmap', 'mission', 'endgame']);
    const report = loopReport(dir);
    assert.deepEqual(report.next_moves.map((move) => move.source).slice(0, 3), ['roadmap', 'mission', 'endgame']);
    const home = renderLoopHome({ action: 'home' }, moves);
    assert.match(home, /\[roadmap\] roadmap gate/);
    assert.match(home, /\[mission\] active mission gate/);
    assert.match(home, /\[endgame\] endgame gate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('`atris loop report --json` prints a valid proof object', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), '# R\n\n## Open loop items\n\n- [x] shipped thing\n', 'utf8');
    const res = runCli(['loop', 'report', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.action, 'loop_report');
    assert.deepEqual(parsed.roadmap.done, ['shipped thing']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loopStatusJson returns one combined object (pulse + local_runs)', () => {
  const out = loopStatusJson(makeTempDir());
  assert.equal(out.ok, true);
  assert.equal(out.action, 'loop_status');
  assert.ok('pulse' in out, 'has a pulse field');
  assert.ok('local_runs' in out, 'has a local_runs field');
  assert.equal(typeof out.local_runs.count, 'number');
});

test('`atris loop status --json` prints one valid combined object', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['loop', 'status', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.action, 'loop_status');
    assert.equal(parsed.local_runs.count, 0, 'a fresh dir has no local runs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startLocalOptions parses the run flags it forwards', () => {
  assert.deepEqual(
    startLocalOptions(['--cycles=3', '--timeout=300', '--no-push', '-v']),
    { once: false, verbose: true, dryRun: false, push: false, maxCycles: 3, timeout: 300000 }
  );
  assert.equal('maxCycles' in startLocalOptions(['--cycles=abc']), false, 'non-numeric cycles is ignored');
  assert.deepEqual(startLocalOptions([]), { once: false, verbose: false, dryRun: false, push: true });
});

test('loopFront delegates to pulse/run with the right args and exit codes', async () => {
  const pulsePath = require.resolve('../commands/pulse');
  const runPath = require.resolve('../commands/run');
  const origPulse = require.cache[pulsePath];
  const origRun = require.cache[runPath];
  const calls = [];
  require.cache[pulsePath] = {
    id: pulsePath, filename: pulsePath, loaded: true,
    exports: { pulseCommand: (args) => { calls.push(args); return args[0] === 'status' ? { ok: false } : { ok: true }; } },
  };
  require.cache[runPath] = {
    id: runPath, filename: runPath, loaded: true,
    exports: { runAtris: () => { calls.push(['run']); return Promise.resolve(); } },
  };
  try {
    assert.equal(await loopFront(['status']), 1, 'a failed pulse status maps to exit 1');
    assert.equal(await loopFront(['stop']), 0);
    assert.deepEqual(calls.find((c) => c[0] === 'uninstall'), ['uninstall']);
    assert.equal(await loopFront(['start', '--overnight', '--cadence', '30m']), 0);
    assert.deepEqual(calls.find((c) => c[0] === 'install'), ['install', '--cadence', '30m'], 'start/--overnight stripped, --cadence kept');
    assert.equal(await loopFront(['start']), 0);
    assert.ok(calls.some((c) => c[0] === 'run'), 'local start delegates to runAtris');
  } finally {
    if (origPulse) require.cache[pulsePath] = origPulse; else delete require.cache[pulsePath];
    if (origRun) require.cache[runPath] = origRun; else delete require.cache[runPath];
  }
});

test('loop home names the next moves and avoids jargon and em dashes', () => {
  const home = renderLoopHome();
  assert.match(home, /the self-improvement loop/);
  assert.match(home, /atris loop start/);
  assert.match(home, /atris loop status/);
  assert.match(home, /atris loop wiki/);
  assert.equal(home.includes('—'), false, 'no em dash');
  assert.equal(/Wiki Loop|Pages:/.test(home), false, 'home is not the wiki report');
});

test('bare `atris loop` prints the loop home and writes nothing', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['loop'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /the self-improvement loop/);
    assert.match(res.stdout, /atris loop start/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'home must not init a workspace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('`atris loop wiki` still runs the wiki upkeep analysis', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Temp\n', 'utf8');
    runCli(['init'], { cwd: dir });
    const res = runCli(['loop', 'wiki'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
