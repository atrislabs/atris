'use strict';

// atris rsi loop finds notebook fixes with no mission queued, verifies them,
// commits and pushes them on one isolated branch, and cleans up only after the
// remote tip matches. Every room is a temp folder with a bare origin, a main
// checkout with its own uncommitted work, and no missions at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const rsiLoop = require('../lib/rsi-loop');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const EMPTY_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rsi-loop-cfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_CONFIG, '');
// Git reads identity and hooks from these, so nothing on this computer leaks in.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};
Object.assign(process.env, GIT_ENV);
delete process.env.ATRIS_RSI_ATTEMPT_NODE;
delete process.env.ATRIS_RSI_STATE;

const DASH = String.fromCharCode(0x2014);
const WIDGET = ['// helpers', '', '', '', '', '', '', '', 'function widget() {', '  return 1;', '}', 'module.exports = { widget };', ''].join('\n');
const MOVED_MAP = '# map\n\n| task | path |\n|---|---|\n| widget | `lib/widget.js:2` `widget` |\n';
const GOOD_MAP = '# map\n\n| task | path |\n|---|---|\n| widget | `lib/widget.js:9` `widget` |\n';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function tryGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function room(t, { map = MOVED_MAP, notes = 'plain notes\n' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rsi-loop-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, 'origin.git');
  git(base, ['init', '-q', '--bare', '-b', 'master', remote]);
  const seed = path.join(base, 'seed');
  git(base, ['init', '-q', '-b', 'master', seed]);
  fs.mkdirSync(path.join(seed, 'lib'));
  fs.mkdirSync(path.join(seed, 'atris'));
  fs.writeFileSync(path.join(seed, 'lib', 'widget.js'), WIDGET);
  fs.writeFileSync(path.join(seed, 'atris', 'MAP.md'), map);
  fs.writeFileSync(path.join(seed, 'atris', 'notes.md'), notes);
  fs.writeFileSync(path.join(seed, '.gitignore'), '.atris/\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-q', 'origin', 'master']);
  const root = path.join(base, 'main');
  git(base, ['clone', '-q', remote, root]);
  // The person's own unsaved work in the main checkout.
  fs.writeFileSync(path.join(root, 'lib', 'widget.js'), `${WIDGET}// half done\n`);
  fs.writeFileSync(path.join(root, 'scratch.txt'), 'mine\n');
  const before = git(root, ['status', '--porcelain']);
  return { base, remote, root, before };
}

function remoteBranches(remote) {
  return git(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').filter((b) => b !== 'master' && b);
}

function localBranches(root) {
  return git(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${rsiLoop.BRANCH_PREFIX}*`]).split('\n').filter(Boolean);
}

function assertMainUntouched(r) {
  assert.equal(git(r.root, ['status', '--porcelain']), r.before);
  assert.equal(fs.readFileSync(path.join(r.root, 'lib', 'widget.js'), 'utf8'), `${WIDGET}// half done\n`);
  assert.equal(fs.readFileSync(path.join(r.root, 'scratch.txt'), 'utf8'), 'mine\n');
  assert.equal(fs.existsSync(path.join(r.root, '.atris', 'missions')), false);
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, 'rsi', 'loop', ...args], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: { ...scrubAgentEnv(), ...GIT_ENV, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

test('with no mission, a moved map ref is found, verified, committed, pushed and cleaned up', (t) => {
  const r = room(t);
  const run = runCli(r.root, ['--json']);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.stop_reason, 'delivered');
  assert.equal(out.delivered, true);
  assert.equal(out.cleaned, true);
  assert.equal(out.commits, 1);
  assert.match(out.branch, /^codex\/rsi-notebook$/);
  assert.deepEqual(remoteBranches(r.remote), [out.branch]);
  assert.equal(git(r.remote, ['rev-parse', out.branch]), out.pushed_sha);
  const shipped = git(r.remote, ['show', `${out.pushed_sha}:atris/MAP.md`]);
  assert.match(shipped, /`lib\/widget\.js:9` `widget`/);
  assert.match(git(r.remote, ['log', '-1', '--format=%B', out.pushed_sha]), /Co-authored-by: Atris/);
  assert.deepEqual(localBranches(r.root), []);
  assert.equal(git(r.root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  assertMainUntouched(r);
  const rows = fs.readFileSync(rsiLoop.loopsPath(r.root), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).stop_reason, 'delivered');
});

test('a safe wording repair on a notebook page ships too', async (t) => {
  const r = room(t, { map: GOOD_MAP, notes: `fast ${DASH} plain\n` });
  const out = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(out.stop_reason, 'delivered', out.error);
  assert.deepEqual(out.checks.map((c) => [c.name, c.outcome]), [['map_refs', 'nothing'], ['wording', 'committed']]);
  assert.equal(git(r.remote, ['show', `${out.pushed_sha}:atris/notes.md`]), 'fast, plain');
  assertMainUntouched(r);
});

test('nothing to fix makes no commit, no push, and removes the checkout', (t) => {
  const r = room(t, { map: GOOD_MAP });
  const run = runCli(r.root, ['--json']);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.stop_reason, 'nothing_to_do');
  assert.equal(out.commits, 0);
  assert.equal(out.cleaned, true);
  assert.deepEqual(remoteBranches(r.remote), []);
  assert.deepEqual(localBranches(r.root), []);
  assertMainUntouched(r);
});

test('a refused push keeps the branch and checkout, and the next run delivers the same branch', async (t) => {
  const r = room(t);
  const hook = path.join(r.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho no thanks >&2\nexit 1\n', { mode: 0o755 });
  const first = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(first.stop_reason, 'push_failed');
  assert.equal(first.ok, false);
  assert.equal(first.delivered, false);
  assert.ok(fs.existsSync(first.kept));
  assert.deepEqual(localBranches(r.root), [first.branch]);
  assert.deepEqual(remoteBranches(r.remote), []);
  assertMainUntouched(r);

  fs.rmSync(hook);
  const second = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(second.stop_reason, 'delivered', second.error);
  assert.equal(second.resumed, true);
  assert.equal(second.branch, first.branch);
  assert.equal(second.cleaned, true);
  assert.equal(fs.existsSync(first.kept), false);
  assert.deepEqual(remoteBranches(r.remote), [first.branch]);
  assert.deepEqual(localBranches(r.root), []);
  assertMainUntouched(r);
});

test('a budget gone before the run starts makes no checkout', async (t) => {
  const r = room(t);
  let calls = 0;
  const now = () => (calls++ === 0 ? 0 : 10 * 60000);
  const out = await rsiLoop.runLoop({ workspace: r.root, minutes: 5 }, { now });
  assert.equal(out.stop_reason, 'time_budget');
  assert.equal(out.branch, null);
  assert.deepEqual(localBranches(r.root), []);
  assert.equal(fs.existsSync(path.join(r.base, '.agent-worktrees')), false);
  assertMainUntouched(r);
});

test('a budget gone after the commit keeps the commit for the next run instead of pushing late', async (t) => {
  const r = room(t);
  let late = false;
  const now = () => (late ? 10 * 60000 : 0);
  const checks = [{ name: 'map_refs', run: (wt) => { const res = rsiLoop.CHECKS[0].run(wt); const verify = res.verify; return { ...res, verify: () => { const ok = verify(); late = true; return ok; } }; } }];
  const out = await rsiLoop.runLoop({ workspace: r.root, minutes: 5 }, { now, checks });
  assert.equal(out.stop_reason, 'time_budget');
  assert.equal(out.commits, 1);
  assert.deepEqual(remoteBranches(r.remote), []);
  assert.deepEqual(localBranches(r.root), [out.branch]);
  assert.ok(fs.existsSync(out.kept));
  assert.equal(git(out.kept, ['status', '--porcelain']), '');
  assertMainUntouched(r);
});

test('edits outside the allowed notebook paths are undone and never committed', async (t) => {
  const r = room(t, { map: GOOD_MAP });
  const checks = [{
    name: 'stray',
    run: (wt) => {
      fs.writeFileSync(path.join(wt, 'lib', 'x.js'), 'bad\n');
      fs.mkdirSync(path.join(wt, 'atris', 'team'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'atris', 'team', 'a.md'), 'bad\n');
      fs.appendFileSync(path.join(wt, 'atris', 'notes.md'), 'fine\n');
      return { found: 3, message: 'stray', verify: () => true };
    },
  }];
  const out = await rsiLoop.runLoop({ workspace: r.root }, { checks });
  assert.equal(out.checks[0].outcome, 'outside_allowed_paths');
  assert.equal(out.commits, 0);
  assert.equal(out.stop_reason, 'nothing_to_do');
  assert.equal(out.cleaned, true);
  assert.deepEqual(remoteBranches(r.remote), []);
  for (const file of ['atris/CLAUDE.md', 'atris/TODO.md', 'atris/team/a.md', 'atris/logs/x.md', 'atris.md', 'lib/x.js']) {
    assert.equal(rsiLoop.allowedPath(file), false, file);
  }
  assert.equal(rsiLoop.allowedPath('atris/wiki/page.md'), true);
});

test('a check that fails its verify is undone and the next check still ships', async (t) => {
  const r = room(t);
  const checks = [
    { name: 'broken', run: (wt) => { fs.appendFileSync(path.join(wt, 'atris', 'notes.md'), 'unproven\n'); return { found: 1, message: 'broken', verify: () => false }; } },
    rsiLoop.CHECKS[0],
  ];
  const out = await rsiLoop.runLoop({ workspace: r.root }, { checks });
  assert.deepEqual(out.checks.map((c) => c.outcome), ['verify_failed', 'committed']);
  assert.equal(out.stop_reason, 'delivered', out.error);
  assert.equal(git(r.remote, ['show', `${out.pushed_sha}:atris/notes.md`]), 'plain notes');
  assertMainUntouched(r);
});

test('a refused commit stops the run and keeps the checkout as it was', (t) => {
  const r = room(t);
  fs.writeFileSync(path.join(r.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 });
  const run = runCli(r.root, ['--json']);
  assert.equal(run.status, 1, run.stderr || run.stdout);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.stop_reason, 'commit_blocked');
  assert.match(out.error, /blocked/);
  assert.ok(fs.existsSync(out.kept));
  assert.notEqual(git(out.kept, ['status', '--porcelain']), '');
  assert.deepEqual(remoteBranches(r.remote), []);
  assertMainUntouched(r);
});

test('a second run while one is live is refused before it touches anything', async (t) => {
  const r = room(t);
  fs.mkdirSync(path.dirname(rsiLoop.lockPath(r.root)), { recursive: true });
  fs.writeFileSync(rsiLoop.lockPath(r.root), JSON.stringify({ pid: process.pid, host: os.hostname() }));
  const out = await rsiLoop.runLoop({ workspace: r.root });
  assert.match(out.refused, /another rsi loop/);
  assert.deepEqual(localBranches(r.root), []);
  const cli = runCli(r.root, ['--minutes', 'soon']);
  assert.equal(cli.status, 2);
  assert.match(cli.stdout, /--minutes must be/);
  assertMainUntouched(r);
});


test('successive runs reuse the same remote branch and retain earlier commits', async (t) => {
  const r = room(t);
  const first = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(first.stop_reason, 'delivered', first.error);
  const checks = [{ name: 'another', run: (wt) => {
    fs.appendFileSync(path.join(wt, 'atris', 'notes.md'), 'a second improvement\n');
    return { found: 1, message: 'second improvement', verify: () => true };
  } }];
  const second = await rsiLoop.runLoop({ workspace: r.root }, { checks });
  assert.equal(second.stop_reason, 'delivered', second.error);
  assert.equal(second.branch, first.branch);
  assert.deepEqual(remoteBranches(r.remote), [first.branch]);
  assert.equal(tryGit(r.remote, ['merge-base', '--is-ancestor', first.pushed_sha, second.pushed_sha]).status, 0);
  assertMainUntouched(r);
});

test('a remote RSI branch that diverges from main is preserved and never overwritten', async (t) => {
  const r = room(t);
  const first = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(first.stop_reason, 'delivered', first.error);
  const oldTip = first.pushed_sha;
  const seed = path.join(r.base, 'seed');
  fs.writeFileSync(path.join(seed, 'new-main.txt'), 'new mainline\n');
  git(seed, ['add', 'new-main.txt']);
  git(seed, ['commit', '-qm', 'advance main']);
  git(seed, ['push', '-q', 'origin', 'master']);
  const second = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(second.stop_reason, 'checkout_failed');
  assert.match(second.error, /behind or diverged/);
  assert.equal(git(r.remote, ['rev-parse', first.branch]), oldTip);
  assertMainUntouched(r);
});

test('a failed fetch does not start work or push a stale branch', async (t) => {
  const r = room(t);
  git(r.root, ['remote', 'set-url', 'origin', path.join(r.base, 'missing.git')]);
  const out = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(out.stop_reason, 'fetch_failed');
  assert.equal(out.delivered, false);
  assert.deepEqual(localBranches(r.root), []);
  assert.deepEqual(remoteBranches(r.remote), []);
  assertMainUntouched(r);
});

test('wording checks never follow a tracked symlink outside the checkout', async (t) => {
  const r = room(t, { map: GOOD_MAP });
  const external = path.join(r.base, 'external.md');
  fs.writeFileSync(external, `outside ${DASH} unchanged\n`);
  const seed = path.join(r.base, 'seed');
  fs.symlinkSync(external, path.join(seed, 'atris', 'linked.md'));
  git(seed, ['add', 'atris/linked.md']);
  git(seed, ['commit', '-qm', 'add linked file']);
  git(seed, ['push', '-q', 'origin', 'master']);
  const out = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(out.stop_reason, 'nothing_to_do', out.error);
  assert.equal(fs.readFileSync(external, 'utf8'), `outside ${DASH} unchanged\n`);
  assertMainUntouched(r);
});

test('map repair refuses a symlink to a file outside the checkout', async (t) => {
  const r = room(t, { map: GOOD_MAP });
  const external = path.join(r.base, 'external-map.md');
  fs.writeFileSync(external, MOVED_MAP);
  const seed = path.join(r.base, 'seed');
  fs.rmSync(path.join(seed, 'atris', 'MAP.md'));
  fs.symlinkSync(external, path.join(seed, 'atris', 'MAP.md'));
  git(seed, ['add', 'atris/MAP.md']);
  git(seed, ['commit', '-qm', 'link map']);
  git(seed, ['push', '-q', 'origin', 'master']);
  const out = await rsiLoop.runLoop({ workspace: r.root });
  assert.equal(out.stop_reason, 'error');
  assert.match(out.error, /symlink/);
  assert.equal(fs.readFileSync(external, 'utf8'), MOVED_MAP);
  assert.deepEqual(remoteBranches(r.remote), []);
});
