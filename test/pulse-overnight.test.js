'use strict';

// Overnight: the heartbeat pushes campaigns first and keeps the Mac awake for its window.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installCommand, uninstallCommand } = require('../commands/pulse');

function fakes() {
  let launchd = false;
  const spawnSync = (command, args) => {
    if (command === 'which') return { status: 1, stdout: '', stderr: '' };
    if (command === 'crontab') return { status: args[0] === '-l' ? 1 : 0, stdout: '', stderr: '' };
    if (command === 'launchctl') { launchd = args[0] === 'bootstrap'; return { status: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  return { spawnSync, installed: () => launchd };
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-night-'));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  return { root, home: fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-night-home-')) };
}

test('an overnight install holds the Mac awake for exactly its window, and uninstall lets go', { skip: process.platform !== 'darwin' }, () => {
  const { root, home } = workspace();
  const f = fakes();
  const held = [];
  const out = installCommand(['--hours', '6'], root, { homeDir: home, spawnSync: f.spawnSync, writeOutput: () => {}, holdKeepAwake: (stateHome, seconds) => { held.push(seconds); return { pid: 4242, seconds }; } });
  assert.equal(out.ok, true);
  assert.deepEqual(held, [6 * 3600]);
  assert.deepEqual(out.keep_awake, { pid: 4242, seconds: 6 * 3600 });
  const released = [];
  const gone = uninstallCommand([], root, { homeDir: home, spawnSync: f.spawnSync, writeOutput: () => {}, releaseKeepAwake: (stateHome) => { released.push(stateHome); return true; } });
  assert.equal(gone.keep_awake_released, true);
  assert.equal(released.length, 1);
});

test('--no-keep-awake installs without holding the Mac awake', () => {
  const { root, home } = workspace();
  const f = fakes();
  let held = false;
  const out = installCommand(['--hours', '2', '--no-keep-awake'], root, { homeDir: home, spawnSync: f.spawnSync, writeOutput: () => {}, holdKeepAwake: () => { held = true; return { pid: 1, seconds: 1 }; } });
  assert.equal(out.ok, true);
  assert.equal(held, false);
  assert.equal(out.keep_awake, null);
});

test('tests that bring their own spawnSync never start a real caffeinate', () => {
  const { root, home } = workspace();
  const out = installCommand(['--hours', '1'], root, { homeDir: home, spawnSync: fakes().spawnSync, writeOutput: () => {} });
  assert.equal(out.ok, true);
  assert.equal(out.keep_awake, null);
});

test('install --no-autopilot bakes it into every tick of the heartbeat script', () => {
  const { root, home } = workspace();
  const out = installCommand(['--hours', '1', '--no-autopilot'], root, { homeDir: home, spawnSync: fakes().spawnSync, writeOutput: () => {} });
  assert.equal(out.ok, true);
  const script = fs.readFileSync(out.script_path, 'utf8');
  assert.match(script, /pulse tick --json --no-autopilot/);
});
