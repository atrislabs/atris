'use strict';

// Usage: node atris/receipts/2026-10-14-shared-lock-probe.js <checkout>
// Holds only a two-hour-old shared branch lock, then asks cleanup and reap
// (preview only) whether they would remove a landed linked copy.
//
// Runs only when called directly, and drops inherited GIT_* settings first:
// the commit load check requires staged scripts inside `git commit`, and a
// fixture `git add` under the caller's index setting overwrites that index.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function main() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) delete process.env[name];
  }
  const root = path.resolve(process.argv[2] || '.');
  const { cleanupWorktrees } = require(path.join(root, 'commands/worktree.js'));
  const { reap } = require(path.join(root, 'commands/land.js'));
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acw-shared-only-')));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'master']);
    git(repo, ['config', 'user.email', 't@e.x']);
    git(repo, ['config', 'user.name', 'T']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'init']);
    git(repo, ['branch', 'engine-run']);
    const wt = path.join(base, 'engine-wt');
    git(repo, ['worktree', 'add', '-q', wt, 'engine-run']);
    const aged = new Date(Date.now() - 7200000);
    fs.utimesSync(wt, aged, aged);
    const lock = path.join(repo, '.git', 'refs', 'heads', 'master.lock');
    fs.writeFileSync(lock, 'w\n');
    fs.utimesSync(lock, aged, aged);
    const cleaned = cleanupWorktrees({ root: repo, base: 'HEAD', apply: false, activeCwds: [] });
    const reaped = reap(repo, { remote: false, force: true, dryRun: true, activeCwds: [] });
    const kept = cleaned.kept.find((item) => item.path === wt);
    console.log(JSON.stringify({
      cleanup: cleaned.candidates.some((item) => item.path === wt) ? 'would remove' : `kept: ${kept ? kept.detail || kept.reason : 'not listed'}`,
      reap: reaped.removedWorktrees.includes(wt) ? 'would remove' : `kept: ${reaped.keptWorktrees.find((line) => line.startsWith(wt)) || 'not listed'}`,
    }, null, 1));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) main();
