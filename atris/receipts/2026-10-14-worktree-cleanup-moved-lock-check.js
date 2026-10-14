'use strict';

// Run the real worktree cleanup command and real git. A forwarding git
// executable moves the merged copy during the merged check and leaves an old
// shared branch lock behind, after every check inside the folder has passed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Build fixtures only when run directly, never when a check loads this file.
if (require.main !== module) return;

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), ATRIS_NO_UPDATE_CHECK: '1' };
const located = spawnSync('which', ['git'], { env, encoding: 'utf8' });
assert.equal(located.status, 0, located.stderr);
const realGit = located.stdout.trim();
const cli = path.resolve(__dirname, '../../bin/atris.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cleanup-moved-lock-')));
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
const copy = path.join(base, 'merged-copy');
const moved = path.join(base, 'moved-copy');
git(repo, 'worktree', 'add', '-q', '-b', 'merged-copy', copy);
const aged = new Date(Date.now() - 7200000);
fs.utimesSync(copy, aged, aged);
const removeAttempt = path.join(base, 'remove-attempt');
const lockFile = path.join(repo, '.git/refs/heads/merged-copy.lock');
const lockedAt = new Date(Date.now() - 90000);
fs.writeFileSync(path.join(toolsDir, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const cwd = process.cwd();
if (args[0] === 'worktree' && args[1] === 'remove') fs.writeFileSync(${JSON.stringify(removeAttempt)}, 'attempted');
if (args[0] === 'merge-base' && fs.existsSync(${JSON.stringify(copy)})) {
  fs.renameSync(${JSON.stringify(copy)}, ${JSON.stringify(moved)});
  fs.writeFileSync(${JSON.stringify(lockFile)}, '');
  fs.utimesSync(${JSON.stringify(lockFile)}, new Date(${lockedAt.getTime()}), new Date(${lockedAt.getTime()}));
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd, encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });

const result = spawnSync(process.execPath, [cli, 'worktree', 'cleanup', '--apply', '--base', 'master'], {
  cwd: repo, env: { ...env, PATH: toolsDir + path.delimiter + env.PATH }, encoding: 'utf8', timeout: 60000,
});
console.log('command: node bin/atris.js worktree cleanup --apply --base master');
console.log(result.stdout.trim());
if (result.stderr.trim()) console.log(result.stderr.trim());
console.log(`cli exit: ${result.status}`);
assert.equal(result.status, 0);
assert.ok(fs.existsSync(moved), 'the forwarding git never moved the copy');
assert.match(result.stdout, /^removeds: 0$/m, result.stdout);
const kept = result.stdout.match(/^kept: (.+) reason=missing folder is missing; git lock: (.+) \((\d+)s old\)$/m);
assert.ok(kept, result.stdout);
assert.equal(kept[1], copy);
assert.equal(kept[2], lockFile);
assert.ok(Number(kept[3]) >= 90 && Number(kept[3]) < 600, `lock age ${kept[3]}s`);
assert.ok(fs.existsSync(lockFile), 'the shared lock was removed');
assert.equal(fs.readFileSync(path.join(moved, 'README.md'), 'utf8'), '# fixture\n');
assert.equal(fs.existsSync(removeAttempt), false);
assert.ok(git(repo, 'worktree', 'list', '--porcelain').includes(`worktree ${copy}\n`));
git(moved, 'rev-parse', '--absolute-git-dir');
git(repo, 'rev-parse', '--verify', 'refs/heads/merged-copy');
assert.equal(fs.existsSync(path.join(repo, '.atris/state/worktree_removals.jsonl')), false);
console.log('a copy moved after its final checks passed was kept as missing with the leftover shared lock and its age named; lock, files, branch, and Git record retained; no removal attempted or recorded');
