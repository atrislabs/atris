'use strict';

// Real git in temp folders: a fake main copy at <ws>/app, build copies under
// <ws>/.agent-worktrees/app/, the put-away store and HOME in temp folders.
// Nothing here touches the real workspace, home folder, or timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { sleepSync } = require('../lib/sleep-sync');

// HOME points at a temp folder for this whole file, before anything reads it.
const { home: TEST_HOME } = require('./helpers/temp-home');

const putaway = require('../lib/worktree-putaway');
const core = require('../lib/worktree-core');

const { createAgentWorktree, defaultSweepWorkspace, sweepSchedulePlan, finishShippedCopy } = core;
const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const HOUR_MS = 60 * 60 * 1000;
const NO_PROGRAMS = () => [];

function git(cwd, args, options = {}) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr || run.stdout}`);
  return String(run.stdout || '').trim();
}

function raw(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout;
}

function setup(t, { files = {}, ignore = '', origin = false } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-put-away-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-put-away-store-')));
  t.after(() => {
    for (const dir of [ws, home]) {
      spawnSync('chmod', ['-R', 'u+rwx', dir]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  const app = makeRepo(ws, 'app', { files, ignore, origin });
  return { ws, home, app };
}

function makeRepo(ws, name, { files = {}, ignore = '', origin = false } = {}) {
  const app = path.join(ws, name);
  fs.mkdirSync(app);
  git(app, ['init', '-q']);
  git(app, ['config', 'user.name', 'Test User']);
  git(app, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(app, '.gitignore'), `node_modules/\n.env.local\n.next/\n.atris/\n${ignore}`);
  fs.writeFileSync(path.join(app, 'app.js'), 'module.exports = 1;\n');
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    fs.writeFileSync(path.join(app, file), body);
  }
  git(app, ['add', '.']);
  git(app, ['commit', '-qm', 'initial']);
  git(app, ['branch', '-M', 'master']);
  if (origin) {
    const remote = path.join(ws, `${name}-origin.git`);
    git(ws, ['init', '--bare', '-q', remote]);
    git(app, ['remote', 'add', 'origin', remote]);
    git(app, ['push', '-qu', 'origin', 'master']);
    git(app, ['remote', 'set-head', 'origin', 'master']);
  }
  return app;
}

function addCopy({ ws, app }, name, { commit = false, at } = {}) {
  const copy = at || path.join(ws, '.agent-worktrees', path.basename(app), name);
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

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

function sweepApp(ctx, options = {}) {
  const report = putaway.sweep({ workspace: ctx.ws, home: ctx.home, scan: NO_PROGRAMS, current: ctx.ws, apply: true, ...options });
  return report.repos.find((repo) => repo.name === 'app') || { removed: [], kept: [] };
}

function restore(ctx, name) {
  const back = putaway.restoreCopy({ name, home: ctx.home });
  assert.equal(back.ok, true, back.error);
  return back;
}

function putAwayRefs(app) {
  return git(app, ['for-each-ref', '--format=%(refname)', 'refs/atris/put-away/']).split('\n').filter(Boolean);
}

function cliEnv(ctx, extra = {}) {
  return { ...scrubAgentEnv(), HOME: TEST_HOME, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_PUT_AWAY_DIR: ctx.home, ...extra };
}

function waitFor(file, ms = 10000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    sleepSync(50);
  }
}

// ---------------------------------------------------------------------------
// One. The ref always exists, so no commit can be collected away.

test('one: a detached commit is pinned by the put-away ref and survives gc', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'detached');
  git(copy, ['checkout', '-q', '--detach']);
  write(copy, 'only-here.txt', 'a commit on no branch\n');
  git(copy, ['add', 'only-here.txt']);
  git(copy, ['commit', '-qm', 'detached work']);
  const head = git(copy, ['rev-parse', 'HEAD']);
  age(copy, 30);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(repo.removed[0].record.ref, 'refs/atris/put-away/detached');
  git(ctx.app, ['reflog', 'expire', '--all', '--expire=now']);
  git(ctx.app, ['gc', '-q', '--prune=now']);
  restore(ctx, 'detached');
  assert.equal(git(copy, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.readFileSync(path.join(copy, 'only-here.txt'), 'utf8'), 'a commit on no branch\n');
});

test('one: a commit only the copy\'s HEAD history reaches survives gc and is in the restored history', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'reset-away', { commit: true });
  write(copy, 'second.txt', 'reset away later\n');
  git(copy, ['add', 'second.txt']);
  git(copy, ['commit', '-qm', 'second']);
  const lost = git(copy, ['rev-parse', 'HEAD']);
  git(copy, ['reset', '-q', '--hard', 'HEAD~1']);
  age(copy, 30);
  sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  git(ctx.app, ['reflog', 'expire', '--all', '--expire=now']);
  git(ctx.app, ['gc', '-q', '--prune=now']);
  assert.equal(spawnSync('git', ['cat-file', '-e', `${lost}^{commit}`], { cwd: ctx.app }).status, 0, 'the commit survived gc');
  restore(ctx, 'reset-away');
  assert.match(git(copy, ['reflog', 'show', '--format=%H', 'HEAD']), new RegExp(lost));
});

// ---------------------------------------------------------------------------
// Two. Sweeps at the same time never lose work.

test('two: a second sweep on the same repo exits cleanly with one plain line', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'held', { commit: true });
  age(copy, 30);
  const release = putaway.lockRepo(ctx.app);
  assert.ok(release, 'took the lock');
  try {
    const repo = sweepApp(ctx);
    assert.equal(repo.skipped, 'another sweep is already running on this repo');
    const run = spawnSync(process.execPath, [CLI, 'worktree', 'sweep', '--apply', '--workspace', ctx.ws], { cwd: ctx.ws, encoding: 'utf8', timeout: 60000, env: cliEnv(ctx) });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^app: skipped \(another sweep is already running on this repo\)$/m);
    assert.equal(fs.existsSync(copy), true);
  } finally {
    release();
  }
});

test('two: three sweeps at once for twenty rounds lose no file and leave no orphan ref', async (t) => {
  const ctx = setup(t);
  const expected = new Map();
  for (let round = 0; round < 20; round += 1) {
    for (let n = 0; n < 2; n += 1) {
      const name = `r${round}-c${n}`;
      const copy = addCopy(ctx, name, { commit: true });
      write(copy, 'app.js', `module.exports = "${name}";\n`);
      write(copy, `notes-${name}.md`, `notes for ${name}\n`);
      write(copy, '.env.local', `TOKEN=${name}\n`);
      age(copy, 30);
      expected.set(name, copy);
    }
    const runs = [0, 1, 2].map(() => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'worktree', 'sweep', '--apply', '--job', '--workspace', ctx.ws], { cwd: ctx.ws, env: cliEnv(ctx), stdio: 'ignore' });
      child.on('exit', resolve);
    }));
    await Promise.all(runs);
  }
  const records = putaway.readRecords({ home: ctx.home });
  const recordNames = new Set(records.map((record) => record.name));
  for (const ref of putAwayRefs(ctx.app)) assert.ok(recordNames.has(ref.replace('refs/atris/put-away/', '')), `orphan ref ${ref}`);
  for (const [name, copy] of expected) {
    if (!fs.existsSync(copy)) {
      assert.ok(recordNames.has(name), `${name} was removed with no record`);
      restore(ctx, name);
    }
    assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), `module.exports = "${name}";\n`, name);
    assert.equal(fs.readFileSync(path.join(copy, `notes-${name}.md`), 'utf8'), `notes for ${name}\n`, name);
    assert.equal(fs.readFileSync(path.join(copy, '.env.local'), 'utf8'), `TOKEN=${name}\n`, name);
  }
});

// ---------------------------------------------------------------------------
// Three. A record holding unsaved work is never pruned.

test('three: prune keeps records with uncommitted or untracked work, drops only merged commits, and the sweep says what records hold', (t) => {
  const ctx = setup(t);
  const tracked = addCopy(ctx, 'tracked-work', { commit: true });
  write(tracked, 'app.js', 'module.exports = "not committed";\n');
  const ignoredOnly = addCopy(ctx, 'ignored-only', { commit: true });
  write(ignoredOnly, '.env.local', 'TOKEN=only here\n');
  const commitsOnly = addCopy(ctx, 'commits-only', { commit: true });
  for (const copy of [tracked, ignoredOnly, commitsOnly]) age(copy, 30);
  sweepApp(ctx);
  git(ctx.app, ['merge', '-q', '--no-ff', '-m', 'land tracked', 'codex/tracked-work']);
  git(ctx.app, ['merge', '-q', '--no-ff', '-m', 'land commits', 'codex/commits-only']);

  const later = Date.now() + 31 * 24 * HOUR_MS;
  const result = putaway.prunePutAway({ home: ctx.home, now: later });
  assert.deepEqual(result.pruned.map((record) => record.name), ['commits-only']);
  assert.deepEqual(putaway.readRecords({ home: ctx.home }).map((record) => record.name).sort(), ['ignored-only', 'tracked-work']);
  restore(ctx, 'tracked-work');
  assert.equal(fs.readFileSync(path.join(tracked, 'app.js'), 'utf8'), 'module.exports = "not committed";\n');

  const run = spawnSync(process.execPath, [CLI, 'worktree', 'sweep', '--workspace', ctx.ws], { cwd: ctx.ws, encoding: 'utf8', timeout: 60000, env: cliEnv(ctx) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^put-away: 1 put-away record holds \d+ (KB|MB); /m);
  const dropped = putaway.dropRecord({ name: 'ignored-only', home: ctx.home });
  assert.equal(dropped.ok, true, 'a person can drop a record by name');
});

// ---------------------------------------------------------------------------
// Four. Only copies atris made.

test('four: a hand-made copy is never swept, by the sweep, the ceiling or a low disk; a marked one is', (t) => {
  const ctx = setup(t);
  fs.mkdirSync(path.join(ctx.ws, '.agent-worktrees', 'app'), { recursive: true });
  const handMade = path.join(ctx.ws, 'my-feature');
  git(ctx.app, ['worktree', 'add', '-q', '-b', 'feature', handMade, 'master']);
  write(handMade, 'draft.md', 'mine\n');
  age(handMade, 30);
  const marked = path.join(ctx.ws, 'elsewhere', 'marked');
  fs.mkdirSync(path.dirname(marked), { recursive: true });
  git(ctx.app, ['worktree', 'add', '-q', '-b', 'codex/marked', marked, 'master']);
  write(marked, '.atris/agent-worktree.json', JSON.stringify({ owner: 'codex', branch: 'codex/marked', created_at: new Date().toISOString() }));
  age(marked, 30);

  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-put-away-empty-ws-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  putaway.sweep({ workspace: other, repos: [ctx.app], home: ctx.home, scan: NO_PROGRAMS, current: other, apply: true });
  assert.equal(fs.existsSync(handMade), true, 'the normal sweep leaves the hand-made copy');
  assert.equal(fs.existsSync(marked), false, 'a copy with the start marker is swept wherever it lives');

  createAgentWorktree({ root: ctx.app, agent: 'codex', task: 'ceiling', deps: false, spaceGuard: false, putAwayHome: ctx.home, activeCwds: [], env: { ATRIS_WORKTREE_MAX_PER_REPO: '1' } });
  assert.equal(fs.existsSync(handMade), true, 'the ceiling leaves it');
  createAgentWorktree({ root: ctx.app, agent: 'codex', task: 'low disk', deps: false, spaceGuard: true, freeSpace: () => 20e9, putAwayHome: ctx.home, activeCwds: [], env: {} });
  assert.equal(fs.existsSync(handMade), true, 'a low disk leaves it');
  assert.equal(fs.readFileSync(path.join(handMade, 'draft.md'), 'utf8'), 'mine\n');
});

// ---------------------------------------------------------------------------
// Five. Nothing is dropped by name but ignored node_modules/ and .next/.

test('five: every untracked or ignored file comes back, whatever its name, and only node_modules and .next are dropped', (t) => {
  const ctx = setup(t, { files: { '.env.local': 'TOKEN=main\n' }, ignore: 'build/\ndist/\ncoverage/\n.cache/\n*.link\n' });
  // .env.local is ignored, so the main copy's version is local to it too.
  write(ctx.app, '.env.local', 'TOKEN=same\n');
  const copy = addCopy(ctx, 'names');
  const files = {
    'build/notes.txt': 'hand-made in build\n',
    'build/empty-inside/.keep-not': 'x',
    'dist/hand.txt': 'hand-made in dist\n',
    'coverage/mine.txt': 'mine\n',
    '.cache/keep.db': 'local rows\n',
    'src/build/x.txt': 'nested build\n',
    'venv/lib.py': 'print(1)\n',
    '.venv/bin/tool': '#!/bin/sh\n',
    'atris/runs/plan.json': '{"plan":"mine"}\n',
    '.atris/state/notes.md': 'my own notes\n',
    'next-env.d.ts': '// hand edit\n',
    'mod.pyc': 'bytes',
    '.env.local': 'TOKEN=same\n',
  };
  for (const [rel, body] of Object.entries(files)) write(copy, rel, body);
  fs.rmSync(path.join(copy, 'build/empty-inside/.keep-not'));
  fs.symlinkSync('app.js', path.join(copy, 'pointer.link'));
  fs.mkdirSync(path.join(copy, 'empty', 'deeper'), { recursive: true });
  write(copy, 'node_modules/pkg/index.js', 'module.exports = 0;\n');
  write(copy, '.next/cache/0.pack', 'pack');
  age(copy, 30);

  sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  // The main copy changes its own ignored file later; the copy's must not follow it.
  write(ctx.app, '.env.local', 'TOKEN=changed in main later\n');
  restore(ctx, 'names');
  for (const [rel, body] of Object.entries(files)) {
    if (rel.endsWith('.keep-not')) continue;
    assert.equal(fs.readFileSync(path.join(copy, rel), 'utf8'), body, rel);
  }
  assert.equal(fs.readlinkSync(path.join(copy, 'pointer.link')), 'app.js', 'an ignored symlink comes back as a link');
  assert.equal(fs.statSync(path.join(copy, 'empty', 'deeper')).isDirectory(), true, 'empty folders come back');
  assert.equal(fs.statSync(path.join(copy, 'build', 'empty-inside')).isDirectory(), true, 'an empty ignored folder comes back');
  assert.equal(fs.existsSync(path.join(copy, 'node_modules')), false, 'node_modules is dropped');
  assert.equal(fs.existsSync(path.join(copy, '.next')), false, '.next is dropped');
});

test('five: only the exact files atris writes are dropped, and a file that only shares the name is saved', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'plumbing');
  write(copy, '.atris/agent-worktree.json', JSON.stringify({ owner: 'codex', branch: 'codex/plumbing', created_at: 'now' }));
  write(copy, '.atris/state/usage.jsonl', '{"cmd":"task"}\n{"cmd":"log"}\n');
  write(copy, '.atris/state/tasks.projection.json', 'my notes, not json\n');
  write(copy, 'node_modules/left-pad/index.js', 'module.exports = 0;\n');
  age(copy, 30);
  const repo = sweepApp(ctx);
  const record = repo.removed[0].record;
  const listed = spawnSync('tar', ['-tf', record.tar], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(listed, ['.atris/state/tasks.projection.json'], 'the look-alike is saved, the real tool files are not');
});

test('five: more than the 2 GB cap keeps the copy and says why', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'huge');
  const big = path.join(copy, 'video.mov');
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, 2 * 1024 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  age(copy, 30);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(big), true);
  assert.equal(repo.kept[0].reason, 'put_away_failed');
  assert.match(repo.kept[0].text, /more than the 2 GB a put-away holds/);
});

// ---------------------------------------------------------------------------
// Six. No untracked file enters a ref.

test('six: secrets and other untracked files never enter the put-away ref or any git object', (t) => {
  const ctx = setup(t, { origin: true });
  const copy = addCopy(ctx, 'secrets');
  const secrets = {
    '.npmrc': '//registry.npmjs.org/:_authToken=npm_secret_token\n',
    'secrets.json': '{"key":"secret-json-value"}\n',
    '.aws/credentials': '[default]\naws_secret_access_key=AKIA_SECRET\n',
    'id_ed25519': '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key-body\n',
  };
  for (const [rel, body] of Object.entries(secrets)) write(copy, rel, body);
  write(copy, 'staged-new.txt', 'staged but never committed\n');
  git(copy, ['add', 'staged-new.txt']);
  write(copy, 'app.js', 'module.exports = "tracked change";\n');
  const headNames = new Set(git(copy, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n'));
  // The staged file's blob exists already (git add wrote it); the rest must never.
  const blobOf = (body) => spawnSync('git', ['hash-object', '--stdin'], { cwd: ctx.app, input: body, encoding: 'utf8' }).stdout.trim();
  age(copy, 30);
  const repo = sweepApp(ctx);
  const record = repo.removed[0].record;
  const inRef = git(ctx.app, ['ls-tree', '-r', '--name-only', record.ref]).split('\n').filter(Boolean);
  for (const name of inRef) assert.ok(headNames.has(name), `${name} was not tracked but is in the ref`);
  for (const [rel, body] of Object.entries(secrets)) {
    assert.ok(!inRef.includes(rel), rel);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', blobOf(body)], { cwd: ctx.app }).status, 0, `${rel} reached the object store`);
  }
  git(ctx.app, ['push', '-q', '--mirror', 'origin']);
  const remote = path.join(ctx.ws, 'app-origin.git');
  const pushed = git(ctx.app, ['--git-dir', remote, 'ls-tree', '-r', '--name-only', record.ref]).split('\n');
  for (const rel of Object.keys(secrets)) assert.ok(!pushed.includes(rel));
  restore(ctx, 'secrets');
  for (const [rel, body] of Object.entries(secrets)) assert.equal(fs.readFileSync(path.join(copy, rel), 'utf8'), body);
});

// ---------------------------------------------------------------------------
// Seven. Start never takes a copy someone used today, or another repo's.

test('seven: the ceiling keeps a copy last written 70 minutes ago, and start says space is tight', (t) => {
  const ctx = setup(t);
  const live = addCopy(ctx, 'live-session', { commit: true });
  age(live, 70 / 60);
  const created = createAgentWorktree({ root: ctx.app, agent: 'codex', task: 'tight', deps: false, spaceGuard: false, putAwayHome: ctx.home, activeCwds: [], env: { ATRIS_WORKTREE_MAX_PER_REPO: '1' } });
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(created.path), true, 'start still starts');
  assert.match(putaway.ceilingLine(created.ceiling), /^ceiling: space is tight, .*none of the rest has sat unused for a day .*starting anyway$/);
});

test('seven: a low disk only puts away this repo\'s copies idle for a day', (t) => {
  const ctx = setup(t);
  const other = makeRepo(ctx.ws, 'other');
  const otherIdle = addCopy({ ws: ctx.ws, app: other }, 'other-idle', { commit: true });
  const recent = addCopy(ctx, 'recent', { commit: true });
  const stale = addCopy(ctx, 'stale', { commit: true });
  age(otherIdle, 30);
  age(recent, 70 / 60);
  age(stale, 30);
  const created = createAgentWorktree({ root: ctx.app, agent: 'codex', task: 'low disk', deps: false, spaceGuard: true, freeSpace: () => 20e9, putAwayHome: ctx.home, activeCwds: [], env: {} });
  assert.equal(fs.existsSync(otherIdle), true, 'another repo is never touched');
  assert.equal(fs.existsSync(recent), true, 'a copy used 70 minutes ago stays');
  assert.equal(fs.existsSync(stale), false, 'an idle copy of this repo goes');
  assert.equal(created.space.removed.length, 1);
});

// ---------------------------------------------------------------------------
// Eight. In use, checked properly and again right before the delete.

test('eight: a program holding a file open inside the copy keeps it, even standing elsewhere', async (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'open-file', { commit: true });
  age(copy, 30);
  const ready = path.join(ctx.ws, 'ready');
  const child = spawn(process.execPath, ['-e', `const fs=require('fs');fs.openSync(${JSON.stringify(path.join(copy, 'app.js'))},'r');fs.writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000)`], { cwd: os.tmpdir(), stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  waitFor(ready);
  if (!Array.isArray(putaway.listOpenPaths())) { t.skip('this machine cannot list open files'); return; }
  const report = putaway.sweep({ workspace: ctx.ws, home: ctx.home, current: ctx.ws, apply: true });
  const repo = report.repos.find((item) => item.name === 'app');
  assert.equal(fs.existsSync(copy), true);
  assert.equal(repo.kept[0].reason, 'process');
});

test('eight: the in-use check runs again right before the delete', async (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'picked-up', { commit: true });
  write(copy, 'wip.md', 'work\n');
  age(copy, 30);
  const ready = path.join(ctx.ws, 'ready');
  let child;
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const hooks = {
    afterPutAway: () => {
      child = spawn(process.execPath, ['-e', `const fs=require('fs');fs.openSync(${JSON.stringify(path.join(copy, 'wip.md'))},'r');fs.writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000)`], { cwd: os.tmpdir(), stdio: 'ignore' });
      waitFor(ready);
    },
  };
  if (!Array.isArray(putaway.listOpenPaths())) { t.skip('this machine cannot list open files'); return; }
  const report = putaway.sweep({ workspace: ctx.ws, home: ctx.home, current: ctx.ws, apply: true, hooks });
  const repo = report.repos.find((item) => item.name === 'app');
  assert.equal(fs.existsSync(path.join(copy, 'wip.md')), true);
  assert.equal(repo.kept[0].reason, 'process');
  assert.deepEqual(putaway.readRecords({ home: ctx.home }), [], 'the put-away it made is undone');
  assert.deepEqual(putAwayRefs(ctx.app), []);
});

test('eight: ATRIS_WORKTREE_IDLE_HOURS=0 does not switch the time rule off', (t) => {
  assert.equal(putaway.idleMsFromEnv({ ATRIS_WORKTREE_IDLE_HOURS: '0' }), HOUR_MS);
  assert.equal(putaway.idleMsFromEnv({}), 24 * HOUR_MS);
  assert.equal(putaway.idleMsFromEnv({ ATRIS_WORKTREE_IDLE_HOURS: '6' }), 6 * HOUR_MS);
  const ctx = setup(t);
  const copy = addCopy(ctx, 'half-hour', { commit: true });
  age(copy, 0.5);
  const repo = sweepApp(ctx, { env: { ATRIS_WORKTREE_IDLE_HOURS: '0' } });
  assert.equal(fs.existsSync(copy), true);
  assert.equal(repo.kept[0].reason, 'recent');
  const cli = spawnSync(process.execPath, [CLI, 'worktree', 'sweep', '--apply', '--idle-hours', '0', '--workspace', ctx.ws], { cwd: ctx.ws, encoding: 'utf8', timeout: 60000, env: cliEnv(ctx) });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(fs.existsSync(copy), true, '--idle-hours 0 is clamped to an hour too');
  // Only the test-only switch goes lower.
  sweepApp(ctx, { idleMs: 0, allowShortIdle: true });
  assert.equal(fs.existsSync(copy), false);
});

// ---------------------------------------------------------------------------
// Nine. Ship checks for changes while saving, like the sweep.

test('nine: ship keeps the copy when a file changes while its leftovers are being put away', (t) => {
  const ctx = setup(t, { origin: true });
  const copy = addCopy(ctx, 'shipping', { commit: true });
  git(copy, ['push', '-q', 'origin', 'codex/shipping']);
  write(copy, 'scratch.md', 'leftover\n');
  const hooks = { afterPutAway: () => write(copy, 'late.md', 'written while saving\n') };
  const result = finishShippedCopy({ root: copy, primary: ctx.app, branch: 'codex/shipping', putAwayHome: ctx.home, hooks, log: () => {}, schedule: () => ({}), otherPaths: NO_PROGRAMS });
  assert.equal(result.removed, false);
  assert.equal(fs.readFileSync(path.join(copy, 'late.md'), 'utf8'), 'written while saving\n');
  assert.equal(fs.readFileSync(path.join(copy, 'scratch.md'), 'utf8'), 'leftover\n');
  assert.deepEqual(putaway.readRecords({ home: ctx.home }), []);
  // Without the late write it goes, leftovers put away.
  const again = finishShippedCopy({ root: copy, primary: ctx.app, branch: 'codex/shipping', putAwayHome: ctx.home, log: () => {}, schedule: () => ({}), otherPaths: NO_PROGRAMS });
  assert.equal(again.removed, true, again.reason);
  restore(ctx, 'shipping');
  assert.equal(fs.readFileSync(path.join(copy, 'late.md'), 'utf8'), 'written while saving\n');
});

// ---------------------------------------------------------------------------
// Ten. Crash leftovers.

test('ten: a half-written put-away and a ref with no record are cleaned on the next run', (t) => {
  const ctx = setup(t);
  const first = addCopy(ctx, 'first', { commit: true });
  age(first, 30);
  sweepApp(ctx);
  const done = putaway.readRecords({ home: ctx.home })[0];
  const base = path.dirname(done.dir);
  const ghost = path.join(base, 'ghost');
  fs.mkdirSync(ghost);
  fs.writeFileSync(path.join(ghost, 'ignored.tar'), 'half a tar');
  git(ctx.app, ['update-ref', 'refs/atris/put-away/orphan', 'HEAD']);
  fs.mkdirSync(path.join(done.dir, '.verify-x'));
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(ghost), false);
  assert.ok(!putAwayRefs(ctx.app).includes('refs/atris/put-away/orphan'));
  assert.equal(fs.existsSync(path.join(done.dir, '.verify-x')), false);
  assert.equal(fs.existsSync(path.join(done.dir, 'record.json')), true, 'the finished record stays');
  assert.ok(repo.cleaned.length >= 2);
});

test('ten: when the delete stops halfway, the leftover is never put away again and the next restore just works', (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('root ignores folder permissions'); return; }
  const ctx = setup(t);
  const copy = addCopy(ctx, 'stuck', { commit: true });
  write(copy, 'wip.md', 'half-finished\n');
  write(copy, 'guarded/inner.txt', 'kept by a read-only folder\n');
  age(copy, 30);
  fs.chmodSync(path.join(copy, 'guarded'), 0o500);
  t.after(() => { try { fs.chmodSync(path.join(copy, 'guarded'), 0o700); } catch {} });
  const repo = sweepApp(ctx);
  assert.equal(repo.kept[0].reason, 'remove_failed', JSON.stringify(repo));
  assert.equal(fs.existsSync(copy), true);
  // git dropped the copy from its list before it stopped, so the next sweep
  // sees an unlisted folder and leaves it alone.
  const again = sweepApp(ctx);
  assert.equal(again.removed.length, 0);
  assert.deepEqual(again.orphans, [copy], 'the half-deleted copy is not put away a second time');
  assert.equal(putaway.readRecords({ home: ctx.home }).length, 1);
  restore(ctx, 'stuck');
  assert.equal(fs.readFileSync(path.join(copy, 'wip.md'), 'utf8'), 'half-finished\n');
  assert.equal(fs.readFileSync(path.join(copy, 'guarded', 'inner.txt'), 'utf8'), 'kept by a read-only folder\n');
  assert.equal(fs.readFileSync(path.join(copy, 'stuck.txt'), 'utf8'), 'work from stuck\n');
});

// ---------------------------------------------------------------------------
// Eleven. Staged state, and work in progress.

test('eleven: restore puts the staged state back as staged', (t) => {
  const ctx = setup(t, { files: { 'lib.js': 'one\n' } });
  const copy = addCopy(ctx, 'staged');
  write(copy, 'app.js', 'module.exports = "staged";\n');
  git(copy, ['add', 'app.js']);
  write(copy, 'app.js', 'module.exports = "on disk";\n');
  write(copy, 'lib.js', 'two, unstaged\n');
  write(copy, 'brand-new.js', 'staged new\n');
  git(copy, ['add', 'brand-new.js']);
  write(copy, 'brand-new.js', 'staged new, then edited\n');
  const before = raw(copy, ['status', '--porcelain']);
  const cachedBefore = raw(copy, ['diff', '--cached']);
  age(copy, 30);
  sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  restore(ctx, 'staged');
  assert.equal(raw(copy, ['status', '--porcelain']), before);
  assert.equal(raw(copy, ['diff', '--cached']), cachedBefore);
  assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), 'module.exports = "on disk";\n');
  assert.equal(fs.readFileSync(path.join(copy, 'brand-new.js'), 'utf8'), 'staged new, then edited\n');
});

test('eleven: a copy mid-merge or mid-rebase is in use and kept as it is', (t) => {
  const ctx = setup(t);
  const merging = addCopy(ctx, 'merging');
  write(merging, 'app.js', 'module.exports = "copy side";\n');
  git(merging, ['commit', '-qam', 'copy side']);
  write(ctx.app, 'app.js', 'module.exports = "main side";\n');
  git(ctx.app, ['commit', '-qam', 'main side']);
  spawnSync('git', ['merge', 'master'], { cwd: merging });
  assert.ok(fs.existsSync(path.join(git(merging, ['rev-parse', '--absolute-git-dir']), 'MERGE_HEAD')));
  const rebasing = addCopy(ctx, 'rebasing', { commit: true });
  const stopped = spawnSync('git', ['rebase', '-i', 'HEAD~1'], { cwd: rebasing, encoding: 'utf8', env: { ...process.env, GIT_SEQUENCE_EDITOR: 'sed -i.bak s/^pick/edit/' } });
  assert.equal(stopped.status, 0, stopped.stderr);
  for (const copy of [merging, rebasing]) age(copy, 30);
  const repo = sweepApp(ctx);
  assert.deepEqual(repo.kept.map((item) => item.reason).sort(), ['in_progress', 'in_progress']);
  assert.ok(fs.existsSync(path.join(git(rebasing, ['rev-parse', '--absolute-git-dir']), 'rebase-merge')), 'the rebase is still where it was');
});

// ---------------------------------------------------------------------------
// The rest of the rules.

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

test('a clean copy never merged or pushed is removed once idle, and its branch and commits stay', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'unmerged', { commit: true });
  const head = git(copy, ['rev-parse', 'HEAD']);
  age(copy, 25);
  const repo = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(repo.removed.length, 1);
  assert.equal(git(ctx.app, ['rev-parse', 'codex/unmerged']), head);
  assert.equal(repo.removed[0].record.tar, null, 'nothing but commits, so no tar');
});

test('a copy changed an hour ago is kept with the reason', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'recent', { commit: true });
  age(copy, 1);
  const kept = sweepApp(ctx);
  assert.equal(fs.existsSync(copy), true);
  assert.equal(kept.kept[0].reason, 'recent');
  assert.match(kept.kept[0].text, /changed 1 hour ago/);
});

test('a locked copy is kept, and so is the copy this command runs in', (t) => {
  const ctx = setup(t);
  const locked = addCopy(ctx, 'locked', { commit: true });
  git(ctx.app, ['worktree', 'lock', locked]);
  const here = addCopy(ctx, 'here', { commit: true });
  age(locked, 30);
  age(here, 30);
  const repo = sweepApp(ctx, { current: here });
  assert.deepEqual(repo.kept.map((item) => item.reason).sort(), ['current', 'locked']);
});

test('a copy a running program stands in is kept, found by the real process scan', async (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'busy', { commit: true });
  fs.mkdirSync(path.join(copy, 'sub'));
  age(copy, 30);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: path.join(copy, 'sub'), stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!Array.isArray(putaway.listOpenPaths())) { t.skip('this machine cannot list running programs'); return; }
  const report = putaway.sweep({ workspace: ctx.ws, home: ctx.home, current: ctx.ws, apply: true });
  assert.equal(fs.existsSync(copy), true);
  assert.equal(report.repos.find((item) => item.name === 'app').kept[0].reason, 'process');
});

test('when the put-away cannot be written, the copy is left exactly as it was', (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('root ignores folder permissions'); return; }
  const ctx = setup(t);
  const copy = addCopy(ctx, 'stuck', { commit: true });
  write(copy, 'app.js', 'module.exports = 9;\n');
  write(copy, 'draft.md', 'draft\n');
  write(copy, '.env.local', 'TOKEN=copy\n');
  age(copy, 30);
  const status = raw(copy, ['status', '--porcelain', '-uall']);
  fs.chmodSync(ctx.home, 0o500);
  t.after(() => { try { fs.chmodSync(ctx.home, 0o700); } catch {} });
  const repo = sweepApp(ctx);
  assert.equal(repo.kept[0].reason, 'put_away_failed');
  assert.equal(raw(copy, ['status', '--porcelain', '-uall']), status);
  assert.equal(fs.readFileSync(path.join(copy, '.env.local'), 'utf8'), 'TOKEN=copy\n');
  assert.deepEqual(putAwayRefs(ctx.app), []);
});

test('bytes a content filter hides from git status are still saved and restored', (t) => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.app, '.gitattributes'), 'secret.txt filter=strip\n');
  git(ctx.app, ['config', 'filter.strip.clean', 'sed s/hidden/XXXXXX/']);
  git(ctx.app, ['config', 'filter.strip.smudge', 'cat']);
  fs.writeFileSync(path.join(ctx.app, 'secret.txt'), 'visibleXXXXXX\n');
  git(ctx.app, ['add', '.']);
  git(ctx.app, ['commit', '-qm', 'filtered file']);
  const copy = addCopy(ctx, 'filtered');
  fs.writeFileSync(path.join(copy, 'secret.txt'), 'visiblehidden\n');
  assert.equal(git(copy, ['status', '--porcelain']), '');
  age(copy, 30);
  assert.ok(sweepApp(ctx).removed[0].record.tar);
  restore(ctx, 'filtered');
  assert.equal(fs.readFileSync(path.join(copy, 'secret.txt'), 'utf8'), 'visiblehidden\n');
});

test('a dry run changes nothing', (t) => {
  const ctx = setup(t);
  const copy = addCopy(ctx, 'dry', { commit: true });
  write(copy, 'app.js', 'module.exports = 7;\n');
  age(copy, 30);
  const status = raw(copy, ['status', '--porcelain', '-uall']);
  const repo = sweepApp(ctx, { apply: false });
  assert.deepEqual(repo.removed.map((item) => [item.name, item.dryRun]), [['dry', true]]);
  assert.equal(raw(copy, ['status', '--porcelain', '-uall']), status);
  assert.deepEqual(putAwayRefs(ctx.app), []);
  assert.deepEqual(fs.readdirSync(ctx.home), []);
});

test('start puts away this repo\'s oldest copy idle for a day when over the count, and never one in use', (t) => {
  const ctx = setup(t);
  const oldest = addCopy(ctx, 'oldest', { commit: true });
  const middle = addCopy(ctx, 'middle', { commit: true });
  const busy = addCopy(ctx, 'busy', { commit: true });
  age(oldest, 50);
  age(middle, 30);
  const created = createAgentWorktree({
    root: ctx.app, agent: 'codex', task: 'ceiling', deps: false, spaceGuard: false, putAwayHome: ctx.home, activeCwds: [],
    env: { ATRIS_WORKTREE_MAX_PER_REPO: '3', ATRIS_WORKTREE_MAX_GB: '0' },
  });
  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(middle), true);
  assert.equal(fs.existsSync(busy), true);
  assert.deepEqual(created.ceiling.removed.map((item) => item.path), [oldest]);
  assert.match(putaway.ceilingLine(created.ceiling), /put away and removed 1 idle copy of this repo/);
});

test('the size ceiling counts what this repo\'s copies hold and frees the oldest idle one', (t) => {
  const ctx = setup(t);
  const oldest = addCopy(ctx, 'big-old', { commit: true });
  write(oldest, 'blob.bin', Buffer.alloc(3 * 1024 * 1024, 1));
  const newer = addCopy(ctx, 'big-new', { commit: true });
  write(newer, 'blob.bin', Buffer.alloc(3 * 1024 * 1024, 2));
  age(oldest, 50);
  age(newer, 30);
  const result = putaway.enforceCeiling({ repo: ctx.app, home: ctx.home, scan: NO_PROGRAMS, current: ctx.ws, env: { ATRIS_WORKTREE_MAX_GB: String(5 / 1000), ATRIS_WORKTREE_MAX_PER_REPO: '0' } });
  assert.deepEqual(result.removed.map((item) => item.path), [oldest]);
  assert.equal(fs.existsSync(newer), true);
  assert.equal(result.over, false);
});

test('start clones the main install when the lockfiles match, as a real folder, and skips it when they differ', (t) => {
  const ctx = setup(t, { files: { 'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n', 'package.json': '{"name":"app"}\n' } });
  write(ctx.app, 'node_modules/left/index.js', 'module.exports = 1;\n');
  const same = createAgentWorktree({ root: ctx.app, agent: 'codex', task: 'deps same', deps: {}, spaceGuard: false, putAwayHome: ctx.home, activeCwds: [], env: {} });
  if (same.deps.status !== 'cloned') { t.skip(`this disk cannot clone folders: ${same.deps.reason}`); return; }
  const modules = path.join(same.path, 'node_modules');
  assert.equal(fs.lstatSync(modules).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(modules).isDirectory(), true);
  fs.writeFileSync(path.join(modules, 'left', 'index.js'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(ctx.app, 'node_modules', 'left', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  write(ctx.app, 'package-lock.json', '{"lockfileVersion":3,"packages":{"node_modules/x":{"version":"1.0.0"}}}\n');
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
  const run = spawnSync(process.execPath, [CLI, 'worktree', 'sweep', '--json'], { cwd: ctx.app, encoding: 'utf8', timeout: 60000, env: cliEnv(ctx) });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
  assert.equal(report.workspace, ctx.ws);
  assert.deepEqual(report.repos.find((item) => item.name === 'app').removed.map((item) => item.name), ['real']);
  assert.equal(fs.existsSync(copy), true);
});

test('a frozen or slow sweep job is spotted, and the new job runs the atris on PATH every hour', (t) => {
  const ctx = setup(t);
  const frozen = path.join(ctx.home, 'ai.atris.worktree-sweep.ab12cd34.plist');
  fs.writeFileSync(frozen, `<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/env</string><string>node</string><string>${TEST_HOME}/.atris/worktree-sweep/cli/bin/atris.js</string></array><key>StartInterval</key><integer>10800</integer></dict></plist>\n`);
  assert.match(putaway.sweepJobHint({ files: [frozen] }), /frozen copy of atris.*run atris worktree sweep --install/);
  const plan = sweepSchedulePlan({ workspace: '/w/arena', homeDir: TEST_HOME, platform: 'darwin', envPath: '/usr/bin:/bin' });
  assert.equal(plan.every_seconds, 3600);
  assert.match(plan.contents, /<string>\/usr\/bin\/env<\/string><string>atris<\/string><string>worktree<\/string><string>sweep<\/string><string>--apply<\/string><string>--job<\/string>/);
  const fresh = path.join(ctx.home, 'ai.atris.worktree-sweep.new.plist');
  fs.writeFileSync(fresh, plan.contents);
  assert.equal(putaway.sweepJobHint({ files: [fresh] }), '');
  const cron = sweepSchedulePlan({ workspace: '/w/arena', homeDir: TEST_HOME, platform: 'linux', envPath: '/usr/bin:/bin' });
  assert.equal(putaway.sweepJobProblem(cron.crontab_line, { kind: 'cron' }), '');
  if (process.platform === 'darwin') {
    const agents = path.join(TEST_HOME, 'Library', 'LaunchAgents');
    fs.mkdirSync(agents, { recursive: true });
    fs.copyFileSync(frozen, path.join(agents, 'ai.atris.worktree-sweep.ab12cd34.plist'));
    t.after(() => fs.rmSync(path.join(TEST_HOME, 'Library'), { recursive: true, force: true }));
    const run = spawnSync(process.execPath, [CLI, 'worktree', 'sweep', '--workspace', ctx.ws], { cwd: ctx.ws, encoding: 'utf8', timeout: 60000, env: cliEnv(ctx) });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /timer: the build-copy cleaner runs a frozen copy of atris on the wrong schedule; run atris worktree sweep --install to fix it/);
  }
});

test('the job writes one line per run with what it saw, removed, put away and kept, and what records hold', (t) => {
  const ctx = setup(t);
  const gone = addCopy(ctx, 'gone', { commit: true });
  write(gone, 'wip.md', 'wip\n');
  age(gone, 30);
  addCopy(ctx, 'fresh', { commit: true });
  const report = putaway.sweep({ workspace: ctx.ws, home: ctx.home, scan: NO_PROGRAMS, current: ctx.ws, apply: true });
  const line = putaway.sweepLogLine(report);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /seen 2, removed 1 \(put away 1\), kept 1 \(1 changed recently\), freed .*, 1 put-away record holds /);
});
