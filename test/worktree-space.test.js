'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const space = require('../lib/worktree-space');
const { planKeep } = require('../lib/campaign-keep');

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atris-space-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A copy stands in for a clone in these tests; the real clone has its own test.
function copyClone(src, dst) {
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  return { ok: true, method: 'copy' };
}

const LOCK = {
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', dependencies: { left: '^1.0.0' } },
    'node_modules/left': { version: '1.2.0' },
    'node_modules/left/node_modules/pad': { version: '0.1.0' },
    'node_modules/fsevents': { version: '2.3.3', optional: true },
  },
};

function installed(packages) {
  return { name: 'app', lockfileVersion: 3, packages };
}

function writeInstall(dir, packages = { 'node_modules/left': { version: '1.2.0' }, 'node_modules/left/node_modules/pad': { version: '0.1.0' } }) {
  const modules = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(modules, 'left', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(modules, 'left', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(modules, 'left', 'bin', 'left.js'), '#!/usr/bin/env node\n');
  fs.symlinkSync('../left/bin/left.js', path.join(modules, '.bin', 'left'));
  fs.writeFileSync(path.join(modules, '.package-lock.json'), JSON.stringify(installed(packages)));
  return modules;
}

function writeLock(dir, lock = LOCK) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
}

test('space limits default to reap below 25 GB and refuse below 10 GB, and 0 turns a limit off', () => {
  assert.deepEqual(space.spaceLimits({}), { reapBelow: 25e9, refuseBelow: 10e9 });
  assert.deepEqual(space.spaceLimits({ ATRIS_WORKTREE_REAP_BELOW_GB: '40', ATRIS_WORKTREE_MIN_FREE_GB: '0' }), { reapBelow: 40e9, refuseBelow: 0 });
  assert.deepEqual(space.spaceLimits({ ATRIS_WORKTREE_REAP_BELOW_GB: 'lots', ATRIS_WORKTREE_MIN_FREE_GB: '-3' }), { reapBelow: 25e9, refuseBelow: 10e9 });
  assert.equal(space.formatGb(12.94e9), '12.9 GB');
  assert.equal(space.formatGb(null), 'unknown');
});

test('free space reads the disk of the nearest folder that exists', (t) => {
  const dir = tempDir(t, 'free');
  const free = space.freeBytes(path.join(dir, 'not', 'made', 'yet'));
  assert.equal(typeof free, 'number');
  assert.ok(free > 0);
});

test('temp folders and agent copy folders are told apart', (t) => {
  const dir = tempDir(t, 'paths');
  assert.equal(space.isScratchPath(dir), true);
  assert.equal(space.isScratchPath(path.join(dir, '.agent-worktrees', 'app', 'copy')), true);
  assert.equal(space.isScratchPath(path.join(os.homedir(), 'arena', '.agent-worktrees', 'app', 'copy')), false);
  assert.equal(space.isAgentCopyPath(path.join(os.homedir(), 'arena', '.agent-worktrees', 'app', 'copy')), true);
  assert.equal(space.isAgentCopyPath(path.join(os.homedir(), 'arena', 'app')), false);
});

test('repos with build copies are the copy folders that sit next to a checkout', (t) => {
  const ws = tempDir(t, 'repos');
  for (const name of ['app', 'loose', '.deps']) fs.mkdirSync(path.join(ws, '.agent-worktrees', name), { recursive: true });
  fs.mkdirSync(path.join(ws, 'app', '.git'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.deps', '.git'), { recursive: true });
  const repos = space.agentCopyRepos(ws);
  assert.deepEqual(repos.map((repo) => repo.name), ['app']);
  assert.equal(repos[0].root, path.join(ws, 'app'));
  assert.deepEqual(space.agentCopyRepos(path.join(ws, 'missing')), []);
});

test('an install matches its lockfile only when every required package is there at the locked version', (t) => {
  const dir = tempDir(t, 'match');
  writeLock(dir);
  const modules = writeInstall(dir);
  const lock = path.join(dir, 'package-lock.json');
  assert.equal(space.installedMatchesLock(lock, modules), true, 'a missing optional package still matches');

  fs.writeFileSync(path.join(modules, '.package-lock.json'), JSON.stringify(installed({ 'node_modules/left': { version: '1.3.0' }, 'node_modules/left/node_modules/pad': { version: '0.1.0' } })));
  assert.equal(space.installedMatchesLock(lock, modules), false, 'another version does not match');

  fs.writeFileSync(path.join(modules, '.package-lock.json'), JSON.stringify(installed({ 'node_modules/left': { version: '1.2.0' } })));
  assert.equal(space.installedMatchesLock(lock, modules), false, 'a missing required package does not match');

  fs.writeFileSync(path.join(modules, '.package-lock.json'), JSON.stringify(installed({ 'node_modules/left': { version: '1.2.0' }, 'node_modules/left/node_modules/pad': { version: '0.1.0' }, 'node_modules/extra': { version: '1.0.0' } })));
  assert.equal(space.installedMatchesLock(lock, modules), false, 'an extra package does not match');

  fs.rmSync(path.join(modules, '.package-lock.json'));
  assert.equal(space.installedMatchesLock(lock, modules), false, 'no install record does not match');

  writeLock(dir, { ...LOCK, packages: { ...LOCK.packages, 'packages/ui': { version: '1.0.0' }, 'node_modules/ui': { resolved: 'packages/ui', link: true } } });
  writeInstall(path.join(dir, 'other'));
  assert.equal(space.installedMatchesLock(lock, path.join(dir, 'other', 'node_modules')), false, 'workspaces never match');
});

test('a new copy clones a matching install from another copy and later copies clone the shared store', (t) => {
  const ws = tempDir(t, 'seed');
  const first = path.join(ws, '.agent-worktrees', 'app', 'first');
  const second = path.join(ws, '.agent-worktrees', 'app', 'second');
  const third = path.join(ws, '.agent-worktrees', 'app', 'third');
  writeLock(first);
  writeInstall(first);
  writeLock(second);
  writeLock(third);

  const seeded = space.seedNodeModules({ target: second, workspace: ws, repoName: 'app', sources: [path.join(ws, 'app'), first, second], clone: copyClone });
  assert.equal(seeded.status, 'cloned', seeded.reason);
  const hash = space.lockHash(path.join(second, 'package-lock.json'));
  const store = path.join(space.depsCacheEntry(ws, 'app', hash), 'node_modules');
  assert.equal(seeded.source, store);
  assert.equal(space.installedMatchesLock(path.join(second, 'package-lock.json'), path.join(second, 'node_modules')), true);
  assert.equal(fs.readlinkSync(path.join(second, 'node_modules', '.bin', 'left')), '../left/bin/left.js');

  // The first copy is gone; the store still serves the next one.
  fs.rmSync(first, { recursive: true, force: true });
  const fromStore = space.seedNodeModules({ target: third, workspace: ws, repoName: 'app', sources: [], clone: copyClone });
  assert.equal(fromStore.status, 'cloned', fromStore.reason);
  assert.equal(fs.existsSync(path.join(third, 'node_modules', 'left', 'index.js')), true);

  const again = space.seedNodeModules({ target: third, workspace: ws, repoName: 'app', sources: [], clone: copyClone });
  assert.equal(again.reason, 'node_modules already present');
});

test('a copy is left to install on its own when nothing matches or git would see the folder', (t) => {
  const ws = tempDir(t, 'seed-miss');
  const source = path.join(ws, '.agent-worktrees', 'app', 'source');
  const target = path.join(ws, '.agent-worktrees', 'app', 'target');
  writeLock(source);
  writeInstall(source);
  fs.mkdirSync(target, { recursive: true });
  assert.equal(space.seedNodeModules({ target, workspace: ws, repoName: 'app', sources: [source], clone: copyClone }).reason, 'no package-lock.json');

  writeLock(target, { ...LOCK, packages: { ...LOCK.packages, 'node_modules/left': { version: '9.9.9' } } });
  const differs = space.seedNodeModules({ target, workspace: ws, repoName: 'app', sources: [source], clone: copyClone });
  assert.equal(differs.status, 'skipped');
  assert.match(differs.reason, /no matching install/);
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);

  writeLock(target);
  const tracked = space.seedNodeModules({ target, workspace: ws, repoName: 'app', sources: [source], clone: copyClone, isIgnored: () => false });
  assert.match(tracked.reason, /not ignored/);

  const failing = space.seedNodeModules({ target, workspace: ws, repoName: 'app', sources: [source], clone: () => ({ ok: false, error: 'no clones here' }) });
  assert.equal(failing.status, 'skipped');
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
});

test('seeding preserves a mismatched shared install and its local files', (t) => {
  const ws = tempDir(t, 'changed-store');
  const source = path.join(ws, '.agent-worktrees', 'app', 'source');
  const target = path.join(ws, '.agent-worktrees', 'app', 'target');
  writeLock(source);
  writeInstall(source);
  writeLock(target);
  const hash = space.lockHash(path.join(target, 'package-lock.json'));
  const entry = space.depsCacheEntry(ws, 'app', hash);
  fs.mkdirSync(path.join(entry, 'node_modules'), { recursive: true });
  const personal = path.join(entry, 'local-notes.txt');
  fs.writeFileSync(personal, 'keep this');
  const result = space.seedNodeModules({ target, workspace: ws, repoName: 'app', sources: [source], clone: copyClone });
  assert.equal(result.status, 'skipped');
  assert.equal(fs.readFileSync(personal, 'utf8'), 'keep this');
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
});

test('seeding leaves older shared installs and partial entries alone', (t) => {
  const ws = tempDir(t, 'keep-stores');
  const source = path.join(ws, '.agent-worktrees', 'app', 'source');
  const target = path.join(ws, '.agent-worktrees', 'app', 'target');
  writeLock(source);
  writeInstall(source);
  writeLock(target);
  const dir = path.join(ws, '.agent-worktrees', '.deps', 'app');
  for (const name of ['old1', 'old2', 'old3', 'old4', '.partial-old']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'local-notes.txt'), name);
    fs.utimesSync(path.join(dir, name), new Date(0), new Date(0));
  }
  const result = space.seedNodeModules({ target, workspace: ws, repoName: 'app', sources: [source], clone: copyClone });
  assert.equal(result.status, 'cloned', result.reason);
  for (const name of ['old1', 'old2', 'old3', 'old4', '.partial-old']) {
    assert.equal(fs.readFileSync(path.join(dir, name, 'local-notes.txt'), 'utf8'), name);
  }
});

test('a real clone copies the tree with its links, or reports why it cannot without leaving a copy', (t) => {
  const dir = tempDir(t, 'clone');
  const src = writeInstall(path.join(dir, 'src'));
  const dst = path.join(dir, 'dst', 'node_modules');
  fs.mkdirSync(path.dirname(dst));
  const result = space.cloneTree(src, dst);
  // The macOS temp folder is on APFS, so the clone must work there.
  if (process.platform === 'darwin') assert.deepEqual(result, { ok: true, method: 'clonefile' });
  if (!result.ok) {
    assert.equal(typeof result.error, 'string');
    assert.equal(fs.existsSync(dst), false);
    return;
  }
  assert.equal(fs.readFileSync(path.join(dst, 'left', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.readlinkSync(path.join(dst, '.bin', 'left')), '../left/bin/left.js');
  assert.deepEqual(fs.readdirSync(path.dirname(dst)), ['node_modules'], 'nothing else is left beside the clone');
});

test('a clone that fails never falls back to a full copy', (t) => {
  const dir = tempDir(t, 'clone-fail');
  const src = writeInstall(path.join(dir, 'src'));
  const dst = path.join(dir, 'dst', 'node_modules');
  fs.mkdirSync(path.dirname(dst));
  const calls = [];
  const run = (cmd, args) => {
    calls.push(cmd);
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'half'), 'x');
    return { status: 0, stdout: '-1\n' };
  };
  const mac = space.cloneTree(src, dst, { platform: 'darwin', run });
  assert.equal(mac.ok, false);
  assert.deepEqual(calls, ['osascript'], 'no second, copying attempt');
  assert.equal(fs.existsSync(dst), false, 'a half-made clone is removed');
  const linux = space.cloneTree(src, dst, { platform: 'linux', run: (cmd, args) => { calls.push([cmd, ...args].join(' ')); fs.mkdirSync(dst, { recursive: true }); return { status: 1, stderr: 'cp: failed to clone: Operation not supported' }; } });
  assert.equal(linux.ok, false);
  assert.match(calls[1], /^cp -R --reflink=always /);
  assert.equal(fs.existsSync(dst), false);
  assert.equal(space.cloneTree(src, dst, { platform: 'win32', run }).ok, false);
});

test('a cron timer longer than an hour runs on the hour mark', () => {
  const plan = planKeep({ root: '/w', home: '/h', platform: 'linux', atrisBin: '/a.js', job: { name: 'worktree-sweep', args: ['worktree', 'sweep'], every_seconds: 3 * 3600 } });
  assert.match(plan.crontab_line, /^0 \*\/3 \* \* \* /);
  const short = planKeep({ root: '/w', home: '/h', platform: 'linux', atrisBin: '/a.js', job: { name: 'x', args: [], every_seconds: 600 } });
  assert.match(short.crontab_line, /^\*\/10 \* \* \* \* /);
});
