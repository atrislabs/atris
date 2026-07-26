// A fleet engine finishes work, commits it in an isolated worktree, and the
// commits silently never land — nine were stranded, the oldest five days old,
// and nothing reported them (CLI-1195). These cover the two guarantees: a
// worktree holding commits ahead of origin/master is surfaced (subjects + age),
// and reaping refuses to delete it unless explicitly forced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { collectBoard, reap } = require('../commands/land');

function runGit(args, cwd, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result;
}

function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fleet-stranded-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '-b', 'master'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'init'], repo);
  return { base, repo };
}

// An agent's isolated worktree: a young branch one commit ahead of master, the
// commit never merged. Aged past the fresh-worktree grace so the guard, not the
// grace window, is what decides its fate.
function strandedWorktree(base, repo, { branch = 'codex/engine-work', subject = 'engine did the work' } = {}) {
  runGit(['checkout', '-q', '-b', branch, 'master'], repo);
  fs.writeFileSync(path.join(repo, 'engine.txt'), 'built\n');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', subject], repo);
  runGit(['checkout', '-q', 'master'], repo);
  const wt = path.join(base, 'engine-wt');
  runGit(['worktree', 'add', wt, branch], repo);
  const pastGrace = new Date(Date.now() - 61 * 60 * 1000);
  fs.utimesSync(wt, pastGrace, pastGrace);
  return wt;
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

test('collectBoard surfaces a worktree holding commits ahead of base with subjects', () => {
  const { base, repo } = makeTempRepo();
  try {
    const wt = strandedWorktree(base, repo, { subject: 'engine shipped the diff' });
    const board = collectBoard(repo, {});
    const entry = board.worktrees.find((w) => path.basename(w.path) === 'engine-wt');
    assert.ok(entry, 'the side copy must appear on the board');
    assert.equal(entry.stranded, true);
    assert.equal(entry.unlandedCommits, 1);
    assert.deepEqual(entry.subjects, ['engine shipped the diff']);
    assert.equal(typeof entry.ageDays, 'number');
    assert.equal(board.summary.stranded, 1);
    assert.equal(board.strandedWorktrees.length, 1);
    void wt;
  } finally {
    cleanup(base);
  }
});

test('reap refuses to delete a worktree with unlanded commits and names it', () => {
  const { base, repo } = makeTempRepo();
  try {
    const wt = strandedWorktree(base, repo);
    const receipt = reap(repo, {});
    assert.deepEqual(receipt.removedWorktrees, [], 'unlanded work must not be removed by default');
    assert.ok(!receipt.deletedBranches.includes('codex/engine-work'), 'its branch must survive');
    const kept = (receipt.keptWorktrees || []).join('\n');
    assert.match(kept, /unlanded commits/);
    assert.ok(fs.existsSync(wt), 'the worktree stays on disk');
  } finally {
    cleanup(base);
  }
});

test('reap --force clears a stranded worktree but backs it up first', () => {
  const { base, repo } = makeTempRepo();
  try {
    const wt = strandedWorktree(base, repo);
    const receipt = reap(repo, { force: true });
    assert.ok(receipt.removedWorktrees.some((p) => path.basename(p) === 'engine-wt'), JSON.stringify(receipt));
    assert.ok(receipt.deletedBranches.includes('codex/engine-work'));
    assert.ok(receipt.bundle, 'forced removal must salvage the commits to a bundle');
    const verify = spawnSync('git', ['bundle', 'verify', receipt.bundle], { cwd: repo, encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
    assert.ok(!fs.existsSync(wt));
  } finally {
    cleanup(base);
  }
});

test('a merged (residue) worktree is still reaped without --force', () => {
  // Guard must not over-trigger: a worktree whose commits already landed in
  // master (0 unique ahead) is residue, and the ordinary reap still clears it.
  const { base, repo } = makeTempRepo();
  try {
    runGit(['checkout', '-q', '-b', 'residue', 'master'], repo);
    fs.writeFileSync(path.join(repo, 'r.txt'), 'r\n');
    runGit(['add', '.'], repo);
    runGit(['commit', '-m', 'residue work'], repo);
    runGit(['checkout', '-q', 'master'], repo);
    runGit(['merge', '-q', '--ff-only', 'residue'], repo);
    const wt = path.join(base, 'residue-wt');
    runGit(['worktree', 'add', wt, 'residue'], repo);
    const pastGrace = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(wt, pastGrace, pastGrace);

    const board = collectBoard(repo, {});
    const entry = board.worktrees.find((w) => path.basename(w.path) === 'residue-wt');
    assert.equal(entry.stranded, false);

    const receipt = reap(repo, {});
    assert.ok(receipt.removedWorktrees.some((p) => path.basename(p) === 'residue-wt'), JSON.stringify(receipt));
    assert.ok(!fs.existsSync(wt));
  } finally {
    cleanup(base);
  }
});
