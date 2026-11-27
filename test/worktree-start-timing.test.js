'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('start fetches its base once and uses local origin refs', (t) => {
  const dir = fs.mkdtempSync(path.join(__dirname, 'worktree-timing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const origin = path.join(dir, 'origin.git');
  fs.mkdirSync(root);
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(dir, ['init', '--bare', '-q', origin]);
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'source'), 'base\n');
  git(root, ['add', 'source']);
  git(root, ['commit', '-qm', 'base']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-qu', 'origin', 'master']);
  git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');\nconst result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });
  const started = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'start', '--agent', 'tester', '--task', 'timing', '--path', path.join(dir, 'copy'), '--no-deps'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TIMING: '1' },
  });
  assert.equal(started.status, 0, started.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(({ args }) => args[0] === 'fetch').length, 1, 'one fetch per start');
  assert.equal(calls.filter(({ args }) => args[0] === 'ls-remote').length, 0, 'local refs avoid ls-remote');
  assert.equal(calls.filter(({ args, cwd }) => args[0] === 'status' && cwd === root).length, 1, 'one status for the starting checkout');
  assert.match(started.stderr, /timing: git fetch origin master \d+ms/);
  assert.match(started.stderr, /timing: start complete \d+ms elapsed/);
});
