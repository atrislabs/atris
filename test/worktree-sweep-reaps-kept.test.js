'use strict';

// The sweep kept 52 copies on 2026-11-17 and freed nothing. These cover the
// safe cases it now handles and the ones it must still keep.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../lib/worktree-core');
const stale = require('../lib/worktree-stale');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function repo(ignore = 'venv\n.venv/\n.env*\nnode_modules\n') {
  const root = tmp('atris-sweep-kept-');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(root, '.gitignore'), ignore);
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

function backdate(target, hours) {
  const when = new Date(Date.now() - hours * 3600000);
  fs.utimesSync(target, when, when);
}

test('a linked venv or node_modules is not data; a real .env.local still is', () => {
  const root = repo();
  const shared = tmp('atris-shared-venv-');
  try {
    fs.symlinkSync(shared, path.join(root, 'venv'));
    fs.symlinkSync(shared, path.join(root, 'node_modules'));
    assert.deepEqual(core.ignoredFilesToKeep(root), []);
    fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=1\n');
    assert.deepEqual(core.ignoredFilesToKeep(root), ['.env.local']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shared, { recursive: true, force: true });
  }
});

test('a real venv counts as throwaway only when pyvenv.cfg marks it', () => {
  const root = repo();
  try {
    fs.mkdirSync(path.join(root, '.venv', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, '.venv', 'lib', 'x.py'), 'x = 1\n');
    assert.deepEqual(core.ignoredFilesToKeep(root), ['.venv/lib/x.py']);
    fs.writeFileSync(path.join(root, '.venv', 'pyvenv.cfg'), 'home = /usr\n');
    assert.deepEqual(core.ignoredFilesToKeep(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unregistered gitlink that was never checked out holds nothing', () => {
  const root = repo();
  try {
    const oid = git(root, ['rev-parse', 'HEAD']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${oid},sovereign`]);
    git(root, ['commit', '-qm', 'gitlink']);
    assert.equal(core.unprovableReason(root), '');
    fs.mkdirSync(path.join(root, 'sovereign'));
    fs.writeFileSync(path.join(root, 'sovereign', 'notes.md'), 'work\n');
    assert.match(core.unprovableReason(root), /not a registered submodule/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale holders: only old dev servers and test runners, all of them', () => {
  const wt = '/tmp/atris-copy-x';
  const proc = (pid, hours, args, paths = [`${wt}/app`]) => ({ pid, elapsed_s: hours * 3600, args, paths });
  const day = 24 * 3600000;
  assert.deepEqual(stale.staleHolders(wt, [proc(1, 30, 'node /x/node_modules/.bin/next dev')], { staleMs: day }).map((h) => h.pid), [1]);
  assert.equal(stale.staleHolders(wt, [proc(1, 3, 'node /x/.bin/vitest --watch')], { staleMs: day }), null);
  assert.equal(stale.staleHolders(wt, [proc(1, 90, 'vim README.md')], { staleMs: day }), null);
  assert.equal(stale.staleHolders(wt, [proc(1, 90, 'npm run dev'), proc(2, 90, 'zsh')], { staleMs: day }), null);
  assert.equal(stale.staleHolders(wt, [proc(1, 90, 'npm run dev', ['/elsewhere'])], { staleMs: day }), null);
  assert.equal(stale.staleHolders(wt, null), null);
  assert.equal(stale.parseElapsed('2-03:04:05'), ((2 * 24 + 3) * 60 + 4) * 60 + 5);
  assert.equal(stale.parseElapsed('04:05'), 245);
});

test('stopStale never hits a pid that now runs something else', () => {
  const killed = [];
  const run = (cmd, args) => ({ status: 0, stdout: args[3] === '11' ? '1-06:00:00 npm run dev\n' : '00:05 vim\n' });
  const result = stale.stopStale(
    [{ pid: 11, hours: 30, command: 'npm run dev' }, { pid: 12, hours: 30, command: 'npm run dev' }],
    { run, kill: (pid, sig) => killed.push([pid, sig]), isAlive: () => false, waitMs: 0 },
  );
  assert.deepEqual(result, { stopped: [11], skipped: [12] });
  assert.deepEqual(killed, [[11, 'SIGTERM']]);
});

test('cleanup reports a finished copy held by an old dev server as stale_process', () => {
  const root = repo();
  const wt = `${root}-copy`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'done', wt, 'HEAD']);
    const procs = [{ pid: 4242, elapsed_s: 40 * 3600, args: 'node next dev', paths: [wt] }];
    const result = core.cleanupWorktrees({ root, base: 'master', activeCwds: [wt], processes: procs });
    const item = result.kept.find((k) => k.path === wt);
    assert.equal(item.reason, 'stale_process');
    assert.deepEqual(item.pids, [4242]);
    // Unsaved work keeps it plainly in use, never stale.
    fs.writeFileSync(path.join(wt, 'new.txt'), 'x\n');
    const dirty = core.cleanupWorktrees({ root, base: 'master', activeCwds: [wt], processes: procs });
    assert.equal(dirty.kept.find((k) => k.path === wt).reason, 'active_process');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('a leftover ref lock is named with its path and age', () => {
  const origin = repo();
  const root = tmp('atris-sweep-clone-');
  try {
    git(root, ['clone', '-q', origin, '.']);
    const lock = path.join(root, '.git', 'refs', 'remotes', 'origin', 'master.lock');
    fs.writeFileSync(lock, 'x\n');
    fs.writeFileSync(path.join(origin, 'more.txt'), 'x\n');
    git(origin, ['add', '.']);
    git(origin, ['commit', '-qm', 'more']);
    const why = core.refreshRemoteRef(root, 'origin/master');
    assert.match(why, /leftover git lock/);
    assert.ok(why.includes(lock));
  } finally {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('orphans: only cache-only folders are removable; git, real files and .env stay', () => {
  const copies = tmp('atris-orphans-');
  const make = (name, files) => {
    const dir = path.join(copies, 'proj', name);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  };
  try {
    const caches = make('caches', { '__pycache__/a.pyc': 'x', 'node_modules/p/index.js': 'x', '.DS_Store': 'x' });
    const gitted = make('gitted', { '.git': 'gitdir: /nowhere\n' });
    const real = make('real', { 'notes.md': 'mine\n' });
    const env = make('env', { '.env.local': 'K=1\n', '__pycache__/a.pyc': 'x' });
    const fresh = make('fresh', { '__pycache__/a.pyc': 'x' });
    const registered = make('registered', { 'x.txt': 'x' });
    fs.mkdirSync(path.join(copies, 'leftover', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(copies, 'leftover', 'sub', 'notes.md'), 'x\n');
    for (const dir of [caches, gitted, real, env]) {
      spawnSync('find', [dir, '-exec', 'touch', '-h', '-t', '202601010000', '{}', '+']);
    }
    const found = stale.findOrphans({
      copiesDir: copies,
      registeredByRepo: new Map([['proj', new Set([registered])]]),
      processes: [],
      measure: false,
    });
    const status = Object.fromEntries(found.map((o) => [path.basename(o.path), o.status]));
    assert.equal(status.leftover, 'abandoned');
    delete status.leftover;
    assert.deepEqual(status, { caches: 'removable', gitted: 'abandoned', real: 'abandoned', env: 'abandoned', fresh: 'abandoned' });
    const item = found.find((o) => o.status === 'removable');
    assert.equal(stale.removeOrphan(item, { processes: [{ pid: 1, args: 'x', paths: [`${caches}/x`] }] }), false);
    assert.equal(stale.removeOrphan(item, { processes: [] }), true);
    assert.equal(fs.existsSync(caches), false);
    for (const dir of [gitted, real, env, fresh, registered]) assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(copies, { recursive: true, force: true });
  }
});
