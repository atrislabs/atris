'use strict';

// Run the real CLI and real git. A forwarding git executable moves only the
// generated copy at the final activity check, after tidy has resolved its real path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), ATRIS_NO_UPDATE_CHECK: '1' };
const located = spawnSync('which', ['git'], { env, encoding: 'utf8' });
assert.equal(located.status, 0, located.stderr);
const realGit = located.stdout.trim();
const cli = path.resolve(__dirname, '../../bin/atris.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tidy-vanishing-')));
console.log(`fixture: ${base}`);

function git(cwd, ...args) {
  const result = spawnSync(realGit, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

for (const withLock of [false, true]) {
  const root = path.join(base, withLock ? 'locked' : 'unlocked');
  const repo = path.join(root, 'repo');
  const toolsDir = path.join(root, 'tools');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(toolsDir);
  git(repo, 'init', '-q', '-b', 'master');
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'master', remote);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'master');
  const copies = path.join(root, 'copies');
  const copy = path.join(copies, 'landed-copy');
  const moved = path.join(root, 'moved-copy');
  git(repo, 'worktree', 'add', '-q', '-b', 'landed-copy', copy);
  const lock = path.join(git(copy, 'rev-parse', '--absolute-git-dir'), 'locked');
  const aged = new Date(Date.now() - 7200000);
  fs.utimesSync(copy, aged, aged);
  const countFile = path.join(root, 'checks');
  fs.writeFileSync(path.join(toolsDir, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const cwd = process.cwd();
if (args.includes('--git-dir') && args.includes('--git-common-dir') && process.cwd() === ${JSON.stringify(copy)}) {
  const file = ${JSON.stringify(countFile)};
  const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
  fs.writeFileSync(file, String(count));
  if (count === 1) {
    if (${withLock}) {
      const held = spawnSync(${JSON.stringify(realGit)}, ['worktree', 'lock', '--reason', 'drive moved during cleanup', ${JSON.stringify(copy)}], { cwd: ${JSON.stringify(repo)}, encoding: 'utf8' });
      if (held.status !== 0) { process.stderr.write(held.stderr); process.exit(1); }
      const aged = new Date(Date.now() - 7200000);
      fs.utimesSync(${JSON.stringify(lock)}, aged, aged);
    }
    fs.renameSync(${JSON.stringify(copy)}, ${JSON.stringify(moved)});
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd, encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  const args = [cli, 'member', 'tidy', '--dir', copies];
  const result = spawnSync(process.execPath, args, {
    cwd: repo, env: { ...env, PATH: toolsDir + path.delimiter + env.PATH }, encoding: 'utf8', timeout: 60000,
  });
  console.log('command: node bin/atris.js member tidy --dir <generated copies>');
  console.log(result.stdout.trim());
  if (result.stderr.trim()) console.log(result.stderr.trim());
  console.log(`cli exit: ${result.status}`);
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '1');
  assert.match(result.stdout, /kept\s+landed-copy\s+could not check git activity: could not locate git metadata/);
  console.log(`missing folder reported: ${result.stdout.includes('folder is missing')}`);
  console.log(`retained lock reported: ${withLock ? result.stdout.includes(lock) : 'no lock created'}`);
  assert.equal(result.stdout.includes('folder is missing'), false);
  if (withLock) {
    assert.ok(fs.existsSync(lock));
    assert.equal(result.stdout.includes(lock), false);
    console.log(`retained lock: ${lock} (${Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000)}s old)`);
  }
  assert.equal(fs.existsSync(copy), false);
  assert.equal(fs.readFileSync(path.join(moved, 'README.md'), 'utf8'), '# fixture\n');
  git(repo, 'rev-parse', '--verify', 'refs/heads/landed-copy');
  assert.equal(fs.existsSync(path.join(repo, '.atris/state/worktree_removals.jsonl')), false);
}
console.log('both timing cases reproduced; moved files and branches retained; no removal recorded');
