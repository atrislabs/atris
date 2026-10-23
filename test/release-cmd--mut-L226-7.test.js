'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { releasePreflight } = require('../commands/release');

test('release preflight reports a dirty master and skips the test suite', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-dirty-master-'));
  const savedEnv = { ...process.env };
  const originalLog = console.log;
  t.after(() => {
    console.log = originalLog;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'absent-gitconfig'),
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release@example.invalid',
    GIT_AUTHOR_DATE: '2020-01-02T12:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-02T12:00:00Z',
  });
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
  });
  git('init', '--initial-branch=master', '--template=');
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n');
  git('add', 'package.json');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial fixture');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  fs.appendFileSync(path.join(root, 'package.json'), '\n');
  assert.equal(git('status', '--porcelain').trim(), 'M package.json');

  const lines = [];
  let suiteCalls = 0;
  console.log = (...args) => lines.push(args.join(' '));
  const result = releasePreflight({
    cwd: root,
    runTests: () => { suiteCalls++; return { status: 0 }; },
  });
  console.log = originalLog;

  assert.deepEqual(lines, [
    'pass: current branch is master',
    'fail: working tree is not clean',
    'pass: local master matches origin/master',
    'pass: no tag v1.2.3',
    'skip: test suite (earlier checks failed)',
    '',
    'release preflight failed',
  ]);
  assert.equal(result, 1);
  assert.equal(suiteCalls, 0);
});
