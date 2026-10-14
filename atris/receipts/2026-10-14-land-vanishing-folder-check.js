'use strict';

// Run the real CLI and real git. A forwarding git executable moves only the
// generated copy or adds locks at the second check, after cleanup has planned it.
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
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-vanishing-')));
console.log(`fixture: ${base}`);

function git(cwd, ...args) {
  const result = spawnSync(realGit, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

for (const mode of ['unlocked', 'locked', 'ordinary', 'ordinary-present', 'locked-present', 'after']) {
  const after = mode === 'after';
  const withLock = mode.startsWith('locked');
  const staysPresent = mode.endsWith('-present');
  const ordinary = mode.startsWith('ordinary');
  const root = path.join(base, mode);
  const repo = path.join(root, 'repo');
  const toolsDir = path.join(root, 'tools');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(toolsDir);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const copy = path.join(root, 'landed-copy');
  const moved = path.join(root, 'moved-copy');
  git(repo, 'worktree', 'add', '-q', '-b', 'landed-copy', copy);
  const privateDir = git(copy, 'rev-parse', '--absolute-git-dir');
  const lock = path.join(privateDir, 'locked');
  const ordinaryLocks = [path.join(privateDir, 'index.lock'), path.join(repo, '.git', 'packed-refs.lock')];
  const expectedLocks = withLock ? [lock] : ordinary ? ordinaryLocks : [];
  const aged = new Date(Date.now() - 7200000);
  fs.utimesSync(copy, aged, aged);
  const countFile = path.join(root, 'checks');
  const removeAttempt = path.join(root, 'remove-attempt');
  fs.writeFileSync(path.join(toolsDir, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const cwd = process.cwd();
if (args[0] === 'worktree' && args[1] === 'remove') fs.writeFileSync(${JSON.stringify(removeAttempt)}, 'attempted');
if (args.includes('--git-dir') && args.includes('--git-common-dir') && process.cwd() === ${JSON.stringify(copy)}) {
  const file = ${JSON.stringify(countFile)};
  const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
  fs.writeFileSync(file, String(count));
  if (count === 2) {
    if (${withLock}) {
      const held = spawnSync(${JSON.stringify(realGit)}, ['worktree', 'lock', '--reason', 'drive moved during cleanup', ${JSON.stringify(copy)}], { cwd: ${JSON.stringify(repo)}, encoding: 'utf8' });
      if (held.status !== 0) { process.stderr.write(held.stderr); process.exit(1); }
      const aged = new Date(Date.now() - 7200000);
      fs.utimesSync(${JSON.stringify(lock)}, aged, aged);
    }
    for (const [index, lock] of ${JSON.stringify(ordinary ? ordinaryLocks : [])}.entries()) {
      fs.writeFileSync(lock, 'fixture lock\\n');
      const aged = new Date(Date.now() - (7200000 + index * 3600000));
      fs.utimesSync(lock, aged, aged);
    }
    if (!${staysPresent || after}) fs.renameSync(${JSON.stringify(copy)}, ${JSON.stringify(moved)});
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd, encoding: 'utf8' });
if (${after} && args.includes('--git-common-dir') && cwd === ${JSON.stringify(copy)} && fs.readFileSync(${JSON.stringify(countFile)}, 'utf8') === '2') {
  fs.renameSync(${JSON.stringify(copy)}, ${JSON.stringify(moved)});
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  const args = [cli, 'land', '--reap', '--force', '--no-remote'];
  const result = spawnSync(process.execPath, args, {
    cwd: repo, env: { ...env, PATH: toolsDir + path.delimiter + env.PATH }, encoding: 'utf8', timeout: 60000,
  });
  console.log('command: node bin/atris.js land --reap --force --no-remote');
  console.log(result.stdout.trim());
  if (result.stderr.trim()) console.log(result.stderr.trim());
  console.log(`cli exit: ${result.status}`);
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '2');
  assert.ok(result.stdout.includes(staysPresent ? `${copy} (git locks:` : `${copy} (folder is missing${expectedLocks.length ? '; git lock: ' : ')'}`), result.stdout);
  assert.equal(result.stdout.includes('folder is missing'), !staysPresent);
  for (const [index, lock] of expectedLocks.entries()) {
    assert.equal(fs.readFileSync(lock, 'utf8'), withLock ? 'drive moved during cleanup\n' : 'fixture lock\n');
    const age = result.stdout.split(`${lock} (`)[1]?.match(/^(\d+)s old\)/);
    const expectedAge = 7200 + index * 3600;
    assert.ok(age && Number(age[1]) >= expectedAge - 10 && Number(age[1]) <= expectedAge, result.stdout);
  }
  assert.equal(fs.existsSync(copy), staysPresent);
  assert.equal(fs.readFileSync(path.join(staysPresent ? copy : moved, 'README.md'), 'utf8'), '# fixture\n');
  assert.equal(fs.existsSync(removeAttempt), false);
  git(repo, 'rev-parse', '--verify', 'refs/heads/landed-copy');
  assert.equal(fs.existsSync(path.join(repo, '.atris/state/worktree_removals.jsonl')), false);
  if (after) assert.ok(git(repo, 'worktree', 'list', '--porcelain').includes(`worktree ${copy}\n`));
}
console.log('all six timing cases passed, including a folder moved after a passing final check; files, locks, branches, and Git records retained; no removal attempted or recorded');
