'use strict';

require('./helpers/temp-home');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  cleanupWorktrees,
  createAgentWorktree,
  reapShippedCopy,
  scheduleShippedCopyRemoval,
  shippedCopyRemovalPlan,
  sweepSchedulePlan,
  sweepWorkspace,
} = require('../commands/worktree');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

// Put-away records go to a temp folder, never the real home folder.
const PUT_AWAY = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-disk-guard-put-away-')));
const PRIOR_PUT_AWAY = process.env.ATRIS_PUT_AWAY_DIR;
process.env.ATRIS_PUT_AWAY_DIR = PUT_AWAY;
test.after(() => {
  if (PRIOR_PUT_AWAY === undefined) delete process.env.ATRIS_PUT_AWAY_DIR;
  else process.env.ATRIS_PUT_AWAY_DIR = PRIOR_PUT_AWAY;
  fs.rmSync(PUT_AWAY, { recursive: true, force: true });
});

function workspace(t) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-disk-guard-')));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return ws;
}

// A checkout at <ws>/<name> with its origin next to it, like ~/arena.
function makeRepo(ws, name, { files = {}, origin = true } = {}) {
  const root = path.join(ws, name);
  fs.mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.next/\n.atris/\n');
  fs.writeFileSync(path.join(root, 'README.md'), `${name}\n`);
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(root, file), body);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  git(root, ['branch', '-M', 'master']);
  if (origin) {
    const remote = path.join(ws, `${name}-origin.git`);
    git(ws, ['init', '--bare', '-q', remote]);
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['push', '-q', '-u', 'origin', 'master']);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  }
  return root;
}

function backdate(target, hours) {
  const stamp = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(target, stamp, stamp);
}

// Every file and folder the idle check reads, plus the copy's HEAD in git.
function backdateCopy(copy, hours) {
  const gitDir = path.resolve(copy, git(copy, ['rev-parse', '--git-dir']));
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
    if (fs.existsSync(mark)) backdate(mark, hours);
  }
}

// Recent branch work (a commit or checkout) without touching the folder.
function touchBranch(copy) {
  const gitDir = path.resolve(copy, git(copy, ['rev-parse', '--git-dir']));
  const now = new Date();
  fs.utimesSync(path.join(gitDir, 'HEAD'), now, now);
}

// A build copy under <ws>/.agent-worktrees/<repo>/<name>.
function addCopy(root, name, { commit = false, hoursOld = 30, start = 'origin/master', at } = {}) {
  const copy = at || path.join(path.dirname(root), '.agent-worktrees', path.basename(root), name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', `codex/${name}`, copy, start]);
  if (commit) {
    fs.writeFileSync(path.join(copy, `${name}.txt`), 'work\n');
    git(copy, ['add', '.']);
    git(copy, ['commit', '-qm', `work ${name}`]);
  }
  backdateCopy(copy, hoursOld);
  return copy;
}

const LOCK = JSON.stringify({
  name: 'web',
  lockfileVersion: 3,
  packages: { '': { name: 'web' }, 'node_modules/left': { version: '1.2.0' } },
});

function writeInstall(dir) {
  const modules = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(modules, 'left'), { recursive: true });
  fs.writeFileSync(path.join(modules, 'left', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(modules, '.package-lock.json'), JSON.stringify({ name: 'web', lockfileVersion: 3, packages: { 'node_modules/left': { version: '1.2.0' } } }));
}

function copyClone(src, dst) {
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  return { ok: true, method: 'copy' };
}

function start(app, task, options) {
  return createAgentWorktree({ root: app, agent: 'codex', task, env: {}, deps: false, putAwayHome: PUT_AWAY, ...options });
}

test('a low disk makes start put away this repo\'s copies idle for a day, then refuse below the floor', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app');
  const other = makeRepo(ws, 'other');
  const finished = addCopy(app, 'finished');
  const unmerged = addCopy(app, 'unmerged', { commit: true });
  const unmergedHead = git(unmerged, ['rev-parse', 'HEAD']);
  const working = addCopy(app, 'working', { commit: true });
  touchBranch(working);
  const otherIdle = addCopy(other, 'other-idle', { commit: true });

  assert.throws(() => start(app, 'tight disk', { spaceGuard: true, freeSpace: () => 4e9, activeCwds: [] }), (error) => {
    assert.equal(error.code, 'ATRIS_LOW_DISK');
    assert.match(error.message, /only 4\.0 GB free on this disk, and a new build copy needs at least 10\.0 GB/);
    // The finished copy goes in the reap of done copies that runs first; the
    // low-disk pass then puts away the idle unmerged one.
    assert.match(error.message, /Put away and removed 1 idle build copy of this repo first/);
    return true;
  });
  assert.equal(fs.existsSync(finished), false, 'the idle merged copy was removed');
  assert.equal(fs.existsSync(unmerged), false, 'an idle unmerged copy goes too, since its commits stay');
  assert.equal(git(app, ['rev-parse', 'codex/unmerged']), unmergedHead, 'its branch still holds the work');
  assert.equal(fs.existsSync(working), true, 'a copy used today stays');
  assert.equal(fs.existsSync(otherIdle), true, 'another repo is never touched');
  assert.deepEqual(fs.readdirSync(path.join(ws, '.agent-worktrees', 'app')), ['working'], 'no copy was cut');
  assert.deepEqual(git(app, ['branch', '--list', 'codex/*']).split('\n').map((line) => line.replace(/^[*+ ]+/, '')).sort(), ['codex/finished', 'codex/unmerged', 'codex/working'], 'no branch was cut');
});

test('start below the reap line but above the floor reaps and then proceeds', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app');
  const other = makeRepo(ws, 'other');
  const finished = addCopy(app, 'finished', { commit: true });
  const justDone = addCopy(app, 'just-done');
  touchBranch(justDone);
  const otherIdle = addCopy(other, 'other-idle');
  const created = start(app, 'some room', { spaceGuard: true, freeSpace: () => 20e9, activeCwds: [] });
  assert.equal(created.space.removed.length, 1);
  assert.equal(created.space.free, 20e9);
  assert.equal(fs.existsSync(finished), false);
  assert.equal(fs.existsSync(justDone), true, 'a copy with work today stays');
  assert.equal(fs.existsSync(otherIdle), true, 'another repo is never touched');
  assert.equal(fs.existsSync(created.path), true);
});

test('start with room to spare leaves other copies alone', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app');
  const other = makeRepo(ws, 'other');
  const finished = addCopy(other, 'finished');
  const created = start(app, 'plenty', { spaceGuard: true, freeSpace: () => 100e9 });
  assert.equal(created.space.removed.length, 0);
  assert.equal(fs.existsSync(finished), true);
});

test('the floor can be turned off, and temp folders skip the guard unless asked', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app');
  const off = start(app, 'floor off', { spaceGuard: true, freeSpace: () => 1, env: { ATRIS_WORKTREE_MIN_FREE_GB: '0' } });
  assert.equal(fs.existsSync(off.path), true);
  const scratch = start(app, 'temp folder', { freeSpace: () => 1 });
  assert.equal(scratch.space, null);
  assert.equal(fs.existsSync(scratch.path), true);
});

test('start clones node_modules from a matching install and the copy stays clean', (t) => {
  const ws = workspace(t);
  const web = makeRepo(ws, 'web', { files: { 'package-lock.json': LOCK } });
  const busy = addCopy(web, 'busy', { hoursOld: 0 });
  writeInstall(busy);
  const created = start(web, 'web change', { deps: { clone: copyClone } });
  assert.equal(created.deps.status, 'cloned', created.deps.reason);
  assert.equal(fs.readFileSync(path.join(created.path, 'node_modules', 'left', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(git(created.path, ['status', '--porcelain']), '', 'node_modules is ignored, so guard and ship see a clean copy');
  assert.equal(fs.readdirSync(path.join(ws, '.agent-worktrees', '.deps', 'web')).length, 1, 'the install now lives in the shared store');

  const optedOut = createAgentWorktree({ root: web, agent: 'codex', task: 'no clone', env: { ATRIS_WORKTREE_NO_DEP_CLONE: '1' }, deps: { clone: copyClone } });
  assert.equal(optedOut.deps, null);
  assert.equal(fs.existsSync(path.join(optedOut.path, 'node_modules')), false);
});

test('cleanup can be scoped to given copies and paced by recent work', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app', { files: { 'package.json': '{}\n' } });
  const chosen = addCopy(app, 'chosen');
  const other = addCopy(app, 'other');
  const scoped = cleanupWorktrees({ root: app, base: 'origin/master', apply: true, activeCwds: [], onlyPaths: [chosen] });
  assert.deepEqual(scoped.removed.map((item) => item.path), [chosen]);
  assert.ok(scoped.kept.some((item) => item.path === other && item.reason === 'out_of_scope'));

  const working = addCopy(app, 'working');
  // Only the branch moved recently; the folder itself is past the start grace.
  touchBranch(working);
  const paced = cleanupWorktrees({ root: app, base: 'origin/master', activeCwds: [], idleMs: 2 * 60 * 60 * 1000, onlyPaths: [working, other] });
  assert.ok(paced.kept.some((item) => item.path === working && item.reason === 'recent_activity'));
  assert.ok(paced.candidates.some((item) => item.path === other));

  const fresh = addCopy(app, 'fresh', { hoursOld: 0 });
  assert.ok(cleanupWorktrees({ root: app, base: 'origin/master', activeCwds: [], onlyPaths: [fresh] }).kept.some((item) => item.reason === 'fresh_worktree_grace'));
  const shipped = cleanupWorktrees({ root: app, base: 'origin/master', apply: true, activeCwds: [], onlyPaths: [fresh], freshGraceMs: 0 });
  assert.deepEqual(shipped.removed.map((item) => item.path), [fresh]);

  // An install git ignores comes back with one command, so it does not pin a merged copy.
  const installed = addCopy(app, 'installed');
  fs.mkdirSync(path.join(installed, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 0;\n');
  backdateCopy(installed, 3);
  const gone = cleanupWorktrees({ root: app, base: 'origin/master', apply: true, activeCwds: [], onlyPaths: [installed] });
  assert.deepEqual(gone.removed.map((item) => item.path), [installed]);

  // An ignored local database cannot come back, so it keeps a merged copy for review.
  const holding = addCopy(app, 'holding');
  fs.mkdirSync(path.join(holding, '.atris'));
  fs.writeFileSync(path.join(holding, '.atris', 'state.db'), 'local data');
  backdateCopy(holding, 3);
  const review = cleanupWorktrees({ root: app, base: 'origin/master', apply: true, activeCwds: [], onlyPaths: [holding] });
  assert.ok(review.kept.some((item) => item.path === holding && item.reason === 'ignored_data'));
  assert.equal(fs.existsSync(holding), true);
});

test('the sweep puts away idle copies atris made in every repo, merged or not, and keeps busy, recent and hand-made ones', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app', { files: { 'package.json': '{}\n' } });
  const other = makeRepo(ws, 'other');
  const local = makeRepo(ws, 'local', { origin: false });
  const merged = addCopy(app, 'merged');
  const idleUnmerged = addCopy(app, 'idle-unmerged', { commit: true });
  const packs = path.join(idleUnmerged, '.next', 'cache', 'webpack');
  fs.mkdirSync(path.join(packs, 'client-production'), { recursive: true });
  fs.writeFileSync(path.join(packs, 'client-production', '0.pack'), 'rebuildable');
  backdate(path.join(idleUnmerged, '.next'), 3);
  backdateCopy(idleUnmerged, 3);
  const changed = addCopy(app, 'changed');
  fs.writeFileSync(path.join(changed, 'notes.txt'), 'not committed\n');
  backdate(path.join(changed, 'notes.txt'), 3);
  backdateCopy(changed, 3);
  const busy = addCopy(other, 'busy');
  const recent = addCopy(other, 'recent', { hoursOld: 1.5 });
  const outside = addCopy(app, 'outside', { at: path.join(ws, 'outside-copy') });
  const localCopy = addCopy(local, 'local-copy', { start: 'master' });
  const idleMs = 2 * 60 * 60 * 1000;

  const dry = sweepWorkspace({ workspace: ws, activeCwds: [busy], freeSpace: () => 5e9, idleMs, current: ws });
  const appDry = dry.repos.find((repo) => repo.name === 'app');
  assert.deepEqual(appDry.removed.map((item) => item.name).sort(), ['changed', 'idle-unmerged', 'merged']);
  for (const copy of [merged, idleUnmerged, changed, outside]) assert.equal(fs.existsSync(copy), true, 'a dry run removes nothing');

  const applied = sweepWorkspace({ workspace: ws, apply: true, activeCwds: [busy], idleMs, current: ws });
  for (const gone of [merged, idleUnmerged, changed, localCopy]) assert.equal(fs.existsSync(gone), false, gone);
  for (const keptCopy of [busy, recent, outside]) assert.equal(fs.existsSync(keptCopy), true, keptCopy);
  const reasons = (name) => applied.repos.find((repo) => repo.name === name).kept.map((item) => item.reason).sort();
  assert.deepEqual(reasons('app'), []);
  assert.deepEqual(reasons('other'), ['process', 'recent']);
  assert.equal(applied.repos.find((repo) => repo.name === 'local').removed.length, 1, 'a repo without origin is swept too');
  const changedRecord = applied.repos.find((repo) => repo.name === 'app').removed.find((item) => item.name === 'changed').record;
  // An untracked file goes into the private tar, never into the ref.
  assert.notEqual(spawnSync('git', ['cat-file', '-e', `${changedRecord.ref}:notes.txt`], { cwd: app }).status, 0);
  const inTar = spawnSync('tar', ['-tf', changedRecord.tar], { encoding: 'utf8' }).stdout.split('\n');
  assert.ok(inTar.includes('notes.txt'));
  assert.equal(typeof applied.before, 'number');
});

test('one sweep has no per-run cap: every idle copy in every repo goes', (t) => {
  const ws = workspace(t);
  const first = makeRepo(ws, 'app');
  const second = makeRepo(ws, 'other');
  for (let i = 0; i < 11; i++) {
    addCopy(first, `app-${i}`);
    addCopy(second, `other-${i}`);
  }
  const applied = sweepWorkspace({ workspace: ws, apply: true, activeCwds: [], idleMs: 60 * 60 * 1000, current: ws });
  assert.equal(applied.repos.flatMap((repo) => repo.removed || []).length, 22);
});

test('an applied sweep leaves shared installs and old partial entries intact', (t) => {
  const ws = workspace(t);
  const root = makeRepo(ws, 'app');
  addCopy(root, 'finished');
  const dir = path.join(ws, '.agent-worktrees', '.deps', 'app');
  for (const name of ['old1', 'old2', 'old3', 'old4', '.partial-old']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'local-notes.txt'), name);
    backdate(path.join(dir, name), 3);
  }
  const applied = sweepWorkspace({ workspace: ws, apply: true, activeCwds: [], idleMs: 60 * 60 * 1000, current: ws });
  assert.equal(applied.repos.find((repo) => repo.name === 'app').removed.length, 1);
  for (const name of ['old1', 'old2', 'old3', 'old4', '.partial-old']) {
    assert.equal(fs.readFileSync(path.join(dir, name, 'local-notes.txt'), 'utf8'), name);
  }
});

test('the sweep timer runs the atris on PATH every hour from launchd', (t) => {
  const home = workspace(t);
  const plan = sweepSchedulePlan({ workspace: '/w/arena', homeDir: home, platform: 'darwin' });
  assert.equal(plan.kind, 'launchd');
  assert.match(plan.label, /^ai\.atris\.worktree-sweep\./);
  assert.equal(plan.every_seconds, 3600);
  assert.match(plan.contents, /<string>\/usr\/bin\/env<\/string><string>atris<\/string><string>worktree<\/string><string>sweep<\/string><string>--apply<\/string><string>--job<\/string><string>--workspace<\/string><string>\/w\/arena<\/string>/);
  assert.equal(plan.log_path, path.join(home, '.atris', 'worktree-sweep', 'worktree-sweep.log'));
});

test('a shipped copy is handed to a detached waiter only when it is a real agent copy', () => {
  // Paths only; nothing is made. Not under the temp HOME, which is a temp folder.
  const base = path.join(path.parse(process.cwd()).root, 'atris-never-made');
  const primary = path.join(base, 'app');
  const copy = path.join(base, '.agent-worktrees', 'app', 'c1');
  assert.deepEqual(shippedCopyRemovalPlan({ root: copy, primary, env: {}, atrisBin: '/opt/atris/bin/atris.js' }), { copy });
  assert.equal(shippedCopyRemovalPlan({ root: copy, primary, env: { ATRIS_WORKTREE_KEEP_AFTER_SHIP: '1' } }).announce, true);
  assert.match(shippedCopyRemovalPlan({ root: primary, primary, env: {} }).skip, /primary/);
  assert.match(shippedCopyRemovalPlan({ root: path.join(base, 'elsewhere'), primary, env: {} }).skip, /not an agent build copy/);
  assert.match(shippedCopyRemovalPlan({ root: path.join(os.tmpdir(), '.agent-worktrees', 'app', 'c1'), primary, env: {} }).skip, /temp folder/);
  assert.match(shippedCopyRemovalPlan({ root: copy, primary, env: {}, atrisBin: path.join(copy, 'bin', 'atris.js') }).skip, /inside the copy/);

  const calls = [];
  const fakeSpawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { on() {}, unref() { calls.push('unref'); } };
  };
  const scheduled = scheduleShippedCopyRemoval({ root: copy, primary, branch: 'codex/x', base: 'origin/master', env: { PATH: '/bin' }, spawnProcess: fakeSpawn });
  assert.equal(scheduled.scheduled, true);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args.slice(1), ['worktree', 'reap-shipped']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.cwd, primary);
  assert.equal(calls[0].options.env.ATRIS_REAP_WORKTREE, copy);
  assert.equal(calls[0].options.env.ATRIS_REAP_BASE, 'origin/master');
  assert.ok(!calls[0].args.some((arg) => arg.includes(copy)), 'the copy stays out of the arguments the process scan reads');
  assert.equal(calls[1], 'unref');
});

function runWaiter(reasons, { giveUpMs = 6 * 60 * 60 * 1000 } = {}) {
  const target = '/w/.agent-worktrees/app/c1';
  const sleeps = [];
  const seen = [];
  let now = 0;
  const result = reapShippedCopy({
    root: '/w/app',
    target,
    base: 'origin/master',
    settleMs: 10 * 60 * 1000,
    pollMs: 60 * 1000,
    giveUpMs,
    unmergedGraceMs: 15 * 60 * 1000,
    sleep: (ms) => { sleeps.push(ms); now += ms; },
    clock: () => now,
    cleanup: (options) => {
      seen.push(options);
      const reason = reasons[Math.min(seen.length - 1, reasons.length - 1)];
      if (reason === 'removed') return { removed: [{ path: target, reason: 'merged_into_base' }], kept: [] };
      if (reason === 'gone') return { removed: [], kept: [] };
      return { removed: [], kept: [{ path: target, reason }] };
    },
  });
  return { result, sleeps, seen };
}

test('the waiter removes a shipped copy once nothing runs in it, and stops on changes or unmerged work', () => {
  const freed = runWaiter(['active_process', 'recent_activity', 'removed']);
  assert.deepEqual(freed.result, { removed: true, reason: 'merged_into_base' });
  assert.deepEqual(freed.sleeps, [600000, 60000, 60000]);
  const options = freed.seen[0];
  assert.equal(options.apply, true);
  assert.equal(options.freshGraceMs, 0);
  assert.equal(options.idleMs, 600000);
  assert.deepEqual(options.onlyPaths, ['/w/.agent-worktrees/app/c1']);

  assert.deepEqual(runWaiter(['dirty']).result, { removed: false, reason: 'dirty' });
  assert.deepEqual(runWaiter(['gone']).result, { removed: false, reason: 'not_registered' });
  const unmerged = runWaiter(['unmerged']);
  assert.equal(unmerged.result.reason, 'unmerged');
  assert.equal(unmerged.seen.length, 6, 'checks at 10 through 15 minutes, then leaves it for the sweep');
  const stuck = runWaiter(['active_process'], { giveUpMs: 13 * 60 * 1000 });
  assert.equal(stuck.result.reason, 'active_process');
  assert.equal(stuck.seen.length, 4);
});

test('the waiter removes a real merged copy', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app');
  const copy = addCopy(app, 'shipped', { hoursOld: 0 });
  const result = reapShippedCopy({ root: app, target: copy, base: 'origin/master', settleMs: 0, sleep: () => {} });
  assert.deepEqual(result, { removed: true, reason: 'merged_into_base' });
  assert.equal(fs.existsSync(copy), false);
  assert.match(git(app, ['branch', '--list', 'codex/shipped']), /codex\/shipped/, 'the branch survives');
});
