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

function withRosterRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fast-roster-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fast-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const previous = process.env.ATRIS_MACHINE_ROSTER_PATH;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  try { return fn(root); } finally {
    if (previous === undefined) delete process.env.ATRIS_MACHINE_ROSTER_PATH;
    else process.env.ATRIS_MACHINE_ROSTER_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function countRanking(fn) {
  const routerBrain = require('../lib/router-brain');
  const original = routerBrain.rankEnginesDetailed;
  let calls = 0;
  routerBrain.rankEnginesDetailed = (...args) => {
    calls += 1;
    return original(...args);
  };
  try {
    const value = fn();
    return { value, calls };
  } finally {
    routerBrain.rankEnginesDetailed = original;
  }
}

test('router history is not read when every job has a valid roster pick', () => withRosterRoom((root) => {
  const registry = require('../lib/engine-registry');
  const { engineCommand } = require('../commands/engine');
  const { readLineupSafe } = require('../lib/team-lineup');
  const now = new Date('2026-09-24T12:00:00.000Z');
  registry.readEngineRegistry(root);
  for (const name of ['codex', 'claude']) registry.setEngineHealth(name, 'ready', root);
  const quiet = console.log;
  console.log = () => {};
  try {
    for (const [job, engine, backup] of [['build', 'codex', 'claude'], ['review', 'claude', 'codex'], ['search', 'claude', '']]) {
      const args = ['assign', job, engine, ...(backup ? ['--backup', backup] : [])];
      assert.equal(engineCommand(args, { root, now }), 0, job);
    }
  } finally {
    console.log = quiet;
  }

  const picked = countRanking(() => registry.resolveEngineForRoleRanked('executor', root, { now }));
  assert.equal(picked.calls, 0);
  assert.equal(picked.value.engine.id, 'codex');
  assert.equal(picked.value.source, 'project');
  // Asking for the full list still ranks, once, with the roster lead first.
  const ranked = countRanking(() => picked.value.ranked.map((engine) => engine.id));
  assert.equal(ranked.calls, 1);
  assert.deepEqual(ranked.value.slice(0, 2), ['codex', 'claude']);
  assert.equal(countRanking(() => picked.value.ranked).calls, 0, 'the ranked list is computed once');

  const lineup = countRanking(() => readLineupSafe(root, now));
  assert.equal(lineup.value.ok, true, lineup.value.error);
  assert.ok(lineup.value.jobs.length >= 3);
  assert.equal(lineup.calls, 0);
}));

test('router ranks when a job has no roster pick', () => withRosterRoom((root) => {
  const registry = require('../lib/engine-registry');
  const now = new Date('2026-09-24T12:00:00.000Z');
  registry.readEngineRegistry(root);
  registry.setEngineHealth('codex', 'ready', root);
  const picked = countRanking(() => registry.resolveEngineForRoleRanked('executor', root, { now }));
  assert.equal(picked.calls, 1);
  assert.equal(picked.value.source, 'router');
}));

test('boot reads the task list once for the todo buckets and the status glance', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fast-tasks-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  // A generated compact board, the shape boot reads, merges with the DB.
  fs.writeFileSync(path.join(repo, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n## In Progress\n\n- **[T-1]** in flight row · agent · verify: npm test\n\n## Completed\n');
  const previous = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = path.join(base, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  t.after(() => {
    taskDb.close();
    if (previous === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot(repo);
  taskDb.addTask(db, { title: 'first backlog item for the glance', workspaceRoot });

  const originalPrepare = db.prepare;
  let listReads = 0;
  db.prepare = function prepare(sql) {
    if (/FROM tasks\s+WHERE[\s\S]*ORDER BY/.test(sql)) listReads += 1;
    return originalPrepare.call(this, sql);
  };
  try {
    const todo = require('../lib/todo');
    const { getTaskGlance } = require('../lib/state-detection');
    const buckets = todo.parseTodo(path.join(repo, 'atris', 'TODO.md'));
    const glance = getTaskGlance(path.join(repo, 'atris'));
    assert.equal(listReads, 1);
    assert.equal(glance.backlog, 1);
    assert.ok(buckets.backlog.some((row) => /first backlog item/.test(row.title)));

    // A write invalidates the shared read.
    taskDb.addTask(db, { title: 'second backlog item after a write', workspaceRoot });
    assert.equal(getTaskGlance(path.join(repo, 'atris')).backlog, 2);
    assert.equal(listReads, 2);
  } finally {
    db.prepare = originalPrepare;
  }
});
