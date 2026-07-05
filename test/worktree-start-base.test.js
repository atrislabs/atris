const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { defaultStartBase } = require('../commands/worktree');

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result;
}

function commitFile(repo, name, contents, message) {
  fs.writeFileSync(path.join(repo, name), contents);
  runGit(['add', name], repo);
  runGit(['commit', '-m', message], repo);
}

// A launcher branch whose upstream is behind the mainline must never become
// the cut point for a new agent worktree (2026-07-05: a stale origin/task
// branch sent two dispatched flights into rebase conflicts).
test('defaultStartBase prefers the mainline over a stale launcher upstream, keeps an upstream that is ahead', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-start-base-test-'));
  try {
    const origin = path.join(base, 'origin.git');
    const work = path.join(base, 'work');
    fs.mkdirSync(origin, { recursive: true });
    runGit(['init', '--bare', '--initial-branch=master', origin], base);
    runGit(['clone', origin, work], base);
    runGit(['config', 'user.email', 'test@example.com'], work);
    runGit(['config', 'user.name', 'Test User'], work);

    commitFile(work, 'base.txt', 'c1\n', 'c1');
    runGit(['push', '-u', 'origin', 'master'], work);

    // Launcher branch, pushed with upstream, then master moves past it.
    runGit(['checkout', '-b', 'task/feature'], work);
    runGit(['push', '-u', 'origin', 'task/feature'], work);
    runGit(['checkout', 'master'], work);
    commitFile(work, 'main.txt', 'c2\n', 'c2: master advances');
    runGit(['push', 'origin', 'master'], work);
    runGit(['checkout', 'task/feature'], work);

    // Upstream (origin/task/feature) is now strictly behind origin/master.
    assert.equal(defaultStartBase(work), 'origin/master');

    // Give the launcher branch new work of its own: upstream wins again.
    commitFile(work, 'feature.txt', 'c3\n', 'c3: feature advances');
    runGit(['push', 'origin', 'task/feature'], work);
    assert.equal(defaultStartBase(work), 'origin/task/feature');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
