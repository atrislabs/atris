'use strict';

// Real git, real bare remote, real process scan. A build copy cleans itself up
// when its job ends: ship removes it once the work is on origin, and the sweep
// puts an idle copy's leftovers away before removing it. No step may lose
// work: every case below removes a copy and then restores it byte for byte,
// or keeps it with the reason.

require('./helpers/temp-home');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { reapPushedCopy, sweepSchedulePlan, sweepWorkspace: coreSweep } = require('../lib/worktree-core');
const putaway = require('../lib/worktree-putaway');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr || run.stdout}`);
  return String(run.stdout || '').trim();
}

// <workspace>/app is the main checkout, <workspace>/.agent-worktrees/app/<name>
// the build copies, <workspace>/remote.git the origin.
// Put-away records go to a temp folder, never the real home folder.
const PUT_AWAY = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-self-cleanup-put-away-')));
const PRIOR_PUT_AWAY = process.env.ATRIS_PUT_AWAY_DIR;
process.env.ATRIS_PUT_AWAY_DIR = PUT_AWAY;
test.after(() => {
  if (PRIOR_PUT_AWAY === undefined) delete process.env.ATRIS_PUT_AWAY_DIR;
  else process.env.ATRIS_PUT_AWAY_DIR = PRIOR_PUT_AWAY;
  fs.rmSync(PUT_AWAY, { recursive: true, force: true });
});

function sweepWorkspace(options) {
  return coreSweep({ home: PUT_AWAY, current: options.workspace, ...options });
}

function restore(name) {
  const back = putaway.restoreCopy({ name, home: PUT_AWAY });
  assert.equal(back.ok, true, back.error);
  return back;
}

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
  // node_modules counts as throwaway only beside the package file that makes it.
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"app"}\n');
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
  fs.writeFileSync(path.join(copy, '.atris', 'agent-worktree.json'), `${JSON.stringify({ owner: 'codex', branch: 'codex/x', created_at: new Date().toISOString() })}\n`);
}

const SHIP_ARGS = ['worktree', 'ship', '--message', 'Ship the change', '--no-pr', '--no-map-refresh'];
const SHIP_ENV = () => ({ ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_WORKTREE_KEEP_AFTER_SHIP: '', ATRIS_PUT_AWAY_DIR: PUT_AWAY });

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

test('ship puts away an ignored secret it cannot rebuild, removes the copy, and restore brings the secret back', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'ship-secret');
  fs.writeFileSync(path.join(copy, '.env'), 'TOKEN=local\n');
  const run = ship(copy);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /cleanup: removed this build copy/);
  assert.match(run.stdout, /leftover files in it were put away; atris worktree restore ship-secret brings them back/);
  assert.equal(fs.existsSync(copy), false);
  restore('ship-secret');
  assert.equal(fs.readFileSync(path.join(copy, '.env'), 'utf8'), 'TOKEN=local\n');
});

test('sweep puts away an idle dirty copy without pushing anything, and restore brings it back', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'abandoned');
  makeDirty(copy);
  age(copy, 8);
  const remoteRefs = git(ws.app, ['--git-dir', ws.remote, 'for-each-ref', '--format=%(refname) %(objectname)']);

  const dry = sweepWorkspace({ workspace: ws.root, apply: false });
  assert.deepEqual(repoReport(dry).removed.map((item) => item.name), ['abandoned']);
  assert.equal(fs.existsSync(copy), true, 'a dry run touches nothing');

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const repo = repoReport(report);
  assert.equal(repo.removed.length, 1, JSON.stringify(repo.kept));
  assert.equal(fs.existsSync(copy), false, 'the copy folder is gone');
  const saved = repo.removed[0].record;
  assert.equal(git(ws.app, ['show', `${saved.ref}:app.js`]), 'module.exports = 2;');
  const tree = git(ws.app, ['ls-tree', '-r', '--name-only', saved.ref]);
  assert.doesNotMatch(tree, /notes\.md|node_modules|\.atris/, 'untracked files never enter the ref');
  const inTar = spawnSync('tar', ['-tf', saved.tar], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(inTar, ['notes.md'], 'the untracked file is in the private tar; the install and the start marker are dropped');
  assert.equal(git(ws.app, ['rev-parse', 'refs/heads/codex/abandoned']), git(ws.app, ['rev-parse', 'master']), 'the copy branch never moves');
  assert.equal(git(ws.app, ['--git-dir', ws.remote, 'for-each-ref', '--format=%(refname) %(objectname)']), remoteRefs, 'nothing was pushed');
  const record = removals(ws.app).find((row) => row.path === copy);
  assert.equal(record.reason, 'idle');
  assert.equal(record.put_away, 'abandoned');

  restore('abandoned');
  assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(fs.readFileSync(path.join(copy, 'notes.md'), 'utf8'), 'half-finished idea\n');
});

test('sweep keeps an idle dirty copy while a program runs inside it', async (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'busy');
  makeDirty(copy);
  age(copy, 8);
  const child = spawn('sleep', ['60'], { cwd: copy, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve) => child.once('spawn', resolve));

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const kept = repoReport(report).kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'process');
  assert.equal(fs.existsSync(path.join(copy, 'notes.md')), true);
});

test('sweep keeps a dirty copy changed inside the idle window', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'fresh');
  makeDirty(copy);
  age(copy, 2 / 24);

  const report = sweepWorkspace({ workspace: ws.root, apply: true });
  const kept = repoReport(report).kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'recent');
  assert.match(kept.text, /changed 2 hours ago/);
  assert.equal(fs.existsSync(path.join(copy, 'notes.md')), true);

  const shorter = sweepWorkspace({ workspace: ws.root, apply: false, idleMs: 60 * 60 * 1000 });
  assert.equal(repoReport(shorter).removed.length, 1, 'the idle window can be changed');
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

// Only ignored node_modules/ and .next/ are dropped; a hand-made file in an
// ignored build/ folder is saved like any other.
test('sweep saves ignored user files under uploads/ and in an ignored build/ folder', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'user-files');
  makeDirty(copy);
  fs.mkdirSync(path.join(copy, 'build'));
  fs.writeFileSync(path.join(copy, 'build', 'bundle.js'), 'built');
  fs.mkdirSync(path.join(copy, 'uploads'));
  fs.writeFileSync(path.join(copy, 'uploads', 'photo.png'), 'png');
  age(copy, 8);

  const repo = repoReport(sweepWorkspace({ workspace: ws.root, apply: true }));
  assert.equal(fs.existsSync(copy), false);
  const tar = repo.removed[0].record.tar;
  const listed = spawnSync('tar', ['-tf', tar], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(listed.sort(), ['build/bundle.js', 'notes.md', 'uploads/photo.png']);
  restore('user-files');
  assert.equal(fs.readFileSync(path.join(copy, 'uploads', 'photo.png'), 'utf8'), 'png');
  assert.equal(fs.readFileSync(path.join(copy, 'build', 'bundle.js'), 'utf8'), 'built');
});

test('sweep keeps both a staged version and a different version on disk', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'staged');
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = "staged";\n');
  git(copy, ['add', 'app.js']);
  fs.writeFileSync(path.join(copy, 'app.js'), 'module.exports = "on disk";\n');
  age(copy, 8);

  const repo = repoReport(sweepWorkspace({ workspace: ws.root, apply: true }));
  assert.equal(repo.removed.length, 1, JSON.stringify(repo.kept));
  assert.equal(fs.existsSync(copy), false);
  const saved = repo.removed[0].record;
  assert.equal(git(ws.app, ['show', `${saved.ref}:app.js`]), 'module.exports = "on disk";');
  assert.equal(git(ws.app, ['show', `${saved.ref}^:app.js`]), 'module.exports = "staged";');
  assert.equal(git(ws.app, ['rev-parse', `${saved.ref}~2`]), git(ws.app, ['rev-parse', 'master']));
  restore('staged');
  assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), 'module.exports = "on disk";\n');
  assert.equal(git(copy, ['show', ':app.js']), 'module.exports = "staged";', 'the staged version is staged again');
});

test('sweep saves an untracked nested git repository whole, its own commits included', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'nested-repo');
  makeDirty(copy);
  const inner = path.join(copy, 'vendor', 'lib');
  fs.mkdirSync(inner, { recursive: true });
  git(inner, ['init', '-q']);
  fs.writeFileSync(path.join(inner, 'lib.js'), 'local only\n');
  git(inner, ['add', 'lib.js']);
  git(inner, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'unpublished']);
  const innerHead = git(inner, ['rev-parse', 'HEAD']);
  age(copy, 8);

  const repo = repoReport(sweepWorkspace({ workspace: ws.root, apply: true }));
  assert.equal(fs.existsSync(copy), false, JSON.stringify(repo.kept));
  restore('nested-repo');
  assert.equal(fs.readFileSync(path.join(inner, 'lib.js'), 'utf8'), 'local only\n');
  assert.equal(git(inner, ['rev-parse', 'HEAD']), innerHead, 'the nested repo keeps its unpublished commit');
});

test('an assume-unchanged edit is saved and restored; a skip-worktree copy is kept with the reason', (t) => {
  const ws = workspace(t);
  const hidden = addCopy(ws, 'hidden-assume');
  git(hidden, ['update-index', '--assume-unchanged', 'app.js']);
  fs.writeFileSync(path.join(hidden, 'app.js'), 'module.exports = "hidden edit";\n');
  fs.writeFileSync(path.join(hidden, 'notes.md'), 'visible edit\n');
  age(hidden, 8);
  const skip = addCopy(ws, 'hidden-skip');
  git(skip, ['update-index', '--skip-worktree', 'app.js']);
  fs.writeFileSync(path.join(skip, 'app.js'), 'module.exports = "hidden edit";\n');
  age(skip, 8);

  const repo = repoReport(sweepWorkspace({ workspace: ws.root, apply: true }));
  assert.equal(fs.existsSync(hidden), false);
  restore('hidden-assume');
  assert.equal(fs.readFileSync(path.join(hidden, 'app.js'), 'utf8'), 'module.exports = "hidden edit";\n');
  assert.equal(fs.readFileSync(path.join(hidden, 'notes.md'), 'utf8'), 'visible edit\n');

  const kept = repo.kept.find((item) => item.path === skip);
  assert.equal(kept.reason, 'put_away_failed');
  assert.match(kept.text, /skip-worktree hides edits in app\.js/);
  assert.equal(fs.readFileSync(path.join(skip, 'app.js'), 'utf8'), 'module.exports = "hidden edit";\n');
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
  const repo = repoReport(sweepWorkspace({ workspace: ws.root, apply: true, activeCwds: [] }));
  assert.equal(repo.removed.length, 1, JSON.stringify(repo.kept));
  const inTar = spawnSync('tar', ['-tf', repo.removed[0].record.tar], { encoding: 'utf8' }).stdout.split('\n');
  assert.ok(inTar.includes('notes.md'));
});

test('the sweep command puts away a stale dirty copy, and the timer applies the same rule hourly', (t) => {
  const ws = workspace(t);
  const copy = addCopy(ws, 'report-only');
  makeDirty(copy);
  age(copy, 8);

  const text = spawnSync(process.execPath, [CLI, 'worktree', 'sweep', '--apply', '--workspace', ws.root], { encoding: 'utf8', timeout: 60000, env: SHIP_ENV() });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /removed: report-only \(idle, .*work put away as report-only\)/);
  assert.equal(fs.existsSync(copy), false);
  restore('report-only');
  assert.equal(fs.readFileSync(path.join(copy, 'notes.md'), 'utf8'), 'half-finished idea\n');

  const plan = sweepSchedulePlan({ workspace: ws.root, homeDir: ws.root, platform: 'darwin' });
  assert.match(plan.contents, /<string>--apply<\/string><string>--job<\/string>/);
  assert.equal(plan.every_seconds, 3600);
});

test('a checked-out submodule keeps the copy, since removing it would drop the submodule git folder', (t) => {
  const ws = workspace(t);
  const subRemote = path.join(ws.root, 'sub.git');
  const subSrc = path.join(ws.root, 'sub-src');
  git(ws.root, ['init', '--bare', '-q', subRemote]);
  fs.mkdirSync(subSrc);
  git(subSrc, ['init', '-q']);
  fs.writeFileSync(path.join(subSrc, 'conf.txt'), 'original\n');
  git(subSrc, ['add', '.']);
  git(subSrc, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'sub']);
  git(subSrc, ['branch', '-M', 'master']);
  git(subSrc, ['push', '-q', subRemote, 'master']);
  git(ws.app, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRemote, 'lib']);
  git(ws.app, ['commit', '-qm', 'add submodule']);
  git(ws.app, ['push', '-q', 'origin', 'master']);
  const copy = addCopy(ws, 'sub-hidden');
  git(copy, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init']);
  const lib = path.join(copy, 'lib');
  fs.writeFileSync(path.join(lib, 'conf.txt'), 'local edit\n');
  fs.writeFileSync(path.join(copy, 'notes.md'), 'half-finished idea\n');
  age(copy, 8);

  const kept = repoReport(sweepWorkspace({ workspace: ws.root, apply: true })).kept.find((item) => item.path === copy);
  assert.equal(kept.reason, 'put_away_failed', JSON.stringify(kept));
  assert.match(kept.text, /submodule lib is checked out/);
  assert.equal(fs.readFileSync(path.join(lib, 'conf.txt'), 'utf8'), 'local edit\n');
});

test('a content filter, from an attribute or from repo config, cannot change the saved bytes', (t) => {
  for (const kind of ['attribute', 'config']) {
    const ws = workspace(t);
    const copy = addCopy(ws, `filter-${kind}`);
    if (kind === 'attribute') {
      fs.writeFileSync(path.join(copy, '.gitattributes'), '*.txt filter=strip\n');
    }
    git(ws.app, ['config', 'filter.strip.clean', 'sed s/secret//']);
    fs.writeFileSync(path.join(copy, 'notes.txt'), 'the secret part\n');
    age(copy, 8);

    sweepWorkspace({ workspace: ws.root, apply: true });
    assert.equal(fs.existsSync(copy), false, kind);
    restore(`filter-${kind}`);
    assert.equal(fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8'), 'the secret part\n', kind);
  }
});

// A clean filter can hide local text even from git status. The put-away
// compares every tracked file's raw bytes with what git holds, so that text
// lands in the tar on every removal path.
function filteredWorkspace(t) {
  const ws = workspace(t);
  // Same length in and out, so git trusts the filter instead of the file size.
  git(ws.app, ['config', 'filter.strip.clean', 'sed s/secret/xxxxxx/']);
  git(ws.app, ['config', 'filter.strip.smudge', 'cat']);
  fs.writeFileSync(path.join(ws.app, '.gitattributes'), '*.txt filter=strip\n');
  fs.writeFileSync(path.join(ws.app, 'notes.txt'), 'the xxxxxx part\n');
  git(ws.app, ['add', '.gitattributes', 'notes.txt']);
  git(ws.app, ['commit', '-qm', 'filtered notes']);
  git(ws.app, ['push', '-q', 'origin', 'master']);
  return ws;
}

function hideSecret(copy) {
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'the secret part\n');
  assert.equal(git(copy, ['status', '--porcelain']), '', 'the filter hides the local text from status');
}

test('ship saves local text a content filter hides from status before it removes the copy', (t) => {
  const ws = filteredWorkspace(t);
  const copy = addCopy(ws, 'ship-filter');
  hideSecret(copy);
  const run = spawnSync(process.execPath, [CLI, ...SHIP_ARGS], { cwd: copy, encoding: 'utf8', timeout: 60000, env: SHIP_ENV() });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /cleanup: removed this build copy/);
  assert.equal(fs.existsSync(copy), false);
  restore('ship-filter');
  assert.equal(fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8'), 'the secret part\n');
});

test('the sweep saves hidden text in clean merged and clean pushed copies too', (t) => {
  const ws = filteredWorkspace(t);
  const merged = addCopy(ws, 'merged-filter');
  hideSecret(merged);
  const pushed = addCopy(ws, 'pushed-filter');
  fs.writeFileSync(path.join(pushed, 'app.js'), 'module.exports = 4;\n');
  git(pushed, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qam', 'pushed work']);
  git(pushed, ['push', '-q', 'origin', 'codex/pushed-filter']);
  hideSecret(pushed);
  age(merged, 8);
  age(pushed, 8);

  const repo = repoReport(sweepWorkspace({ workspace: ws.root, apply: true }));
  assert.equal(repo.removed.length, 2, JSON.stringify(repo.kept));
  for (const [copy, name] of [[merged, 'merged-filter'], [pushed, 'pushed-filter']]) {
    restore(name);
    assert.equal(fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8'), 'the secret part\n');
  }
});

test('an ident attribute cannot hide local text on ship or in the sweep, since $Id: text $ hashes like $Id$', (t) => {
  const ws = workspace(t);
  fs.writeFileSync(path.join(ws.app, '.gitattributes'), '*.txt ident\n');
  fs.writeFileSync(path.join(ws.app, 'notes.txt'), '$Id$\n');
  git(ws.app, ['add', '.gitattributes', 'notes.txt']);
  git(ws.app, ['commit', '-qm', 'ident notes']);
  git(ws.app, ['push', '-q', 'origin', 'master']);
  const hide = (copy) => {
    const original = fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8');
    // Same length as the expanded line, so git rehashes instead of trusting the size.
    const secret = original.replace(/\$Id: [0-9a-f]+ \$/, (match) => `$Id: ${'s'.repeat(match.length - 7)} $`);
    assert.notEqual(secret, original);
    fs.writeFileSync(path.join(copy, 'notes.txt'), secret);
    assert.equal(git(copy, ['status', '--porcelain']), '', 'ident hides the local text from status');
    return secret;
  };

  const shipped = addCopy(ws, 'ship-ident');
  const shippedText = hide(shipped);
  const run = spawnSync(process.execPath, [CLI, ...SHIP_ARGS], { cwd: shipped, encoding: 'utf8', timeout: 60000, env: SHIP_ENV() });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(fs.existsSync(shipped), false);
  restore('ship-ident');
  assert.equal(fs.readFileSync(path.join(shipped, 'notes.txt'), 'utf8'), shippedText);

  const merged = addCopy(ws, 'merged-ident');
  const mergedText = hide(merged);
  age(merged, 8);
  sweepWorkspace({ workspace: ws.root, apply: true, activeCwds: [] });
  assert.equal(fs.existsSync(merged), false);
  restore('merged-ident');
  assert.equal(fs.readFileSync(path.join(merged, 'notes.txt'), 'utf8'), mergedText);
});
