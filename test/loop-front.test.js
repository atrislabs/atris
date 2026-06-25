'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { routeLoop, renderLoopHome, startLocalOptions, loopFront } = require('../commands/loop-front');
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
