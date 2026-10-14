'use strict';

// Real cleanup commands against a missing disposable locked folder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function main() {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), ATRIS_NO_UPDATE_CHECK: '1' };
  const cli = path.resolve(__dirname, '../../bin/atris.js');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-missing-')));
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
  git(repo, 'worktree', 'lock', '--reason', 'on an unplugged drive', copy);
  const lock = path.join(git(copy, 'rev-parse', '--absolute-git-dir'), 'locked');
  const aged = new Date(Date.now() - 7200000);
  fs.utimesSync(lock, aged, aged);
  // Only this generated fixture folder is removed to reproduce a missing drive.
  fs.rmSync(copy, { recursive: true, force: true });
  console.log(`fixture: ${base}`);
  for (const preview of [true, false]) {
    const args = [cli, 'land', '--reap', '--force', '--no-remote', ...(preview ? ['--dry-run'] : [])];
    const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
    console.log(`command: node bin/atris.js ${args.slice(1).join(' ')}`);
    console.log(result.stdout.trim());
    if (result.stderr.trim()) console.log(result.stderr.trim());
    console.log(`cli exit: ${result.status}`);
    assert.equal(result.status, 0);
    assert.ok(fs.existsSync(lock));
    assert.ok(result.stdout.includes('folder is missing; git lock: ' + lock));
    assert.match(result.stdout.slice(result.stdout.indexOf(lock) + lock.length), /^ \(\d+s old\)/);
    assert.equal(fs.existsSync(copy), false);
    git(repo, 'rev-parse', '--verify', 'refs/heads/landed-with-lock');
    assert.equal(fs.existsSync(path.join(repo, '.atris/state/worktree_removals.jsonl')), false);
  }
  console.log('missing folder reported; lock and branch retained; no removal recorded');
}

if (require.main === module) main();
