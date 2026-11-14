'use strict';

// Thin build copies: zero-copy installs on Linux, a start that skips a
// workspace sweep that just found nothing, build output cleared from copies
// that stay, and the doctor and prune that read and reclaim the workspace.
// Every repo here lives in a fresh temp folder with a local bare origin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const space = require('../lib/worktree-space');
const core = require('../lib/worktree-core');
const doctor = require('../lib/worktree-doctor');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function workspace(t) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-thin-')));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return ws;
}

const LOCK = JSON.stringify({ name: 'web', lockfileVersion: 3, packages: { '': { name: 'web' }, 'node_modules/left': { version: '1.2.0' } } });

function makeRepo(ws, name, files = {}) {
  const root = path.join(ws, name);
  fs.mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.next/\n.atris/\n__pycache__/\n.pytest_cache/\n.env\n');
  fs.writeFileSync(path.join(root, 'README.md'), `${name}\n`);
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  git(root, ['branch', '-M', 'master']);
  const remote = path.join(ws, `${name}-origin.git`);
  git(ws, ['init', '--bare', '-q', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'master']);
  git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  return root;
}

function backdateCopy(copy, hours) {
  const stamp = new Date(Date.now() - hours * 3600000);
  const gitDir = path.resolve(copy, git(copy, ['rev-parse', '--git-dir']));
  for (const mark of [copy, path.join(copy, '.next'), path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')]) {
    if (fs.existsSync(mark)) fs.utimesSync(mark, stamp, stamp);
  }
}

function addCopy(root, name, { commit = false, hoursOld = 30 } = {}) {
  const copy = path.join(path.dirname(root), '.agent-worktrees', path.basename(root), name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', `codex/${name}`, copy, 'origin/master']);
  if (commit) {
    fs.writeFileSync(path.join(copy, `${name}.txt`), 'work\n');
    git(copy, ['add', '.']);
    git(copy, ['commit', '-qm', `work ${name}`]);
  }
  backdateCopy(copy, hoursOld);
  return copy;
}

function writeBuildOutput(copy) {
  fs.mkdirSync(path.join(copy, '.next', 'server'), { recursive: true });
  fs.writeFileSync(path.join(copy, '.next', 'server', 'page.js'), 'x'.repeat(5000));
  fs.mkdirSync(path.join(copy, 'node_modules', 'left'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'node_modules', 'left', 'index.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(copy, 'node_modules', '.cache', 'babel'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'node_modules', '.cache', 'babel', 'a.json'), '{}');
  backdateCopy(copy, 30);
}

const copyClone = (src, dst) => {
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  return { ok: true, method: 'copy' };
};

test('on Linux without reflink, an install is hardlinked, and the opt-out refuses instead', (t) => {
  const dir = workspace(t);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  const dst = path.join(dir, 'dst');
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args.includes('--reflink=always')) return { status: 1, stderr: 'cp: failed to clone: Operation not supported' };
    return { status: 0, stdout: '' };
  };
  assert.deepEqual(space.cloneTree(src, dst, { platform: 'linux', run, env: {} }), { ok: true, method: 'hardlink' });
  assert.match(calls[0], /^cp -R --reflink=always /);
  assert.match(calls[1], /^cp -R -l -P /);

  calls.length = 0;
  const off = space.cloneTree(src, dst, { platform: 'linux', run, env: { ATRIS_WORKTREE_NO_HARDLINK: '1' } });
  assert.equal(off.ok, false);
  assert.equal(calls.length, 1, 'no hardlink attempt when turned off');
});

test('start installs on its own when the lockfile differs from every install it could clone', (t) => {
  const ws = workspace(t);
  const web = makeRepo(ws, 'web', { 'package-lock.json': LOCK });
  const other = addCopy(web, 'other', { hoursOld: 0 });
  fs.writeFileSync(path.join(other, 'package-lock.json'), LOCK.replace('1.2.0', '9.9.9'));
  fs.mkdirSync(path.join(other, 'node_modules', 'left'), { recursive: true });
  fs.writeFileSync(path.join(other, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/left': { version: '9.9.9' } } }));
  const created = core.createAgentWorktree({ root: web, agent: 'codex', task: 'lock moved', env: {}, deps: { clone: copyClone } });
  assert.equal(created.deps.status, 'skipped');
  assert.match(created.deps.reason, /no matching install/);
  assert.equal(fs.existsSync(path.join(created.path, 'node_modules')), false, 'nothing half-cloned is left for npm ci to trip on');
});

test('start skips a workspace sweep that just found nothing, until the disk fills or time passes', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app');
  const start = (task, options = {}) => core.createAgentWorktree({ root: app, agent: 'codex', task, deps: false, spaceGuard: true, env: {}, ...options });
  const first = start('first', { freeSpace: () => 20e9 });
  assert.equal(first.space.sweepSkipped, undefined, 'the first start sweeps');
  const stamp = JSON.parse(fs.readFileSync(path.join(ws, '.agent-worktrees', '.low-disk-sweep.json'), 'utf8'));
  assert.equal(stamp.removed, 0);

  const second = start('second', { freeSpace: () => 20e9 });
  assert.ok(second.space.sweepSkipped, 'nothing changed, so the second start skips the sweep');

  const filled = start('third', { freeSpace: () => 18e9 });
  assert.equal(filled.space.sweepSkipped, undefined, 'the disk lost 2 GB since, so it sweeps again');

  const always = start('fourth', { freeSpace: () => 18e9, env: { ATRIS_WORKTREE_SWEEP_COOLDOWN_MIN: '0' } });
  assert.equal(always.space.sweepSkipped, undefined);

  const late = core.recentFruitlessSweep({ workspace: ws, free: 18e9, env: {}, now: Date.now() + 31 * 60000 });
  assert.equal(late, null, 'after half an hour the sweep runs again');

  assert.throws(() => start('floor', { freeSpace: () => 18e9 - 1, env: { ATRIS_WORKTREE_MIN_FREE_GB: '19' } }), /needs at least 19\.0 GB/, 'a skipped sweep still refuses below the floor');
});

test('build output goes, and source, installs, env files and odd caches stay', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app', { 'package.json': '{}\n', 'pkg/mod.py': 'x = 1\n' });
  const copy = addCopy(app, 'built');
  writeBuildOutput(copy);
  fs.mkdirSync(path.join(copy, 'pkg', '__pycache__'));
  fs.writeFileSync(path.join(copy, 'pkg', '__pycache__', 'mod.cpython-312.pyc'), 'bytecode');
  fs.mkdirSync(path.join(copy, '__pycache__'));
  fs.writeFileSync(path.join(copy, '__pycache__', 'notes.txt'), 'not bytecode');
  fs.mkdirSync(path.join(copy, '.pytest_cache', 'v'), { recursive: true });
  fs.writeFileSync(path.join(copy, '.pytest_cache', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  fs.writeFileSync(path.join(copy, '.env'), 'SECRET=1\n');

  assert.deepEqual(core.clearBuildOutput(copy, { apply: true, active: null }).cleared, [], 'a failed process scan clears nothing');
  assert.deepEqual(core.clearBuildOutput(copy, { apply: true, active: [path.join(copy, '.next')] }).cleared, [], 'a dev server inside keeps it all');

  const dry = core.clearBuildOutput(copy, { apply: false, active: [] });
  assert.deepEqual(dry.cleared.map((item) => item.relative).sort(), ['.next', '.pytest_cache', 'node_modules/.cache', 'pkg/__pycache__']);
  assert.ok(fs.existsSync(path.join(copy, '.next')), 'a dry run removes nothing');

  const done = core.clearBuildOutput(copy, { apply: true, active: [] });
  assert.equal(done.cleared.length, 4);
  assert.ok(done.kib > 0);
  for (const gone of ['.next', '.pytest_cache', 'node_modules/.cache', 'pkg/__pycache__']) assert.equal(fs.existsSync(path.join(copy, gone)), false, gone);
  for (const kept of ['node_modules/left/index.js', '__pycache__/notes.txt', '.env', 'pkg/mod.py', 'README.md']) assert.ok(fs.existsSync(path.join(copy, kept)), kept);
  assert.equal(git(copy, ['status', '--porcelain']), '');
});

test('a shipped copy that stays loses its build output, unless kept on purpose', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app', { 'package.json': '{}\n' });
  const copy = addCopy(app, 'shipped');
  writeBuildOutput(copy);
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'not committed\n');
  const logs = [];
  const base = { root: copy, primary: app, branch: 'codex/shipped', log: (line) => logs.push(line), schedule: () => ({}), otherPaths: () => [], env: {} };

  core.finishShippedCopy({ ...base, keep: true });
  assert.ok(fs.existsSync(path.join(copy, '.next')), '--keep-copy keeps the build too');

  const result = core.finishShippedCopy(base);
  assert.equal(result.removed, false, 'uncommitted work keeps the copy');
  assert.equal(fs.existsSync(path.join(copy, '.next')), false);
  assert.ok(fs.existsSync(path.join(copy, 'notes.txt')));
  assert.ok(logs.some((line) => /cleared 2 build folders/.test(line)), logs.join('\n'));
});

test('prune removes only merged, clean, unused, idle copies and never touches their branches', (t) => {
  const ws = workspace(t);
  const app = makeRepo(ws, 'app', { 'package.json': '{}\n' });
  const merged = addCopy(app, 'merged');
  const dirty = addCopy(app, 'dirty');
  fs.writeFileSync(path.join(dirty, 'notes.txt'), 'not committed\n');
  writeBuildOutput(dirty);
  const unmerged = addCopy(app, 'unmerged', { commit: true });
  const busy = addCopy(app, 'busy');
  const recent = addCopy(app, 'recent', { hoursOld: 2 });

  const dry = doctor.pruneWorkspace({ workspace: ws, olderThanHours: 24, active: [busy] });
  const appDry = dry.repos.find((repo) => repo.name === 'app');
  assert.deepEqual(appDry.candidates.map((item) => item.path), [merged]);
  assert.deepEqual(appDry.build.map((item) => item.path), [dirty]);
  assert.ok(fs.existsSync(merged) && fs.existsSync(path.join(dirty, '.next')), 'a dry run changes nothing');

  const applied = doctor.pruneWorkspace({ workspace: ws, olderThanHours: 24, apply: true, active: [busy] });
  const appDone = applied.repos.find((repo) => repo.name === 'app');
  assert.deepEqual(appDone.removed.map((item) => item.path), [merged]);
  assert.equal(fs.existsSync(merged), false);
  for (const kept of [dirty, unmerged, busy, recent]) assert.ok(fs.existsSync(kept), kept);
  assert.ok(fs.existsSync(path.join(dirty, 'notes.txt')), 'uncommitted work stays');
  assert.equal(fs.existsSync(path.join(dirty, '.next')), false, 'an idle dirty copy loses only its build output');
  const reasons = Object.fromEntries(appDone.kept.map((item) => [path.basename(item.path), item.reason]));
  assert.deepEqual(reasons, { dirty: 'dirty', unmerged: 'unmerged', busy: 'active_process', recent: 'recent_activity' });
  assert.equal(git(app, ['branch', '--list', 'codex/merged']), 'codex/merged', 'the branch of a removed copy stays');
});

test('the doctor tells a shared clone from its own install and matches what prune would do', (t) => {
  const ws = workspace(t);
  const web = makeRepo(ws, 'web', { 'package.json': '{}\n', 'package-lock.json': LOCK });
  const primaryModules = path.join(web, 'node_modules');
  fs.mkdirSync(path.join(primaryModules, 'left'), { recursive: true });
  fs.writeFileSync(path.join(primaryModules, '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/left': { version: '1.2.0' } } }));
  const cloned = addCopy(web, 'cloned');
  fs.cpSync(primaryModules, path.join(cloned, 'node_modules'), { recursive: true, preserveTimestamps: true });
  const installed = addCopy(web, 'installed', { commit: true });
  fs.mkdirSync(path.join(installed, 'node_modules', 'left'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/left': { version: '1.2.0' } }, fresh: true }));
  backdateCopy(cloned, 30);
  backdateCopy(installed, 30);

  const report = doctor.doctorWorkspace({ workspace: ws, olderThanHours: 24, active: [] });
  const copies = Object.fromEntries(report.repos.find((repo) => repo.name === 'web').copies.map((copy) => [copy.name, copy]));
  assert.equal(copies.cloned.deps, 'clone');
  assert.equal(copies.installed.deps, 'own');
  assert.equal(copies.cloned.merged, true);
  assert.equal(copies.cloned.prune, true);
  assert.equal(copies.installed.merged, false);
  assert.equal(copies.installed.prune, false);
  assert.equal(copies.installed.reason, 'unmerged');
  assert.equal(report.totals.prune, 1);
  assert.equal(report.totals.own_installs, 1);
});

test('one process scan is resolved once, and a longer scan is resolved again', (t) => {
  const dir = workspace(t);
  const copy = path.join(dir, 'copy');
  fs.mkdirSync(copy);
  const scan = [path.join(dir, 'elsewhere')];
  assert.equal(core.worktreeHasActiveProcess(copy, scan), false);
  scan.push(path.join(copy, 'src'));
  assert.equal(core.worktreeHasActiveProcess(copy, scan), true);
});

test('the scan for ship leaves out this process and the shell that started it', () => {
  const lsof = 'p100\nfcwd\nn/work/copy\np200\nn/work/copy/.next/server\n';
  assert.deepEqual(core.parseLsofByPid(lsof, new Set(['100'])), ['/work/copy/.next/server']);
  const ps = '  100 /bin/zsh -c cd /work/copy\n  200 node /work/copy/node_modules/.bin/next dev\n';
  const args = core.parsePsByPid(ps, new Set(['100']));
  assert.ok(args.includes('/work/copy/node_modules/.bin/next'));
  assert.ok(!args.some((item) => item === '/work/copy' || item.startsWith('/work/copy ')), args.join('|'));
  const chain = core.processAncestors(5, (cmd, args) => ({ status: 0, stdout: { 5: '4\n', 4: '1\n', 1: '0\n' }[args[args.length - 1]] }));
  assert.deepEqual([...chain], ['5', '4', '1']);
});
