'use strict';

// Real git, real bare remote, real process scan. A build copy cleans itself up
// when its job ends: ship removes it once the work is on origin, and the sweep
// saves an abandoned copy's unsaved work to its branch on origin before
// removing it. No step may lose work.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { sweepWorkspace } = require('../lib/worktree-core');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr || run.stdout}`);
  return String(run.stdout || '').trim();
}

// <workspace>/app is the main checkout, <workspace>/.agent-worktrees/app/<name>
// the build copies, <workspace>/remote.git the origin.
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-self-cleanup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  git(root, ['init', '--bare', '-q', remote]);
  git(app, ['init', '-q']);
  git(app, ['config', 'user.name', 'Test User']);
  git(app, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(app, '.gitignore'), '.atris/\nnode_modules/\n.env\n');
  fs.writeFileSync(path.join(app, 'app.js'), 'module.exports = 1;\n');
  git(app, ['add', '.']);
  git(app, ['commit', '-qm', 'initial']);
  git(app, ['branch', '-M', 'master']);
  git(app, ['remote', 'add', 'origin', remote]);
  git(app, ['push', '-qu', 'origin', 'master']);
  git(app, ['remote', 'set-head', 'origin', 'master']);
  return { root, remote, app };
}

function addCopy({ root, app }, name) {
  const copy = path.join(root, '.agent-worktrees', 'app', name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  git(app, ['worktree', 'add', '-q', '-b', `codex/${name}`, copy, 'master']);
  return copy;
}

// Make every activity mark the sweep reads look `days` old.
function age(copy, days) {
  const when = new Date(Date.now() - days * DAY_MS);
  const gitDir = git(copy, ['rev-parse', '--absolute-git-dir']);
  const marks = [path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      marks.push(full);
    }
  };
  walk(copy);
  marks.push(copy);
  for (const mark of marks) {
    try { fs.utimesSync(mark, when, when); } catch {}
  }
}

function makeDirty(copy) {
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(copy, 'notes.md'), 'half-finished idea\n');
  fs.mkdirSync(path.join(copy, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 0;\n');
}

function ship(copy, extra = []) {
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = 3;\n');
  return spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'Ship the change', '--no-pr', '--no-map-refresh', ...extra], {
    cwd: copy, encoding: 'utf8', timeout: 60000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_WORKTREE_KEEP_AFTER_SHIP: '' },
  });
}

function removals(app) {
  const file = path.join(app, '.atris', 'state', 'worktree_removals.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function repoReport(report) {
  return report.repos.find((repo) => repo.name === 'app');
}

test('ship removes a clean copy once its branch is on origin and says how much it freed', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'ship-clean');
  const run = ship(copy);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /cleanup: removed this build copy and freed \d+ (KB|MB|GB); the work is safe on origin\/codex\/ship-clean/);
  assert.match(run.stdout, /done: worktree shipped/);
  assert.equal(fs.existsSync(copy), false, 'the copy folder is gone');
  assert.doesNotMatch(git(ws.app, ['worktree', 'list']), /ship-clean/);
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', 'codex/ship-clean:app.js']), 'module.exports = 3;');
  const record = removals(ws.app).find((row) => row.path === copy);
  assert.ok(record, 'the removal is recorded');
  assert.equal(record.by, 'atris worktree ship');
  assert.equal(record.saved_on, 'origin/codex/ship-clean');
});

test('ship keeps the copy when asked with --keep-copy', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'ship-keep');
  const run = ship(copy, ['--keep-copy']);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /cleanup: kept this build copy \(kept on request \(--keep-copy\)\)/);
  assert.equal(fs.existsSync(path.join(copy, 'app.js')), true);
  assert.match(git(ws.app, ['worktree', 'list']), /ship-keep/);
});

test('ship keeps a copy holding an ignored secret it could not rebuild', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'ship-secret');
  fs.writeFileSync(path.join(copy, '.env'), 'TOKEN=local\n');
  const run = ship(copy);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /cleanup: kept this build copy \(it holds ignored files that cannot be rebuilt: \.env\)/);
  assert.equal(fs.readFileSync(path.join(copy, '.env'), 'utf8'), 'TOKEN=local\n');
});

test('sweep saves a stale dirty copy to its branch on origin, then removes it', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'abandoned');
  makeDirty(copy);
  age(copy, 8);

  const dry = sweepWorkspace({ workspace: ws.root, apply: false });
  const planned = repoReport(dry).rescueCandidates;
  assert.equal(planned.length, 1, JSON.stringify(repoReport(dry).kept));
  assert.equal(planned[0].rescue_branch, 'codex/abandoned');
  assert.equal(planned[0].changed_files, 2);
  assert.equal(fs.existsSync(copy), true, 'a dry run touches nothing');
  assert.equal(spawnSync('git', ['--git-dir', ws.remote, 'rev-parse', '--verify', '-q', 'refs/heads/codex/abandoned']).status, 1, 'a dry run pushes nothing');

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const repo = repoReport(report);
  assert.equal(repo.rescued.length, 1, JSON.stringify(repo.kept));
  assert.equal(fs.existsSync(copy), false, 'the copy folder is gone');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', 'codex/abandoned:app.js']), 'module.exports = 2;');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', 'codex/abandoned:notes.md']), 'half-finished idea');
  const tree = git(ws.app, ['--git-dir', ws.remote, 'ls-tree', '-r', '--name-only', 'codex/abandoned']);
  assert.doesNotMatch(tree, /node_modules/, 'ignored installs are not rescued');
  const rescueCommit = repo.rescued[0].rescue_commit;
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'rev-parse', 'refs/heads/codex/abandoned']), rescueCommit);
  assert.equal(git(ws.app, ['rev-parse', 'refs/heads/codex/abandoned']), rescueCommit, 'the local branch has it too');
  assert.match(git(ws.app, ['log', '-1', '--format=%B', rescueCommit]), /Co-authored-by: Atris/);
  const record = removals(ws.app).find((row) => row.path === copy);
  assert.equal(record.reason, 'rescued_to_branch');
  assert.equal(record.rescue.branch, 'codex/abandoned');
  assert.equal(record.rescue.commit, rescueCommit);
  assert.equal(record.rescue.remote, ws.remote);
});

test('sweep keeps a stale dirty copy when the push fails, and loses nothing', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'push-fails');
  makeDirty(copy);
  git(ws.app, ['remote', 'set-url', '--push', 'origin', path.join(ws.root, 'missing-remote.git')]);
  age(copy, 8);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const repo = repoReport(report);
  assert.equal(repo.rescued.length, 0);
  const kept = repo.kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'rescue_push_failed');
  assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(fs.readFileSync(path.join(copy, 'notes.md'), 'utf8'), 'half-finished idea\n');
  assert.equal(git(copy, ['rev-parse', 'HEAD']), git(ws.app, ['rev-parse', 'master']), 'the copy branch did not move');
});

test('sweep keeps a stale dirty copy while a program runs inside it', async (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'busy');
  makeDirty(copy);
  age(copy, 8);
  const child = spawn('sleep', ['60'], { cwd: copy, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve) => child.once('spawn', resolve));

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const kept = repoReport(report).kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'active_process');
  assert.equal(fs.existsSync(path.join(copy, 'notes.md')), true);
  assert.equal(spawnSync('git', ['--git-dir', ws.remote, 'rev-parse', '--verify', '-q', 'refs/heads/codex/busy']).status, 1, 'nothing was pushed');
});

test('sweep keeps a dirty copy that is still inside the idle limit', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'fresh');
  makeDirty(copy);
  age(copy, 2);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const repo = repoReport(report);
  const kept = repo.kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'dirty');
  assert.equal(kept.idle_days, 2);
  assert.equal(repo.rescued.length, 0);
  assert.equal(fs.existsSync(path.join(copy, 'notes.md')), true);

  const shorter = sweepWorkspace({ workspace: ws.root, apply: false, rescueIdleMs: 1 * DAY_MS });
  assert.equal(repoReport(shorter).rescueCandidates.length, 1, 'the idle limit can be changed');
});

test('sweep keeps a stale dirty copy holding an ignored secret', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'secret');
  makeDirty(copy);
  fs.writeFileSync(path.join(copy, '.env'), 'TOKEN=local\n');
  age(copy, 8);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const kept = repoReport(report).kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'ignored_data');
  assert.deepEqual(kept.files, ['.env']);
  assert.equal(fs.existsSync(path.join(copy, '.env')), true);
});
