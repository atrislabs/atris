'use strict';

// Real git in temp folders: a fake main copy at <ws>/app, build copies under
// <ws>/.agent-worktrees/app/, and the put-away store in its own temp folder.
// Nothing here touches the real workspace, home folder, or timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const putaway = require('../lib/worktree-putaway');
const { createAgentWorktree, defaultSweepWorkspace, sweepSchedulePlan } = require('../lib/worktree-core');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const HOUR_MS = 60 * 60 * 1000;

function git(cwd, args, options = {}) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr || run.stdout}`);
  return String(run.stdout || '').trim();
}

function setup(t, { files = {} } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-put-away-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-put-away-home-')));
  t.after(() => {
    for (const dir of [ws, home]) {
      try { spawnSync('chmod', ['-R', 'u+rwx', dir]); } catch {}
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  const app = path.join(ws, 'app');
  fs.mkdirSync(app);
  git(app, ['init', '-q']);
  git(app, ['config', 'user.name', 'Test User']);
  git(app, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(app, '.gitignore'), 'node_modules/\n.env.local\n.next/\n');
  fs.writeFileSync(path.join(app, 'app.js'), 'module.exports = 1;\n');
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(app, file), body);
  git(app, ['add', '.']);
  git(app, ['commit', '-qm', 'initial']);
  git(app, ['branch', '-M', 'master']);
  return { ws, home, app };
}

function addCopy({ ws, app }, name, { commit = false } = {}) {
  const copy = path.join(ws, '.agent-worktrees', 'app', name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  git(app, ['worktree', 'add', '-q', '-b', `codex/${name}`, copy, 'master']);
  if (commit) {
    fs.writeFileSync(path.join(copy, `${name}.txt`), `work from ${name}\n`);
    git(copy, ['add', '.']);
    git(copy, ['commit', '-qm', `work ${name}`]);
  }
  return copy;
}

// Make everything the idle check reads look `hours` old.
function age(copy, hours) {
  const when = new Date(Date.now() - hours * HOUR_MS);
  const gitDir = git(copy, ['rev-parse', '--absolute-git-dir']);
  const marks = [copy, path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      marks.push(full);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
    }
  };
  walk(copy);
  for (const mark of marks.reverse()) {
    try { fs.lutimesSync(mark, when, when); } catch {}
  }
}

function sweepApp(ctx, options = {}) {
  const report = putaway.sweep({ workspace: ctx.ws, home: ctx.home, cwds: [], current: ctx.ws, apply: true, ...options });
  return report.repos.find((repo) => repo.name === 'app');
}

function putAwayRefs(app) {
  return git(app, ['for-each-ref', '--format=%(refname)', 'refs/atris/put-away/']).split('\n').filter(Boolean);
}

test('a clean copy whose branch was merged goes right away, even though it changed a moment ago', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'merged', { commit: true });
  git(ctx.app, ['merge', '-q', '--no-ff', '-m', 'land', 'codex/merged']);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  assert.deepEqual(repo.removed.map((item) => [item.name, item.reason]), [['merged', 'merged']]);
  assert.match(git(ctx.app, ['branch', '--list', 'codex/merged']), /codex\/merged/, 'the branch stays');
});

test('a fresh copy cut from main is not mistaken for merged work', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'fresh');
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), true);
  assert.equal(repo.kept[0].reason, 'recent');
});

test('a clean copy that was never merged or pushed is removed once idle, and its branch and commits stay', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'unmerged', { commit: true });
  const head = git(copy, ['rev-parse', 'HEAD']);
  age(copy, 25);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(repo.removed.length, 1);
  assert.equal(git(ctx.app, ['rev-parse', 'codex/unmerged']), head, 'the branch still points at its commit');
  assert.deepEqual(putAwayRefs(ctx.app), [], 'a clean copy needs no put-away commit');
});

test('tracked changes, untracked files and an empty folder are put away, then restored as they were', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'dirty', { commit: true });
  const head = git(copy, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = 2;\n');
  const untracked = Buffer.from([0, 1, 2, 250, 255, 10, 13, 10]);
  fs.mkdirSync(path.join(copy, 'notes'));
  fs.writeFileSync(path.join(copy, 'notes', 'idea.bin'), untracked);
  fs.mkdirSync(path.join(copy, 'empty', 'deeper'), { recursive: true });
  const statusBefore = git(copy, ['status', '--porcelain', '-uall']);
  age(copy, 30);

  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  const record = repo.removed[0].record;
  assert.equal(record.ref, 'refs/atris/put-away/dirty');
  assert.deepEqual(putAwayRefs(ctx.app), ['refs/atris/put-away/dirty']);
  assert.equal(git(ctx.app, ['rev-parse', `${record.ref}^`]), head, 'the put-away commit sits on the copy HEAD');
  assert.equal(git(ctx.app, ['rev-parse', 'codex/dirty']), head, 'the branch did not move');

  const listed = putaway.readRecords({ home: ctx.home });
  assert.deepEqual(listed.map((item) => item.name), ['dirty']);

  const back = putaway.restoreCopy({ name: 'dirty', home: ctx.home });
  assert.equal(back.ok, true, back.error);
  assert.equal(back.path, copy);
  assert.equal(git(copy, ['rev-parse', 'HEAD']), head);
  assert.equal(git(copy, ['branch', '--show-current']), 'codex/dirty');
  assert.equal(git(copy, ['status', '--porcelain', '-uall']), statusBefore);
  const raw = spawnSync('git', ['status', '--porcelain'], { cwd: copy, encoding: 'utf8' }).stdout;
  assert.match(raw, /^ M app\.js$/m, 'the tracked change is unstaged');
  assert.match(raw, /^\?\? notes\/$/m, 'the new file is untracked again');
  assert.equal(git(copy, ['diff', '--cached', '--name-only']), '', 'nothing is staged');
  assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), 'module.exports = 2;\n');
  assert.ok(fs.readFileSync(path.join(copy, 'notes', 'idea.bin')).equals(untracked), 'the untracked file is back byte for byte');
  assert.deepEqual(putAwayRefs(ctx.app), [], 'a finished restore drops the ref');
  assert.equal(putaway.readRecords({ home: ctx.home }).length, 0);
});

test('a copy holding only tool-made files and an install is removed and nothing is saved', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'plumbing');
  for (const [rel, body] of [
    ['.atris/state/tasks.projection.json', '{}\n'],
    ['.atris/state/atris_goal.json', '{"goal":1}\n'],
    ['.atris/agent-worktree.json', '{}\n'],
    ['atris/qa/computer-doctor/log.jsonl', '{"ok":true}\n'],
    ['atris/runs/run-1.json', '{}\n'],
    ['node_modules/left-pad/index.js', 'module.exports = 0;\n'],
    ['.next/cache/0.pack', 'pack'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
    fs.writeFileSync(path.join(copy, rel), body);
  }
  fs.symlinkSync(path.join(ctx.app, 'app.js'), path.join(copy, 'node_modules', 'link.js'));
  age(copy, 30);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  const record = repo.removed[0].record;
  assert.equal(record.ref, null);
  assert.equal(record.tar, null);
  assert.deepEqual(putAwayRefs(ctx.app), []);
});

test('an ignored file that differs from main goes into a private tar, never into git', (t) => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.app, '.env.local'), 'TOKEN=main\n');
  const copy = addCopy(ctx, 'secret');
  fs.writeFileSync(path.join(copy, '.env.local'), 'TOKEN=only-in-the-copy\n');
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = 5;\n');
  age(copy, 30);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  const record = repo.removed[0].record;
  assert.ok(record.tar && fs.existsSync(record.tar));
  assert.equal(fs.statSync(record.tar).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(record.tar)).mode & 0o777, 0o700);
  const listedTree = git(ctx.app, ['ls-tree', '-r', '--name-only', record.commit]).split('\n');
  assert.ok(listedTree.includes('app.js'));
  assert.ok(!listedTree.includes('.env.local'), 'the ignored file is not in the put-away commit');
  const tarList = spawnSync('tar', ['-tf', record.tar], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(tarList, ['.env.local']);

  const back = putaway.restoreCopy({ name: 'secret', home: ctx.home });
  assert.equal(back.ok, true, back.error);
  assert.equal(fs.readFileSync(path.join(copy, '.env.local'), 'utf8'), 'TOKEN=only-in-the-copy\n');
  assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), 'module.exports = 5;\n');
});

test('an ignored file identical to the main copy is not saved', (t) => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.app, '.env.local'), 'TOKEN=same\n');
  const copy = addCopy(ctx, 'same');
  fs.writeFileSync(path.join(copy, '.env.local'), 'TOKEN=same\n');
  age(copy, 30);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(repo.removed[0].record.tar, null);
});

test('a copy changed an hour ago is kept with the reason, and goes when the idle window is zero', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'recent', { commit: true });
  age(copy, 1);
  const kept = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), true);
  assert.equal(kept.kept[0].reason, 'recent');
  assert.match(kept.kept[0].text, /changed 1 hour ago/);
  const gone = sweepApp(ctx, { idleMs: 0 });
  assert.equal(fs.existsSync(copy), false);
  assert.equal(gone.removed.length, 1);
});

test('the idle window comes from ATRIS_WORKTREE_IDLE_HOURS when set', () => {
  assert.equal(putaway.idleMsFromEnv({}), 24 * HOUR_MS);
  assert.equal(putaway.idleMsFromEnv({ ATRIS_WORKTREE_IDLE_HOURS: '0' }), 0);
  assert.equal(putaway.idleMsFromEnv({ ATRIS_WORKTREE_IDLE_HOURS: '6' }), 6 * HOUR_MS);
  assert.equal(putaway.idleMsFromEnv({ ATRIS_WORKTREE_IDLE_HOURS: 'nonsense' }), 24 * HOUR_MS);
});

test('a locked copy is kept', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'locked', { commit: true });
  git(ctx.app, ['worktree', 'lock', copy]);
  age(copy, 30);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), true);
  assert.equal(repo.kept[0].reason, 'locked');
});

test('a copy a running program stands in is kept, found by the real process scan', async (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'busy', { commit: true });
  fs.mkdirSync(path.join(copy, 'sub'));
  age(copy, 30);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: path.join(copy, 'sub'), stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const cwds = putaway.listProcessCwds();
  if (!Array.isArray(cwds)) {
    t.skip('this machine cannot list process working folders');
    return;
  }
  const report = putaway.sweep({ workspace: ctx.ws, home: ctx.home, current: ctx.ws, apply: true });
  const repo = report.repos.find((item) => item.name === 'app');
  assert.equal(fs.existsSync(copy), true);
  assert.equal(repo.kept[0].reason, 'process');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
});

test('the copy this command runs in is kept', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'here', { commit: true });
  age(copy, 30);
  const repo = sweepApp(ctx, { current: copy });
  assert.equal(fs.existsSync(copy), true);
  assert.equal(repo.kept[0].reason, 'current');
});

test('when the put-away cannot be written, the copy is left exactly as it was', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('root ignores folder permissions');
    return;
  }
  const ctx = setup(t);
  const copy = addCopy(ctx, 'stuck', { commit: true });
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = 9;\n');
  fs.writeFileSync(path.join(copy, 'draft.md'), 'draft\n');
  fs.writeFileSync(path.join(copy, '.env.local'), 'TOKEN=copy\n');
  age(copy, 30);
  const status = git(copy, ['status', '--porcelain', '-uall']);
  fs.chmodSync(ctx.home, 0o500);
  t.after(() => { try { fs.chmodSync(ctx.home, 0o700); } catch {} });
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), true);
  assert.equal(repo.kept[0].reason, 'put_away_failed');
  assert.match(repo.kept[0].text, /^put-away failed: /);
  assert.equal(git(copy, ['status', '--porcelain', '-uall']), status);
  assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), 'module.exports = 9;\n');
  assert.equal(fs.readFileSync(path.join(copy, 'draft.md'), 'utf8'), 'draft\n');
  assert.equal(fs.readFileSync(path.join(copy, '.env.local'), 'utf8'), 'TOKEN=copy\n');
  assert.deepEqual(putAwayRefs(ctx.app), [], 'a failed put-away leaves no ref behind');
});

test('bytes a content filter hides from git status are still saved and restored', (t) => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.app, '.gitattributes'), 'secret.txt filter=strip\n');
  // Same length on purpose: git status trusts a size change without reading.
  git(ctx.app, ['config', 'filter.strip.clean', 'sed s/hidden/XXXXXX/']);
  git(ctx.app, ['config', 'filter.strip.smudge', 'cat']);
  fs.writeFileSync(path.join(ctx.app, 'secret.txt'), 'visibleXXXXXX\n');
  git(ctx.app, ['add', '.']);
  git(ctx.app, ['commit', '-qm', 'filtered file']);
  const copy = addCopy(ctx, 'filtered');
  fs.writeFileSync(path.join(copy, 'secret.txt'), 'visiblehidden\n');
  assert.equal(git(copy, ['status', '--porcelain']), '', 'git status cannot see the local text');
  age(copy, 30);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  assert.ok(repo.removed[0].record.tar, 'the hidden bytes went into the tar');
  const back = putaway.restoreCopy({ name: 'filtered', home: ctx.home });
  assert.equal(back.ok, true, back.error);
  assert.equal(fs.readFileSync(path.join(copy, 'secret.txt'), 'utf8'), 'visiblehidden\n');
});

test('a dry run changes nothing', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'dry', { commit: true });
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = 7;\n');
  age(copy, 30);
  const status = git(copy, ['status', '--porcelain', '-uall']);
  const repo = sweepApp(ctx, { apply: false });
  assert.deepEqual(repo.removed.map((item) => [item.name, item.dryRun]), [['dry', true]]);
  assert.equal(fs.existsSync(copy), true);
  assert.equal(git(copy, ['status', '--porcelain', '-uall']), status);
  assert.deepEqual(putAwayRefs(ctx.app), []);
  assert.deepEqual(fs.readdirSync(ctx.home), []);
});

test('start puts away the oldest idle copy when over the per-repo ceiling, and never an in-use one', (t) => {
  const ctx = setup(t);
  const oldest = addCopy(ctx, 'oldest', { commit: true });
  const middle = addCopy(ctx, 'middle', { commit: true });
  const busy = addCopy(ctx, 'busy', { commit: true });
  age(oldest, 5);
  age(middle, 3);
  const created = createAgentWorktree({
    root: ctx.app, agent: 'codex', task: 'ceiling', deps: false, spaceGuard: false, putAwayHome: ctx.home, activeCwds: [],
    env: { ATRIS_WORKTREE_MAX_PER_REPO: '3', ATRIS_WORKTREE_MAX_GB: '0' },
  });
  assert.equal(fs.existsSync(oldest), false, 'the oldest idle copy went');
  assert.equal(fs.existsSync(middle), true, 'one removal was enough');
  assert.equal(fs.existsSync(busy), true, 'the copy changed just now stays');
  assert.deepEqual(created.ceiling.removed.map((item) => item.path), [oldest]);
  assert.equal(created.ceiling.over, false);
  assert.match(putaway.ceilingLine(created.ceiling), /put away and removed 1 idle copy/);

  // Everything left is in use: start goes ahead and names them.
  const again = createAgentWorktree({
    root: ctx.app, agent: 'codex', task: 'ceiling two', deps: false, spaceGuard: false, putAwayHome: ctx.home, activeCwds: [],
    env: { ATRIS_WORKTREE_MAX_PER_REPO: '1', ATRIS_WORKTREE_MAX_GB: '0' },
  });
  assert.equal(fs.existsSync(again.path), true);
  assert.equal(fs.existsSync(busy), true);
  assert.equal(again.ceiling.over, true);
  const line = putaway.ceilingLine(again.ceiling);
  assert.match(line, /still over 1 copies .* because these are in use: /);
  assert.match(line, /busy \(/);
});

test('the size ceiling counts what copies hold and frees the oldest idle one', (t) => {
  const ctx = setup(t);
  const oldest = addCopy(ctx, 'big-old', { commit: true });
  fs.writeFileSync(path.join(oldest, 'blob.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  const newer = addCopy(ctx, 'big-new', { commit: true });
  fs.writeFileSync(path.join(newer, 'blob.bin'), Buffer.alloc(3 * 1024 * 1024, 2));
  age(oldest, 6);
  age(newer, 2);
  const result = putaway.enforceCeiling({
    repo: ctx.app, home: ctx.home, cwds: [], current: ctx.ws,
    env: { ATRIS_WORKTREE_MAX_GB: String(5 / 1000), ATRIS_WORKTREE_MAX_PER_REPO: '0' },
  });
  assert.deepEqual(result.removed.map((item) => item.path), [oldest]);
  assert.equal(fs.existsSync(newer), true);
  assert.equal(result.over, false);
  assert.ok(putaway.readRecords({ home: ctx.home }).some((record) => record.name === 'big-old' && record.ref), 'the untracked blob was saved in the put-away commit');
});

test('start clones the main install when the lockfiles match, as a real folder, and skips it when they differ', (t) => {
  const ctx = setup(t, { files: { 'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n', 'package.json': '{"name":"app"}\n' } });
  fs.mkdirSync(path.join(ctx.app, 'node_modules', 'left'), { recursive: true });
  fs.writeFileSync(path.join(ctx.app, 'node_modules', 'left', 'index.js'), 'module.exports = 1;\n');
  const same = createAgentWorktree({ root: ctx.app, agent: 'codex', task: 'deps same', deps: {}, spaceGuard: false, putAwayHome: ctx.home, activeCwds: [], env: {} });
  const modules = path.join(same.path, 'node_modules');
  if (same.deps.status !== 'cloned') {
    assert.match(same.deps.reason, /clone failed|cannot clone|no folder clone|another disk/, 'only a disk that cannot clone may skip');
    t.skip(`this disk cannot clone folders: ${same.deps.reason}`);
    return;
  }
  const stat = fs.lstatSync(modules);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(modules, 'left', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.doesNotMatch(git(same.path, ['status', '--porcelain']), /node_modules/, 'git ignores the cloned install');
  // The clone is its own folder: changing it leaves the main install alone.
  fs.writeFileSync(path.join(modules, 'left', 'index.js'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(ctx.app, 'node_modules', 'left', 'index.js'), 'utf8'), 'module.exports = 1;\n');

  fs.writeFileSync(path.join(ctx.app, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/x":{"version":"1.0.0"}}}\n');
  const differs = createAgentWorktree({ root: ctx.app, agent: 'codex', task: 'deps differ', deps: {}, spaceGuard: false, putAwayHome: ctx.home, activeCwds: [], env: {} });
  assert.equal(differs.deps.status, 'skipped');
  assert.equal(fs.existsSync(path.join(differs.path, 'node_modules')), false);
});

test('a stray empty .agent-worktrees inside a repo does not hide the real copies', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'real', { commit: true });
  fs.mkdirSync(path.join(ctx.app, '.agent-worktrees'));
  age(copy, 30);
  assert.equal(defaultSweepWorkspace(ctx.app), ctx.ws);
  assert.equal(defaultSweepWorkspace(path.join(ctx.ws, '.agent-worktrees', 'app', 'real')), ctx.ws);

  // The command, run from inside the repo, finds it too (dry run).
  const run = spawnSync(process.execPath, [CLI, 'worktree', 'sweep', '--json'], {
    cwd: ctx.app, encoding: 'utf8', timeout: 60000,
    env: { ...scrubAgentEnv(), HOME: ctx.home, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_PUT_AWAY_DIR: path.join(ctx.home, 'put-away') },
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
  assert.equal(report.workspace, ctx.ws);
  const repo = report.repos.find((item) => item.name === 'app');
  assert.deepEqual(repo.removed.map((item) => item.name), ['real']);
  assert.equal(fs.existsSync(copy), true);
});

test('run inside a repo, the sweep reaches its copies wherever they live', (t) => {
  const ctx = setup(t);
  const elsewhere = path.join(ctx.ws, 'somewhere-else', 'loose-copy');
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  git(ctx.app, ['worktree', 'add', '-q', '-b', 'codex/loose', elsewhere, 'master']);
  age(elsewhere, 30);
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-put-away-empty-ws-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const report = putaway.sweep({ workspace: other, repos: [ctx.app], home: ctx.home, cwds: [], current: other, apply: true });
  assert.equal(report.repos.length, 1);
  assert.equal(fs.existsSync(elsewhere), false);
});

test('a frozen or slow sweep job is spotted, and the new job runs the atris on PATH every hour', (t) => {
  const ctx = setup(t);
  const frozen = path.join(ctx.home, 'ai.atris.worktree-sweep.ab12cd34.plist');
  fs.writeFileSync(frozen, `<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/env</string><string>node</string><string>${ctx.home}/.atris/worktree-sweep/cli/bin/atris.js</string><string>worktree</string><string>sweep</string></array><key>StartInterval</key><integer>10800</integer></dict></plist>\n`);
  const hint = putaway.sweepJobHint({ files: [frozen] });
  assert.match(hint, /frozen copy of atris/);
  assert.match(hint, /run atris worktree sweep --install/);

  const plan = sweepSchedulePlan({ workspace: '/w/arena', homeDir: ctx.home, platform: 'darwin', envPath: '/usr/bin:/bin' });
  assert.equal(plan.every_seconds, 3600);
  assert.match(plan.contents, /<string>\/usr\/bin\/env<\/string><string>atris<\/string><string>worktree<\/string><string>sweep<\/string><string>--apply<\/string><string>--job<\/string>/);
  assert.doesNotMatch(plan.contents, /atris\.js/);
  const fresh = path.join(ctx.home, 'ai.atris.worktree-sweep.new.plist');
  fs.writeFileSync(fresh, plan.contents);
  assert.equal(putaway.sweepJobHint({ files: [fresh] }), '');

  const cron = sweepSchedulePlan({ workspace: '/w/arena', homeDir: ctx.home, platform: 'linux', envPath: '/usr/bin:/bin' });
  assert.equal(putaway.sweepJobProblem(cron.crontab_line, { kind: 'cron' }), '');
  assert.match(putaway.sweepJobProblem('0 */3 * * * cd /w && /usr/bin/env node /x/bin/atris.js worktree sweep # ATRIS_WORKTREE_SWEEP_1', { kind: 'cron' }), /frozen/);

  if (process.platform === 'darwin') {
    // The hint line shows on a normal sweep, read from a fake home only.
    const agents = path.join(ctx.home, 'Library', 'LaunchAgents');
    fs.mkdirSync(agents, { recursive: true });
    fs.copyFileSync(frozen, path.join(agents, 'ai.atris.worktree-sweep.ab12cd34.plist'));
    const run = spawnSync(process.execPath, [CLI, 'worktree', 'sweep', '--workspace', ctx.ws], {
      cwd: ctx.ws, encoding: 'utf8', timeout: 60000,
      env: { ...scrubAgentEnv(), HOME: ctx.home, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_PUT_AWAY_DIR: path.join(ctx.home, 'put-away') },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /timer: the build-copy cleaner runs a frozen copy of atris on the wrong schedule; run atris worktree sweep --install to fix it/);
  }
});

test('the job writes one line per run with what it saw, removed, put away and kept', (t) => {
  const ctx = setup(t);
  const gone = addCopy(ctx, 'gone', { commit: true });
  fs.writeFileSync(path.join(gone, 'wip.md'), 'wip\n');
  age(gone, 30);
  addCopy(ctx, 'fresh', { commit: true });
  const report = putaway.sweep({ workspace: ctx.ws, home: ctx.home, cwds: [], current: ctx.ws, apply: true });
  const line = putaway.sweepLogLine(report);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /seen 2, removed 1 \(put away 1\), kept 1 \(1 changed recently\), freed /);
});

test('old put-away records go once merged or empty, and the rest stay', (t) => {
  const ctx = setup(t);
  const empty = addCopy(ctx, 'empty-old', { commit: true });
  const kept = addCopy(ctx, 'work-old', { commit: true });
  fs.writeFileSync(path.join(kept, 'wip.md'), 'wip\n');
  age(empty, 30);
  age(kept, 30);
  sweepApp(ctx);
  assert.equal(putaway.readRecords({ home: ctx.home }).length, 2);
  const later = Date.now() + 31 * 24 * HOUR_MS;
  const result = putaway.prunePutAway({ home: ctx.home, now: later });
  assert.deepEqual(result.pruned.map((record) => record.name), ['empty-old']);
  assert.deepEqual(putaway.readRecords({ home: ctx.home }).map((record) => record.name), ['work-old']);
  git(ctx.app, ['merge', '-q', '--no-ff', '-m', 'land', 'codex/work-old']);
  const second = putaway.prunePutAway({ home: ctx.home, now: later });
  assert.deepEqual(second.pruned.map((record) => record.name), ['work-old']);
  assert.deepEqual(putAwayRefs(ctx.app), []);
});

test('every path class is decided in one place', () => {
  assert.equal(putaway.isToolMade('.atris/state/tasks.projection.json'), true);
  assert.equal(putaway.isToolMade('atris/qa/computer-doctor/log.jsonl'), true);
  assert.equal(putaway.isToolMade('.atris/vault/token'), false, 'credentials are not junk');
  assert.equal(putaway.isRebuildable('web/node_modules/x/index.js'), true);
  assert.equal(putaway.isRebuildable('pkg/__pycache__/m.cpython-312.pyc'), true);
  assert.equal(putaway.isRebuildable('build/out.js'), false, 'an untracked build folder may be source');
  assert.equal(putaway.isRebuildable('build/out.js', { ignored: true }), true);
  assert.equal(putaway.isRebuildable('src/app.js'), false);
});
