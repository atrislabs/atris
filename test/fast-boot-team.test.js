const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gitSpawn = require('../lib/git-spawn');
const land = require('../commands/land');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function makeRepo({ atris = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fast-boot-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  if (atris) fs.mkdirSync(path.join(repo, '.atris', 'state'), { recursive: true });
  return { base, repo };
}

function commitOnBranch(repo, branch, file) {
  git(['checkout', '-q', '-b', branch, 'master'], repo);
  fs.writeFileSync(path.join(repo, file), `${branch}\n`);
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', `work on ${branch}`], repo);
  git(['checkout', '-q', 'master'], repo);
}

// Count git spawns by subcommand while fn runs.
function countGit(fn) {
  const counts = {};
  const original = gitSpawn.runGit;
  gitSpawn.runGit = (args, opts) => {
    counts[args[0]] = (counts[args[0]] || 0) + 1;
    return original(args, opts);
  };
  try {
    const value = fn();
    return { value, counts };
  } finally {
    gitSpawn.runGit = original;
  }
}

function readCache(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'cherry-cache.json'), 'utf8'));
}

test('cherry cache: miss computes, hit skips git cherry, results match', (t) => {
  const { base, repo } = makeRepo();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  commitOnBranch(repo, 'feature-a', 'a.txt');
  commitOnBranch(repo, 'feature-b', 'b.txt');

  const first = countGit(() => land.collectBoard(repo, { light: true }));
  assert.equal(first.counts.cherry, 2);
  assert.equal(Object.keys(readCache(repo).entries).length, 2);

  const second = countGit(() => land.collectBoard(repo, { light: true }));
  assert.equal(second.counts.cherry || 0, 0);
  assert.deepEqual(
    second.value.branches.map((b) => [b.name, b.state, b.uniqueChanges, b.landedElsewhere]),
    first.value.branches.map((b) => [b.name, b.state, b.uniqueChanges, b.landedElsewhere]),
  );
});

test('cherry cache: a new branch sha invalidates only that entry', (t) => {
  const { base, repo } = makeRepo();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  commitOnBranch(repo, 'feature-a', 'a.txt');
  commitOnBranch(repo, 'feature-b', 'b.txt');
  land.collectBoard(repo, { light: true });

  git(['checkout', '-q', 'feature-a'], repo);
  fs.writeFileSync(path.join(repo, 'a2.txt'), 'more\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'more on a'], repo);
  git(['checkout', '-q', 'master'], repo);

  const run = countGit(() => land.collectBoard(repo, { light: true }));
  assert.equal(run.counts.cherry, 1);
  const a = run.value.branches.find((b) => b.name === 'feature-a');
  assert.equal(a.uniqueChanges, 2);
  // The stale entry for the old feature-a sha is gone.
  assert.equal(Object.keys(readCache(repo).entries).length, 2);
});

test('cherry cache: a moved base sha recomputes everything', (t) => {
  const { base, repo } = makeRepo();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  commitOnBranch(repo, 'feature-a', 'a.txt');
  land.collectBoard(repo, { light: true });
  fs.writeFileSync(path.join(repo, 'm.txt'), 'master moves\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'master moves'], repo);
  const run = countGit(() => land.collectBoard(repo, { light: true }));
  assert.equal(run.counts.cherry, 1);
});

test('cherry cache: corrupt file recomputes and is rewritten', (t) => {
  const { base, repo } = makeRepo();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  commitOnBranch(repo, 'feature-a', 'a.txt');
  fs.writeFileSync(path.join(repo, '.atris', 'state', 'cherry-cache.json'), '{not json');
  const run = countGit(() => land.collectBoard(repo, { light: true }));
  assert.equal(run.counts.cherry, 1);
  assert.equal(readCache(repo).version, 1);
  assert.equal(Object.keys(readCache(repo).entries).length, 1);
});

test('cherry cache: deleted branch entry is dropped', (t) => {
  const { base, repo } = makeRepo();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  commitOnBranch(repo, 'feature-a', 'a.txt');
  commitOnBranch(repo, 'feature-b', 'b.txt');
  land.collectBoard(repo, { light: true });
  assert.equal(Object.keys(readCache(repo).entries).length, 2);
  git(['branch', '-q', '-D', 'feature-b'], repo);
  const run = countGit(() => land.collectBoard(repo, { light: true }));
  assert.equal(run.counts.cherry || 0, 0);
  assert.equal(Object.keys(readCache(repo).entries).length, 1);
});

test('cherry cache: repos without .atris get no cache file', (t) => {
  const { base, repo } = makeRepo({ atris: false });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  commitOnBranch(repo, 'feature-a', 'a.txt');
  land.collectBoard(repo, { light: true });
  assert.equal(fs.existsSync(path.join(repo, '.atris')), false);
});

test('landing board is computed once per process for stream snapshot plus events', (t) => {
  const { base, repo } = makeRepo();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  commitOnBranch(repo, 'feature-a', 'a.txt');
  const stream = require('../commands/stream');
  land.clearBoardMemo();
  const run = countGit(() => {
    const snapshot = stream.collectSnapshot({ root: repo });
    const events = stream.collectStreamEvents({ root: repo });
    return { snapshot, events };
  });
  assert.equal(run.counts['for-each-ref'], 1, 'one branch listing means one board');
  assert.equal(run.value.events.filter((e) => e.event === 'landing_state').length, 1);
  // Boot's light summary is answered by the same full board.
  const again = countGit(() => land.landSummary(repo));
  assert.equal(again.counts['for-each-ref'] || 0, 0);
  assert.equal(again.value.branches, 1);
  land.clearBoardMemo();
  const fresh = countGit(() => land.sharedBoard(repo));
  assert.equal(fresh.counts['for-each-ref'], 1, 'clearing the memo recomputes');
});

test('team roster skips the landing board; team presence still reads it', (t) => {
  const { base, repo } = makeRepo();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  commitOnBranch(repo, 'feature-a', 'a.txt');
  const team = require('../commands/team');
  land.clearBoardMemo();
  const deps = { root: repo, members: [{ name: 'scout', role: 'scout' }], missions: [], tasks: [] };
  const roster = countGit(() => team.collectTeamRoster(deps));
  assert.equal(roster.counts['for-each-ref'] || 0, 0);
  assert.equal(roster.value.length, 1);

  land.clearBoardMemo();
  const out = [];
  const presence = countGit(() => team.teamCommand(['presence'], { ...deps, write: (text) => out.push(text) }));
  assert.equal(presence.value, 0);
  assert.equal(presence.counts['for-each-ref'], 1);
  assert.match(out.join(''), /landing wait: 0/);
});
