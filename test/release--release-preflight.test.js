'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { releasePreflight } = require('../commands/release');

function fixture(t, { repository = true, version = '1.2.3' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-preflight-'));
  const savedEnv = { ...process.env };
  const originalLog = console.log;
  const lines = [];
  t.after(() => {
    console.log = originalLog;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_') || key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'absent-gitconfig'),
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2020-01-02T12:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-02T12:00:00Z',
  });
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (repository) {
    git('init', '--initial-branch=master', '--template=');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version }));
    git('add', 'package.json');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial fixture');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  }
  console.log = (...args) => lines.push(args.join(' '));
  return { cwd, git, lines };
}

test('releasePreflight passes a clean master matching origin with an unused version', t => {
  const { cwd, lines } = fixture(t, { version: ' 1.2.3 ' });
  const calls = [];
  const result = releasePreflight({ cwd, runTests: directory => {
    calls.push(directory);
    return { status: 0 };
  } });
  assert.strictEqual(result, 0);
  assert.deepStrictEqual(calls, [cwd]);
  assert.deepStrictEqual(lines, [
    'pass: current branch is master',
    'pass: working tree is clean',
    'pass: local master matches origin/master',
    'pass: no tag v1.2.3',
    'pass: test suite',
    '',
    'release preflight passed',
  ]);
});

test('releasePreflight rejects an existing version tag and skips the suite', t => {
  const { cwd, git, lines } = fixture(t);
  git('tag', 'v1.2.3');
  let calls = 0;
  assert.strictEqual(releasePreflight({ cwd, runTests: () => { calls++; return { status: 0 }; } }), 1);
  assert.strictEqual(calls, 0);
  assert.ok(lines.includes('fail: tag v1.2.3 already exists'));
  assert.ok(lines.includes('skip: test suite (earlier checks failed)'));
  assert.strictEqual(lines.at(-1), 'release preflight failed');
});

test('releasePreflight reports a suite that cannot start', t => {
  const { cwd, lines } = fixture(t);
  assert.strictEqual(releasePreflight({ cwd, runTests: () => ({ error: new Error('runner unavailable') }) }), 1);
  assert.ok(lines.includes('fail: test suite could not run (runner unavailable)'));
  assert.strictEqual(lines.at(-1), 'release preflight failed');
});

test('releasePreflight reports a nonzero suite exit', t => {
  const { cwd, lines } = fixture(t);
  assert.strictEqual(releasePreflight({ cwd, runTests: () => ({ status: 7 }) }), 1);
  assert.ok(lines.includes('fail: test suite exited 7'));
  assert.strictEqual(lines.at(-1), 'release preflight failed');
});

test('releasePreflight rejects an empty directory without running the suite', t => {
  const { cwd, lines } = fixture(t, { repository: false });
  let calls = 0;
  assert.strictEqual(releasePreflight({ cwd, runTests: () => { calls++; return { status: 0 }; } }), 1);
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(lines, [
    'fail: current branch is unknown, need master',
    'fail: working tree is not clean',
    'fail: local master is missing',
    'fail: package.json version is missing',
    'skip: test suite (earlier checks failed)',
    '',
    'release preflight failed',
  ]);
});
