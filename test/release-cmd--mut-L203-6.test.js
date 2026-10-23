'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { releasePreflight } = require('../commands/release');

test('preflight treats failed revision output as a missing local master', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-missing-master-'));
  const savedEnv = { ...process.env };
  const originalLog = console.log;
  t.after(() => {
    console.log = originalLog;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) delete process.env[key];
  }
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(cwd, 'no-global-config'),
  });
  execFileSync('git', ['init', '--initial-branch=master', '--template='], {
    cwd, stdio: 'pipe',
  });

  // With no commits, git rev-parse master fails but prints "master" to stdout.
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  const result = releasePreflight({
    cwd,
    runTests: () => assert.fail('the suite must be skipped after git checks fail'),
  });
  assert.equal(result, 1);
  assert.deepEqual(lines, [
    'fail: current branch is unknown, need master',
    'pass: working tree is clean',
    'fail: local master is missing',
    'fail: package.json version is missing',
    'skip: test suite (earlier checks failed)',
    '',
    'release preflight failed',
  ]);
});
