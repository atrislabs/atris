'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-help-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('mission start --help is read-only and does not create a --help mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['mission', 'start', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris mission start/);
    assert.doesNotMatch(res.stdout, /Started mission: --help/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'mission_events.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission mutating subcommand help exits before real handlers', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const cases = [
      ['run', /Usage: atris mission run/],
      ['tick', /Usage: atris mission tick/],
      ['complete', /Usage: atris mission complete/],
      ['stop', /Usage: atris mission stop/],
      ['pause', /Usage: atris mission stop/],
    ];

    for (const [subcommand, pattern] of cases) {
      const res = runCli(['mission', subcommand, '--help'], { cwd: dir });
      assert.equal(res.status, 0, `${subcommand}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, pattern, subcommand);
      assert.doesNotMatch(res.stderr, /Mission ".+" not found|No mission found|Usage:/, subcommand);
    }
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});
