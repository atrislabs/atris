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
const { reapPushedCopy, sweepWorkspace } = require('../lib/worktree-core');

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
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const remote = path.join(root, 'remote.git');
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  git(root, ['init', '--bare', '-q', remote]);
  git(app, ['init', '-q']);
  git(app, ['config', 'user.name', 'Test User']);
  git(app, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(app, '.gitignore'), '.atris/\nnode_modules/\n.env\nbuild/\nuploads/\n');
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
  // atris's own start sidecar is plumbing, not work.
  fs.mkdirSync(path.join(copy, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(copy, '.atris', 'agent-worktree.json'), '{}\n');
}

const SHIP_ARGS = ['worktree', 'ship', '--message', 'Ship the change', '--no-pr', '--no-map-refresh'];
const SHIP_ENV = () => ({ ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_WORKTREE_KEEP_AFTER_SHIP: '' });

// The test process, which sits outside the copy, launches ship directly.
function ship(copy, extra = []) {
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = 3;\n');
  return spawnSync(process.execPath, [CLI, ...SHIP_ARGS, ...extra], { cwd: copy, encoding: 'utf8', timeout: 60000, env: SHIP_ENV() });
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
  assert.match(run.stdout, /cleanup: kept this build copy \(it holds ignored files atris cannot rebuild: \.env\)/);
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
  assert.match(planned[0].rescue_branch, /^atris-rescue\/abandoned-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.equal(planned[0].changed_files, 2);
  assert.equal(fs.existsSync(copy), true, 'a dry run touches nothing');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/atris-rescue']), '', 'a dry run pushes nothing');

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const repo = repoReport(report);
  assert.equal(repo.rescued.length, 1, JSON.stringify(repo.kept));
  assert.equal(fs.existsSync(copy), false, 'the copy folder is gone');
  const rescueBranch = repo.rescued[0].rescue_branch;
  assert.match(rescueBranch, /^atris-rescue\/abandoned-/);
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', `${rescueBranch}:app.js`]), 'module.exports = 2;');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', `${rescueBranch}:notes.md`]), 'half-finished idea');
  const tree = git(ws.app, ['--git-dir', ws.remote, 'ls-tree', '-r', '--name-only', rescueBranch]);
  assert.doesNotMatch(tree, /node_modules/, 'ignored installs are not rescued');
  const rescueCommit = repo.rescued[0].rescue_commit;
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'rev-parse', `refs/heads/${rescueBranch}`]), rescueCommit);
  assert.equal(git(ws.app, ['rev-parse', `refs/heads/${rescueBranch}`]), rescueCommit, 'the local rescue branch has it too');
  assert.equal(git(ws.app, ['rev-parse', 'refs/heads/codex/abandoned']), git(ws.app, ['rev-parse', 'master']), 'the copy branch never moves');
  assert.match(git(ws.app, ['log', '-1', '--format=%B', rescueCommit]), /Co-authored-by: Atris/);
  const record = removals(ws.app).find((row) => row.path === copy);
  assert.equal(record.reason, 'rescued_to_branch');
  assert.equal(record.rescue.branch, rescueBranch);
  assert.equal(record.rescue.copy_branch, 'codex/abandoned');
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
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/atris-rescue']), '', 'nothing was pushed');
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

test('ship leaves the copy for the delayed remover while the shell that ran it still stands inside', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'ship-shell');
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = 3;\n');
  // The trailing echo keeps the shell alive as ship's parent, working in the copy.
  const quoted = [process.execPath, CLI, ...SHIP_ARGS].map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
  const run = spawnSync('/bin/sh', ['-c', `cd '${copy}' && ${quoted}; echo shell-still-here`], { encoding: 'utf8', timeout: 60000, env: SHIP_ENV() });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /cleanup: not yet \(a program is still working in it\)/);
  assert.match(run.stdout, /shell-still-here/);
  assert.equal(fs.existsSync(path.join(copy, 'app.js')), true, 'the copy stays while its shell is in it');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', 'codex/ship-shell:app.js']), 'module.exports = 3;');
});

test('the delayed remover waits for a pushed copy to be free, then removes it', async (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'pushed-wait');
  git(copy, ['push', '-q', 'origin', 'codex/pushed-wait']);
  const holder = spawn('sleep', ['2'], { cwd: copy, stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve) => holder.once('spawn', resolve));
  const reasons = [];
  const result = reapPushedCopy({
    primary: ws.app,
    target: copy,
    branch: 'codex/pushed-wait',
    settleMs: 0,
    pollMs: 3000,
    remove: (options) => {
      const outcome = require('../lib/worktree-core').finishShippedCopy({ ...options, log: () => {}, schedule: () => ({}) });
      reasons.push(outcome.removed ? 'removed' : outcome.reason);
      return outcome;
    },
  });
  assert.deepEqual(reasons, ['a program is still working in it', 'removed']);
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(copy), false);
});

test('sweep keeps a stale copy holding ignored user files under build/ or uploads/', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'user-files');
  makeDirty(copy);
  fs.mkdirSync(path.join(copy, 'build'));
  fs.writeFileSync(path.join(copy, 'build', 'local.db'), 'rows');
  fs.mkdirSync(path.join(copy, 'uploads'));
  fs.writeFileSync(path.join(copy, 'uploads', 'photo.png'), 'png');
  age(copy, 8);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const kept = repoReport(report).kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'ignored_data');
  assert.deepEqual(kept.files.sort(), ['build/local.db', 'uploads/photo.png']);
  assert.equal(fs.readFileSync(path.join(copy, 'build', 'local.db'), 'utf8'), 'rows');
  assert.equal(fs.readFileSync(path.join(copy, 'uploads', 'photo.png'), 'utf8'), 'png');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/atris-rescue']), '', 'nothing was pushed');
});

test('sweep keeps both a staged version and a different version on disk', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'staged');
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = "staged";\n');
  git(copy, ['add', 'app.js']);
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = "on disk";\n');
  age(copy, 8);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const repo = repoReport(report);
  assert.equal(repo.rescued.length, 1, JSON.stringify(repo.kept));
  assert.equal(fs.existsSync(copy), false);
  const tip = git(ws.app, ['--git-dir', ws.remote, 'rev-parse', `refs/heads/${repo.rescued[0].rescue_branch}`]);
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', `${tip}:app.js`]), 'module.exports = "on disk";');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', `${tip}^:app.js`]), 'module.exports = "staged";');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'rev-parse', `${tip}~2`]), git(ws.app, ['rev-parse', 'master']));
});

// Round two: the sweep removes a dirty copy only when it can prove every byte
// is saved; anything unusual keeps the copy for a person.
function noRescuePushed(ws) {
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/atris-rescue']), '', 'nothing was pushed');
}

test('a cache folder counts as throwaway only at its known place, not by name anywhere', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'nested-cache');
  makeDirty(copy);
  fs.mkdirSync(path.join(copy, 'uploads', '.cache'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'uploads', '.cache', 'local.db'), 'rows');
  fs.mkdirSync(path.join(copy, 'uploads', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'uploads', 'node_modules', 'photo.png'), 'png');
  age(copy, 8);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const kept = repoReport(report).kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'ignored_data');
  assert.deepEqual(kept.files.sort(), ['uploads/.cache/local.db', 'uploads/node_modules/photo.png']);
  assert.equal(fs.readFileSync(path.join(copy, 'uploads', '.cache', 'local.db'), 'utf8'), 'rows');
  noRescuePushed(ws);
});

test('sweep keeps a copy holding an untracked nested git repository', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'nested-repo');
  makeDirty(copy);
  const inner = path.join(copy, 'vendor', 'lib');
  fs.mkdirSync(inner, { recursive: true });
  git(inner, ['init', '-q']);
  fs.writeFileSync(path.join(inner, 'lib.js'), 'local only\n');
  git(inner, ['add', 'lib.js']);
  git(inner, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'unpublished']);
  age(copy, 8);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const kept = repoReport(report).kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'unprovable');
  assert.match(kept.why, /nested git repository vendor\/lib/);
  assert.equal(fs.readFileSync(path.join(inner, 'lib.js'), 'utf8'), 'local only\n');
  noRescuePushed(ws);
});

test('sweep keeps a copy whose index hides edits with assume-unchanged or skip-worktree', (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const ws = workspace(t);
    const copy = addCopy(ws, `hidden${flag.replace(/-/g, '_')}`);
    git(copy, ['update-index', flag, 'app.js']);
    fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = "hidden edit";\n');
    fs.writeFileSync(path.join(copy, 'notes.md'), 'visible edit\n');
    age(copy, 8);

    const report = sweepWorkspace({ workspace: ws.root, apply: true });
    const kept = repoReport(report).kept.find((item) => item.path === copy);
    assert.equal(kept.reason, 'unprovable', flag);
    assert.match(kept.why, /index entries hide their edits.*app\.js/);
    assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), 'module.exports = "hidden edit";\n');
    noRescuePushed(ws);
  }
});

test('a rescue lands on a new branch and never moves the copy branch, here or on origin', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'moved');
  // Someone else pushed the copy's branch ahead, and the local branch has its own commit.
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = "local commit";\n');
  git(copy, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qam', 'local only']);
  const localTip = git(copy, ['rev-parse', 'HEAD']);
  const other = path.join(ws.root, 'other');
  git(ws.root, ['clone', '-q', ws.remote, other]);
  git(other, ['switch', '-q', '-c', 'codex/moved']);
  fs.writeFileSync(path.join(other, 'other.txt'), 'theirs\n');
  git(other, ['add', 'other.txt']);
  git(other, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'theirs']);
  git(other, ['push', '-q', 'origin', 'codex/moved']);
  const originTip = git(ws.app, ['--git-dir', ws.remote, 'rev-parse', 'refs/heads/codex/moved']);
  fs.writeFileSync(path.join(copy, 'notes.md'), 'half-finished idea\n');
  age(copy, 8);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const repo = repoReport(report);
  assert.equal(repo.rescued.length, 1, JSON.stringify(repo.kept));
  const rescueBranch = repo.rescued[0].rescue_branch;
  assert.match(rescueBranch, /^atris-rescue\/moved-/);
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'rev-parse', 'refs/heads/codex/moved']), originTip, 'origin copy branch untouched');
  assert.equal(git(ws.app, ['rev-parse', 'refs/heads/codex/moved']), localTip, 'local copy branch untouched');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'rev-parse', `${rescueBranch}^`]), localTip, 'the rescue sits on top of the local commit');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'show', `${rescueBranch}:notes.md`]), 'half-finished idea');
});

test('a copy whose index lists more than a megabyte of paths is still read, not kept as unreadable', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'big-index');
  const dir = path.join(copy, 'many');
  fs.mkdirSync(dir);
  for (let i = 0; i < 5000; i += 1) fs.writeFileSync(path.join(dir, `${'f'.repeat(230)}-${i}.txt`), `${i}\n`);
  git(copy, ['add', 'many']);
  git(copy, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'many files']);
  fs.writeFileSync(path.join(copy, 'notes.md'), 'half-finished idea\n');
  age(copy, 8);

  // Five thousand fresh files draw the system file indexer in; the process
  // check is covered above, so this one reports no running programs.
  const dry = sweepWorkspace({ workspace: ws.root, apply: false, activeCwds: [] });
  const repo = repoReport(dry);
  assert.equal(repo.rescueCandidates.length, 1, JSON.stringify(repo.kept));
});
