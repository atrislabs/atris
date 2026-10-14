'use strict';

// Run the real land cleanup and real git. A forwarding git executable moves a
// dirty copy while the backup bundle is built and leaves an old shared branch
// lock behind, after the copy was planned for removal and before its backup.
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
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-moved-dirty-')));
console.log(`fixture: ${base}`);

function git(cwd, ...args) {
  const result = spawnSync(realGit, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const repo = path.join(base, 'repo');
const toolsDir = path.join(base, 'tools');
fs.mkdirSync(repo);
fs.mkdirSync(toolsDir);
git(repo, 'init', '-q', '-b', 'master');
git(repo, 'config', 'user.name', 'Test');
git(repo, 'config', 'user.email', 'test@example.com');
git(repo, 'config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'init');
const copy = path.join(base, 'dirty-copy');
const moved = path.join(base, 'moved-copy');
git(repo, 'worktree', 'add', '-q', '-b', 'dirty-copy', copy);
fs.writeFileSync(path.join(copy, 'work.txt'), 'committed work\n');
git(copy, 'add', '.');
git(copy, 'commit', '-qm', 'work');
fs.writeFileSync(path.join(copy, 'README.md'), '# fixture\nunsaved edit\n');
const aged = new Date(Date.now() - 7200000);
fs.utimesSync(copy, aged, aged);
const lockFile = path.join(repo, '.git/refs/heads/dirty-copy.lock');
const lockedAt = Date.now() - 90000;
const removeAttempt = path.join(base, 'remove-attempt');
fs.writeFileSync(path.join(toolsDir, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const cwd = process.cwd();
if (args[0] === 'worktree' && args[1] === 'remove') fs.writeFileSync(${JSON.stringify(removeAttempt)}, 'attempted');
if (args[0] === 'bundle' && args[1] === 'create' && fs.existsSync(${JSON.stringify(copy)})) {
  fs.renameSync(${JSON.stringify(copy)}, ${JSON.stringify(moved)});
  fs.writeFileSync(${JSON.stringify(lockFile)}, '');
  fs.utimesSync(${JSON.stringify(lockFile)}, new Date(${lockedAt}), new Date(${lockedAt}));
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd, encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });

const result = spawnSync(process.execPath, [cli, 'land', '--reap', '--force', '--no-remote'], {
  cwd: repo, env: { ...env, PATH: toolsDir + path.delimiter + env.PATH }, encoding: 'utf8', timeout: 60000,
});
console.log('command: node bin/atris.js land --reap --force --no-remote');
console.log(result.stdout.trim());
if (result.stderr.trim()) console.log(result.stderr.trim());
console.log(`cli exit: ${result.status}`);
assert.equal(result.status, 0);
assert.ok(fs.existsSync(moved), 'the forwarding git never moved the copy');
assert.ok(result.stdout.includes(`${copy} (folder is missing; git lock: ${lockFile} (`), result.stdout);
const age = result.stdout.split(`${lockFile} (`)[1]?.match(/^(\d+)s old\)/);
assert.ok(age && Number(age[1]) >= 90 && Number(age[1]) < 600, result.stdout);
assert.equal(result.stdout.includes('salvage incomplete'), false, result.stdout);
assert.ok(fs.existsSync(lockFile), 'the shared lock was removed');
assert.equal(fs.readFileSync(path.join(moved, 'README.md'), 'utf8'), '# fixture\nunsaved edit\n');
assert.equal(fs.existsSync(removeAttempt), false);
assert.ok(git(repo, 'worktree', 'list', '--porcelain').includes(`worktree ${copy}\n`));
git(repo, 'rev-parse', '--verify', 'refs/heads/dirty-copy');
assert.equal(fs.existsSync(path.join(repo, '.atris/state/worktree_removals.jsonl')), false);
console.log('a dirty copy moved while its backup was built was kept as missing with the leftover shared lock and its age named; edits, lock, branch, and Git record retained; no removal attempted or recorded');
