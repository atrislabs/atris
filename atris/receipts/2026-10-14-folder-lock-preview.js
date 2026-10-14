'use strict';

// Read-only cleanup preview against disposable, real Git repositories.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function main() {
  const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const cli = path.resolve(__dirname, '../../bin/atris.js');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lock-preview-')));
  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: fixtureEnv });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const repo = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  const copies = path.join(base, 'copies');
  fs.mkdirSync(repo);
  git(base, 'init', '-q', '--bare', '-b', 'master', remote);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'master');
  const copy = path.join(copies, 'landed-with-lock');
  git(repo, 'worktree', 'add', '-q', '-b', 'landed-with-lock', copy);
  const lock = path.join(git(copy, 'rev-parse', '--absolute-git-dir'), 'index.lock');
  fs.writeFileSync(lock, 'fixture lock\n');
  const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lock, aged, aged);
  const result = spawnSync(process.execPath, [cli, 'member', 'tidy', '--dry-run', '--dir', copies], {
    cwd: repo, encoding: 'utf8', timeout: 90000,
    env: { ...fixtureEnv, ATRIS_NO_UPDATE_CHECK: '1' },
  });
  console.log(`fixture: ${base}`);
  console.log(`lock: ${lock}`);
  console.log(`lock age seconds: ${Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000)}`);
  console.log(result.stdout.trim());
  if (result.stderr.trim()) console.log(result.stderr.trim());
  console.log(`cli exit: ${result.status}`);
  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(copy));
  assert.ok(fs.existsSync(lock));
  assert.equal(fs.existsSync(path.join(repo, '.atris/state/worktree_removals.jsonl')), false);
  console.log(`unsafe preview observed: ${/would remove\s+landed-with-lock/.test(result.stdout)}`);
  console.log(`exact lock reported: ${result.stdout.includes(lock)}`);
  console.log('fixture retained for inspection; no folder removal attempted');

}

if (require.main === module) main();
