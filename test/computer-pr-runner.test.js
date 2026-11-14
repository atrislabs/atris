'use strict';

// Runs the real lib/computer-pr-runner.sh against a throwaway local git repo:
// two runs side by side on one shared copy, failures, the stale sweep, and the
// old-clone report. Everything lives in one temp folder, removed at the end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const prLib = require('../lib/computer-pr');

const skip = process.platform === 'win32' ? 'needs bash and git' : false;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function du(p) {
  return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split(/\s+/)[0]);
}

function setup() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pr-runner-')));
  const remote = path.join(tmp, 'remote', 'acme', 'shop.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(remote, { recursive: true });
  git(remote, 'init', '--bare', '--quiet', '-b', 'main');
  fs.mkdirSync(seed);
  git(seed, 'init', '--quiet', '-b', 'main');
  // About 4 MB of files that do not compress, so a full copy shows its real cost.
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(seed, `blob-${i}.bin`), require('node:crypto').randomBytes(100 * 1024));
  fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '--quiet', 'origin', 'main');
  const repos = path.join(tmp, 'repos');
  const root = path.join(repos, '.atris-pr');
  const script = path.join(root, 'bin', path.basename(prLib.PR_SCRIPT_PATH));
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, prLib.PR_SCRIPT);
  const env = { ...process.env, ATRIS_PR_ROOT: root, ATRIS_PR_REMOTE_BASE: `file://${path.join(tmp, 'remote')}`, ATRIS_PR_LOCK_WAIT: '60' };
  delete env.GITHUB_TOKEN;
  return { tmp, remote, seed, repos, root, script, env };
}

function run(ctx, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [ctx.script, ...args], { env: { ...ctx.env, ...extraEnv } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function value(out, key) {
  const m = out.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1] : null;
}

function setOld(p) {
  const when = new Date(Date.now() - 24 * 3600 * 1000);
  const walk = (q) => {
    const st = fs.lstatSync(q);
    if (st.isDirectory()) for (const e of fs.readdirSync(q)) walk(path.join(q, e));
    fs.lutimesSync(q, when, when);
  };
  walk(p);
}

test('two runs share one repo copy, push their own branches, and leave nothing behind', { skip }, async (t) => {
  const ctx = setup();
  t.after(() => fs.rmSync(ctx.tmp, { recursive: true, force: true }));

  const [a, b] = await Promise.all([
    run(ctx, ['prepare', 'acme', 'shop', 'atris/one-20261114-0900-aaaa']),
    run(ctx, ['prepare', 'acme', 'shop', 'atris/two-20261114-0900-bbbb']),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const dirA = value(a.stdout, 'RUN_DIR');
  const dirB = value(b.stdout, 'RUN_DIR');
  assert.notEqual(dirA, dirB);
  assert.equal(value(a.stdout, 'DEFAULT_BRANCH'), 'main');
  assert.equal(value(b.stdout, 'BASE'), 'main');
  const mirrors = fs.readdirSync(path.join(ctx.root, 'mirrors')).filter((n) => n.endsWith('.git'));
  assert.deepEqual(mirrors, ['acme__shop.git'], 'one shared copy for both runs');
  assert.equal(git(dirA, 'rev-parse', '--abbrev-ref', 'HEAD'), 'atris/one-20261114-0900-aaaa');
  assert.equal(git(dirB, 'rev-parse', '--abbrev-ref', 'HEAD'), 'atris/two-20261114-0900-bbbb');

  // Disk: a full clone against one run folder off the shared copy.
  const full = path.join(ctx.tmp, 'full-clone');
  git(ctx.tmp, 'clone', '--quiet', ctx.remote, full);
  const sizes = { fullCloneKb: du(full), runFolderKb: du(dirA), sharedCopyKb: du(path.join(ctx.root, 'mirrors', 'acme__shop.git')) };
  t.diagnostic(`disk per run: full clone ${sizes.fullCloneKb} KB, run folder ${sizes.runFolderKb} KB, shared copy (once per repo) ${sizes.sharedCopyKb} KB`);
  assert.ok(sizes.runFolderKb < sizes.fullCloneKb * 0.7, JSON.stringify(sizes));

  fs.writeFileSync(path.join(dirA, 'README.md'), 'hello from one\n');
  fs.writeFileSync(path.join(dirB, 'NEW.md'), 'from two\n');
  for (const d of [dirA, dirB]) {
    git(d, 'add', '-A');
    git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'change');
  }
  const [fa, fb] = await Promise.all([
    run(ctx, ['finish', dirA, 'atris/one-20261114-0900-aaaa']),
    run(ctx, ['finish', dirB, 'atris/two-20261114-0900-bbbb']),
  ]);
  assert.equal(fa.code, 0, fa.stderr);
  assert.equal(fb.code, 0, fb.stderr);
  assert.equal(value(fa.stdout, 'PUSHED'), 'atris/one-20261114-0900-aaaa');
  assert.match(value(fb.stdout, 'COMMIT'), /^[0-9a-f]{40}$/);
  const remoteHeads = git(ctx.remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
  assert.match(remoteHeads, /atris\/one-20261114-0900-aaaa/);
  assert.match(remoteHeads, /atris\/two-20261114-0900-bbbb/);
  assert.equal(git(ctx.remote, 'show', 'atris/one-20261114-0900-aaaa:README.md'), 'hello from one');

  // Nothing left: no run folders, no worktrees, no local run branches.
  assert.ok(!fs.existsSync(dirA) && !fs.existsSync(dirB));
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, 'runs')), []);
  const mirror = path.join(ctx.root, 'mirrors', 'acme__shop.git');
  assert.equal(git(mirror, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads'), '');
});

test('failures clean up after themselves and never lose a commit', { skip }, async (t) => {
  const ctx = setup();
  t.after(() => fs.rmSync(ctx.tmp, { recursive: true, force: true }));
  const mirror = path.join(ctx.root, 'mirrors', 'acme__shop.git');

  // A base branch that does not exist: the trap removes the half-made run.
  const bad = await run(ctx, ['prepare', 'acme', 'shop', 'atris/x-1', 'nope']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /branch nope is not on the remote/);
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, 'runs')), []);
  assert.equal(git(mirror, 'for-each-ref', 'refs/heads'), '');

  // No change: finish says so, exits 3, and removes the folder and branch.
  let p = await run(ctx, ['prepare', 'acme', 'shop', 'atris/x-2']);
  let dir = value(p.stdout, 'RUN_DIR');
  const none = await run(ctx, ['finish', dir, 'atris/x-2']);
  assert.equal(none.code, 3);
  assert.match(none.stdout, /NO_CHANGES=1/);
  assert.ok(!fs.existsSync(dir));
  assert.equal(git(mirror, 'for-each-ref', 'refs/heads'), '');

  // Uncommitted work: finish refuses and leaves the folder so it can be committed.
  p = await run(ctx, ['prepare', 'acme', 'shop', 'atris/x-3']);
  dir = value(p.stdout, 'RUN_DIR');
  fs.writeFileSync(path.join(dir, 'README.md'), 'dirty\n');
  const dirty = await run(ctx, ['finish', dir, 'atris/x-3']);
  assert.equal(dirty.code, 1);
  assert.match(dirty.stderr, /not committed yet/);
  assert.ok(fs.existsSync(dir));
  // Abort with no commit removes it and drops the empty branch.
  const ab = await run(ctx, ['abort', dir]);
  assert.equal(ab.code, 0, ab.stderr);
  assert.ok(!fs.existsSync(dir));
  assert.equal(git(mirror, 'for-each-ref', 'refs/heads'), '');

  // The same branch name twice at once: the second is refused, not shared.
  p = await run(ctx, ['prepare', 'acme', 'shop', 'atris/x-4']);
  dir = value(p.stdout, 'RUN_DIR');
  const twice = await run(ctx, ['prepare', 'acme', 'shop', 'atris/x-4']);
  assert.notEqual(twice.code, 0);
  assert.match(twice.stderr, /already exists on this computer/);
  assert.equal(fs.readdirSync(path.join(ctx.root, 'runs')).length, 1);

  // Push fails (the remote already has a different atris/x-4): folder removed,
  // branch kept in the shared copy so the commit survives.
  git(ctx.seed, 'checkout', '--quiet', '-b', 'atris/x-4');
  fs.writeFileSync(path.join(ctx.seed, 'OTHER.md'), 'other\n');
  git(ctx.seed, 'add', '-A');
  git(ctx.seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'other');
  git(ctx.seed, 'push', '--quiet', 'origin', 'atris/x-4');
  fs.writeFileSync(path.join(dir, 'README.md'), 'mine\n');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-am', 'mine');
  const mine = git(dir, 'rev-parse', 'HEAD');
  const rejected = await run(ctx, ['finish', dir, 'atris/x-4']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /push of atris\/x-4 failed/);
  assert.match(rejected.stdout, /KEPT_BRANCH=atris\/x-4/);
  assert.ok(!fs.existsSync(dir));
  assert.equal(git(mirror, 'rev-parse', 'refs/heads/atris/x-4'), mine);
  assert.equal(git(mirror, 'worktree', 'list').split('\n').length, 1);
});

test('the sweep removes only stale run folders and only reports old clones', { skip }, async (t) => {
  const ctx = setup();
  t.after(() => fs.rmSync(ctx.tmp, { recursive: true, force: true }));

  // A run left behind by a crash, with nothing changed for a day.
  const first = await run(ctx, ['prepare', 'acme', 'shop', 'atris/old-run']);
  const stale = value(first.stdout, 'RUN_DIR');
  // A run still in use.
  const live = await run(ctx, ['prepare', 'acme', 'shop', 'atris/live-run']);
  const fresh = value(live.stdout, 'RUN_DIR');
  setOld(stale);
  // An old-style full clone next to the shared folder, and an outside folder.
  const oldClone = path.join(ctx.repos, 'shop--atris-earlier');
  git(ctx.tmp, 'clone', '--quiet', ctx.remote, oldClone);
  setOld(oldClone);
  const outside = path.join(ctx.tmp, 'not-ours');
  fs.mkdirSync(outside);
  setOld(outside);

  const next = await run(ctx, ['prepare', 'acme', 'shop', 'atris/next-run']);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /SWEPT=1 old run folders/);
  assert.match(next.stdout, /OLD_CLONES=1 full copies use about \d+ MB/);
  assert.ok(!fs.existsSync(stale), 'stale run removed');
  assert.ok(fs.existsSync(fresh), 'live run kept');
  assert.ok(fs.existsSync(path.join(oldClone, '.git')), 'old clone untouched');
  assert.ok(fs.existsSync(outside), 'outside folder untouched');
  const mirror = path.join(ctx.root, 'mirrors', 'acme__shop.git');
  const listed = git(mirror, 'worktree', 'list');
  assert.ok(!listed.includes(stale), 'stale worktree pruned');
  // The stale run had no commits, but its branch stays; refs cost nothing and
  // a crash may have left work on one.
  assert.match(git(mirror, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), /atris\/old-run/);
});

test('the script refuses a changed copy and a root that is not its own', { skip }, async (t) => {
  const ctx = setup();
  t.after(() => fs.rmSync(ctx.tmp, { recursive: true, force: true }));
  // Trailing spaces and a missing last newline are fine.
  fs.writeFileSync(ctx.script, prLib.PR_SCRIPT.replace(/\n$/, '').replace('set -eu', 'set -eu   '));
  let r = await run(ctx, ['prepare', 'acme', 'shop', 'atris/ok']);
  assert.equal(r.code, 0, r.stderr);
  fs.writeFileSync(ctx.script, prLib.PR_SCRIPT.replace('STALE_MINUTES:-360', 'STALE_MINUTES:-1'));
  r = await run(ctx, ['prepare', 'acme', 'shop', 'atris/changed']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /script check failed/);
  fs.writeFileSync(ctx.script, prLib.PR_SCRIPT);
  r = await run(ctx, ['prepare', 'acme', 'shop', 'atris/elsewhere'], { ATRIS_PR_ROOT: ctx.repos });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ROOT must end in \.atris-pr/);
  r = await run(ctx, ['abort', ctx.repos]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not a run folder/);
});

// macOS has no flock, so the tests above use the mkdir lock. Here a small
// stand-in flock (same -w <seconds> <fd> form, real kernel file locks) proves
// the flock path the Linux cloud computer takes.
test('the flock path serializes two runs on one repo', { skip }, async (t) => {
  const ctx = setup();
  t.after(() => fs.rmSync(ctx.tmp, { recursive: true, force: true }));
  const bin = path.join(ctx.tmp, 'bin');
  const log = path.join(ctx.tmp, 'flock.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'flock'), [
    '#!/usr/bin/env python3',
    'import fcntl, os, sys, time',
    'wait, fd = float(sys.argv[2]), int(sys.argv[3])',
    'end = time.time() + wait',
    'while True:',
    '    try:',
    '        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    '        break',
    '    except BlockingIOError:',
    '        if time.time() > end: sys.exit(1)',
    '        time.sleep(0.05)',
    `open(${JSON.stringify(log)}, 'a').write('got %d\\n' % os.getppid())`,
  ].join('\n'), { mode: 0o755 });
  const PATH = `${bin}:${process.env.PATH}`;
  const [a, b] = await Promise.all([
    run(ctx, ['prepare', 'acme', 'shop', 'atris/f-1'], { PATH }),
    run(ctx, ['prepare', 'acme', 'shop', 'atris/f-2'], { PATH }),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.ok(fs.readFileSync(log, 'utf8').trim().split('\n').length >= 2, 'flock was used by both runs');
  assert.ok(!fs.existsSync(path.join(ctx.root, 'mirrors', 'acme__shop.lock.d')), 'the mkdir lock was not used');
  for (const r of [a, b]) {
    const dir = value(r.stdout, 'RUN_DIR');
    const out = await run(ctx, ['abort', dir], { PATH });
    assert.equal(out.code, 0, out.stderr);
  }
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, 'runs')), []);
});
