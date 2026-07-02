const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  pickRunnableMission,
  runObjective,
  runBudgetSeconds,
  runTickBudget,
} = require('../commands/run-front');
const {
  requestStop,
  clearStop,
  stopRequested,
  writeState,
  readState,
} = require('../commands/autopilot-front');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...(options.env || {}) },
  });
}

test('runObjective keeps words, drops flags and their values', () => {
  assert.equal(runObjective(['Fix', 'the', 'login', 'bug', '--minutes', '30', '--json']), 'Fix the login bug');
  assert.equal(runObjective(['--owner', 'growth', '--max-ticks', '4']), '');
});

test('runBudgetSeconds reads minutes and hours', () => {
  assert.equal(runBudgetSeconds(['--minutes', '30']), 1800);
  assert.equal(runBudgetSeconds(['--hours', '2']), 7200);
  assert.equal(runBudgetSeconds([]), null);
});

test('runTickBudget: timed runs are loop contracts, untimed default small', () => {
  assert.equal(runTickBudget([], null), 4);
  assert.equal(runTickBudget([], 3600), 12);
  assert.equal(runTickBudget(['--max-ticks', '2'], 3600), 2);
});

test('pickRunnableMission prefers running over planning, newest first, skips ready', () => {
  const map = new Map([
    ['m1', { id: 'm1', status: 'planning', runner: 'atris2', objective: 'older plan', updated_at: '2026-07-01T01:00:00Z' }],
    ['m2', { id: 'm2', status: 'running', runner: 'atris2', objective: 'old run', updated_at: '2026-07-01T02:00:00Z' }],
    ['m3', { id: 'm3', status: 'running', runner: 'claude', objective: 'new run', updated_at: '2026-07-01T03:00:00Z' }],
    ['m4', { id: 'm4', status: 'ready', runner: 'atris2', objective: 'waiting on review', updated_at: '2026-07-01T04:00:00Z' }],
  ]);
  assert.equal(pickRunnableMission(process.cwd(), map).id, 'm3');
});

test('pickRunnableMission skips session-bound runners a headless loop cannot drive', () => {
  const map = new Map([
    ['m1', { id: 'm1', status: 'running', runner: 'codex_goal', objective: 'waits for a live codex session', updated_at: '2026-07-01T06:00:00Z' }],
    ['m2', { id: 'm2', status: 'running', runner: 'manual', objective: 'waits for a human', updated_at: '2026-07-01T07:00:00Z' }],
    ['m3', { id: 'm3', status: 'running', runner: 'atris2', objective: 'headless drivable', updated_at: '2026-07-01T01:00:00Z' }],
  ]);
  assert.equal(pickRunnableMission(process.cwd(), map).id, 'm3');
  map.delete('m3');
  assert.equal(pickRunnableMission(process.cwd(), map), null);
});

test('pickRunnableMission skips continuation placeholders and empty maps', () => {
  const map = new Map([
    ['m1', { id: 'm1', status: 'running', runner: 'atris2', objective: 'decide and start the next useful mission after: x', updated_at: '2026-07-01T05:00:00Z' }],
  ]);
  assert.equal(pickRunnableMission(process.cwd(), map), null);
  assert.equal(pickRunnableMission(process.cwd(), new Map()), null);
});

test('autopilot stop/state files round-trip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-front-doors-'));
  try {
    assert.equal(stopRequested(root), false);
    requestStop(root);
    assert.equal(stopRequested(root), true);
    clearStop(root);
    assert.equal(stopRequested(root), false);

    writeState(root, { pid: 12345, legs: 2, started_at: '2026-07-01T00:00:00Z' });
    const state = readState(root);
    assert.equal(state.pid, 12345);
    assert.equal(state.legs, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris autopilot stop works with no live process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-front-stop-'));
  try {
    const res = runCli(['autopilot', 'stop'], { cwd: root });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /stop marker written|Stopping autopilot/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris autopilot status reports not running when idle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-front-status-'));
  try {
    const res = runCli(['autopilot', 'status'], { cwd: root });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /not running/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris run with no objective and no missions explains itself', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-front-run-'));
  try {
    const res = runCli(['run'], { cwd: root });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /no runnable mission/i);
    assert.match(res.stdout, /atris run "<objective>"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris run --help describes the mission front door and legacy escape hatch', () => {
  const res = runCli(['run', '--help']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /mission/i);
  assert.match(res.stdout, /--legacy/);
  assert.match(res.stdout, /run logs/);
});

test('atris autopilot --help describes the loop and stop control', () => {
  const res = runCli(['autopilot', '--help']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /until you stop/i);
  assert.match(res.stdout, /autopilot stop/);
  assert.match(res.stdout, /--legacy/);
});

test('legacy help still reachable via --legacy', () => {
  const res = runCli(['autopilot', '--legacy', '--help']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /autopilot/i);
});
