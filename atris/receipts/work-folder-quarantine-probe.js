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
const cases = [{ store: 'quarantine', marker: null }];
for (const store of ['objects', 'quarantine']) {
  for (const marker of ['HEAD.lock', 'index.lock', 'packed-refs.lock', 'refs/heads/review.lock']) {
    cases.push({ store, marker });
  }
}
for (const { store, marker } of cases) {
  const locked = marker !== null;
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
    const lock = marker && path.join(store === 'objects' ? gitDir : quarantine, marker);
    if (locked) {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, 'review fixture, not a live writer\n');
    }
    const result = disposeReviewSandbox({ trustedRoot, sandboxRoot, gitDir, quarantine, worktreePath });
    const kept = [sandboxRoot, worktreePath, gitDir, quarantine]
      .every((folder) => fs.existsSync(folder));
    const logged = fs.existsSync(path.join(trustedRoot, '.atris/state/worktree_removals.jsonl'));
    if (locked) {
      if (result.removed || result.reason !== 'git_lock' || !kept || logged) gaps++;
    } else {
      assert.equal(result.removed, true);
      assert.ok([sandboxRoot, worktreePath, gitDir, quarantine].every((folder) => !fs.existsSync(folder)));
      assert.equal(logged, true);
    }
    console.log(`${store} ${marker || 'unlocked'}: removed ${result.removed}, all folders kept ${kept}, removal logged ${logged}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
console.log(`review gaps: ${gaps}; only disposable fixture repositories touched`);
if (process.argv.includes('--require-protection') && gaps) process.exitCode = 1;

}

if (require.main === module) main();
