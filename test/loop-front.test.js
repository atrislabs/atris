'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { routeLoop, renderLoopHome } = require('../commands/loop-front');
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
