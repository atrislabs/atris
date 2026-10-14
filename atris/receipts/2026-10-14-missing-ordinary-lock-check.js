'use strict';

// Real cleanup preview and execution against a moved disposable folder with Git locks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function main() {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), ATRIS_NO_UPDATE_CHECK: '1' };
  const cli = path.resolve(__dirname, '../../bin/atris.js');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-missing-ordinary-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const copy = path.join(base, 'landed-with-lock');
  git(repo, 'worktree', 'add', '-q', '-b', 'landed-with-lock', copy);
  const privateDir = git(copy, 'rev-parse', '--absolute-git-dir');
  const locks = [path.join(privateDir, 'index.lock'), path.join(repo, '.git', 'packed-refs.lock')];
  const aged = new Date(Date.now() - 7200000);
  for (const lock of locks) {
    fs.writeFileSync(lock, 'fixture lock\n');
    fs.utimesSync(lock, aged, aged);
  }
  const moved = path.join(base, 'moved-copy');
  fs.renameSync(copy, moved);
  console.log(`fixture: ${base}`);
  for (const preview of [true, false]) {
    const args = [cli, 'land', '--reap', '--force', '--no-remote', ...(preview ? ['--dry-run'] : [])];
    const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
    console.log(`command: node bin/atris.js ${args.slice(1).join(' ')}`);
    console.log(result.stdout.trim());
    if (result.stderr.trim()) console.log(result.stderr.trim());
    console.log(`cli exit: ${result.status}`);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('folder is missing'));
    for (const lock of locks) {
      assert.ok(fs.existsSync(lock));
      console.log(`retained lock: ${lock} (${Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000)}s old)`);
      console.log(`lock reported: ${result.stdout.includes(lock)}`);
      assert.equal(result.stdout.includes(lock), false);
    }
    assert.equal(fs.readFileSync(path.join(moved, 'README.md'), 'utf8'), '# fixture\n');
    assert.equal(fs.existsSync(copy), false);
    git(repo, 'rev-parse', '--verify', 'refs/heads/landed-with-lock');
    assert.equal(fs.existsSync(path.join(repo, '.atris/state/worktree_removals.jsonl')), false);
  }
  console.log('preview and cleanup reported a missing folder; both omitted two ordinary lock paths; moved files and branch retained; no removal recorded');
}

if (require.main === module) main();
