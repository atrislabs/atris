'use strict';

// Advisory runtime probe. Only newly created temporary repositories are removed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { disposeReviewSandbox } = require('../../lib/fleet');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function main() {
let gaps = 0;
for (const locked of [false, true]) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-quarantine-review-')));
  try {
    const trustedRoot = path.join(base, 'trusted');
    const sandboxRoot = path.join(base, 'sandbox');
    const gitDir = path.join(sandboxRoot, 'objects.git');
    const quarantine = path.join(sandboxRoot, 'quarantine.git');
    const worktreePath = path.join(sandboxRoot, 'worktree');
    fs.mkdirSync(trustedRoot);
    fs.mkdirSync(sandboxRoot);
    git(trustedRoot, ['init', '-q', '-b', 'master']);
    git(trustedRoot, ['-c', 'user.name=Review', '-c', 'user.email=review@example.com',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture', '--allow-empty']);
    git(base, ['clone', '-q', '--bare', trustedRoot, gitDir]);
    git(base, ['init', '-q', '--bare', quarantine]);
    git(base, ['--git-dir', gitDir, 'worktree', 'add', '-q', '--detach', worktreePath, 'HEAD']);
    const lock = path.join(quarantine, 'HEAD.lock');
    if (locked) fs.writeFileSync(lock, 'review fixture, not a live writer\n');
    const result = disposeReviewSandbox({ trustedRoot, sandboxRoot, gitDir, quarantine, worktreePath });
    const kept = fs.existsSync(quarantine);
    const logged = fs.existsSync(path.join(trustedRoot, '.atris/state/worktree_removals.jsonl'));
    if (locked) {
      if (result.removed || !kept || logged) gaps++;
    } else {
      assert.equal(result.removed, true);
      assert.equal(kept, false);
      assert.equal(logged, true);
    }
    console.log(`${locked ? 'locked' : 'unlocked'} quarantine: removed ${result.removed}, store kept ${kept}, removal logged ${logged}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
console.log(`review gaps: ${gaps}; only disposable fixture repositories touched`);
if (process.argv.includes('--require-protection') && gaps) process.exitCode = 1;

}

if (require.main === module) main();
