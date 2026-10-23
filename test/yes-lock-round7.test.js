'use strict';

// Codex review round 7 on #1483 found four outward commands that reading
// commands kind by kind let through. A run woken by a handoff now guards git
// push (test/yes-lock-push-only.test.js); these keep the push, tag, mirror,
// and followTags cases. Pushes here go to a network origin, since a push to a
// repo on disk runs as written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const yesLock = require('../lib/yes-lock');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of Object.keys(GIT_ENV)) if (/^GIT_CONFIG_/.test(k)) delete GIT_ENV[k];
const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// A repo on a feature branch with a bare origin, and a run under the handoff seal.
function world(t, { network = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-r7-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const origin = path.join(base, 'origin.git');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('tag', 'v1');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'master');
  git('checkout', '-q', '-b', 'feature');
  git('commit', '-q', '--allow-empty', '-m', 'work');
  if (network) git('remote', 'set-url', 'origin', 'git@github.com:example/repo.git');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(stateDir, 'm-woken', { seal });
  const verdict = (tool, args, cwd = root) => yesLock.check({ stateDir, missionId: 'm-woken', seal, tool, args, gitBin, cwd, env: GIT_ENV });
  const onOrigin = ref => spawnSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: origin }).status === 0;
  return { base, root, origin, stateDir, seal, git, verdict, onOrigin };
}

const held = v => Boolean(v && v.hold);
const runs = v => !v || (!v.hold && !v.consume);

// ---- codex's four cases ----------------------------------------------------------

test('codex 1: atris business deploy is held', (t) => {
  const w = world(t);
  assert.ok(held(w.verdict('atris', ['business', 'deploy', 'acme'])));
  assert.ok(held(w.verdict('atris', ['business', 'status'])), 'every business verb waits; business is not on the list');
});

test('codex 2: with push.followTags on, a branch push never takes a tag along', (t) => {
  const w = world(t);
  w.git('config', 'push.followTags', 'true');
  w.git('tag', '-a', 'v9.9.9', '-m', 'release');
  const v = w.verdict('git', ['push', 'origin', 'feature']);
  assert.ok(runs(v), JSON.stringify(v));
  assert.ok(v && v.args && v.args.includes('--no-follow-tags'), 'the real push runs with --no-follow-tags');
  assert.ok(v.args.includes('push.followTags=false'));
  assert.ok(held(w.verdict('git', ['push', '--follow-tags', 'origin', 'feature'])));
});

test('codex 3: a mirror remote is held, and origin set up as a mirror is held', (t) => {
  const w = world(t);
  const other = 'git@github.com:example/mirror.git';
  // adding the remote is local; the push to it is what waits
  assert.ok(runs(w.verdict('git', ['remote', 'add', '--mirror=push', 'mirror', other])));
  w.git('remote', 'add', '--mirror=push', 'mirror', other);
  assert.ok(held(w.verdict('git', ['push', 'mirror'])));
  assert.ok(held(w.verdict('git', ['push', 'mirror', 'feature'])));
  w.git('config', 'remote.origin.mirror', 'true');
  assert.ok(held(w.verdict('git', ['push', 'origin', 'feature'])), 'origin as a mirror pushes everything');
});

// ---- the push's edges --------------------------------------------------------------

test('git: a branch push to origin runs, rewritten so it cannot carry tags or follow a mirror', (t) => {
  const w = world(t);
  assert.deepEqual(w.verdict('git', ['push', '-u', 'origin', 'feature']).args,
    ['-c', 'push.followTags=false', '-c', 'remote.origin.mirror=false', '-c', 'push.pushOption=', 'push', '--no-follow-tags', '-u', 'origin', 'refs/heads/feature:refs/heads/feature']);
  assert.ok(runs(w.verdict('git', ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/feature'])), 'the form gh pr create uses');
  assert.ok(runs(w.verdict('git', ['push', '-q', 'origin', 'HEAD:refs/heads/new-branch'])));
  for (const args of [
    ['push', 'origin', 'master'],
    ['push', 'origin', 'HEAD:refs/heads/master'],
    ['push', 'origin', 'HEAD:master'],
    ['push', 'origin', 'feature:master'],
    ['push', 'origin', 'refs/heads/master'],
    ['push', 'origin', 'master/sub'],
    ['push', 'origin', 'MASTER'],
    ['push', 'origin', 'HEAD:refs/heads/Master'],
    ['push', 'origin'],
    ['push'],
    ['push', '--tags', 'origin'],
    ['push', 'origin', 'v1'],
    ['push', 'origin', 'refs/tags/v1'],
    ['-c', 'push.followTags=true', 'push', 'origin', 'feature'],
  ]) assert.ok(held(w.verdict('git', args)), args.join(' '));
  for (const args of [['push', 'origin', 'HEAD'], ['push', '--force', 'origin', 'feature'], ['push', 'origin', '+feature'], ['push', 'origin', 'feature', 'other']]) {
    assert.ok(runs(w.verdict('git', args)), `${args.join(' ')}: a branch push that is not master`);
  }
});

test('gh: reads, pr create and pr comment run; merge, release and api writes are held', (t) => {
  const w = world(t);
  for (const args of [['pr', 'create', '--fill'], ['pr', 'view', '5'], ['pr', 'checks', '5'], ['pr', 'comment', '5', '-b', 'hi'], ['pr', 'list'],
    ['run', 'view', '1'], ['api', 'repos/o/r/pulls/5'], ['api', '-X', 'GET', 'repos/o/r'], ['--version']]) {
    assert.ok(runs(w.verdict('gh', args)), args.join(' '));
  }
  for (const args of [['pr', 'merge', '5'], ['pr', 'edit', '5'], ['pr', 'close', '5'], ['pr', 'review', '5'], ['pr', 'checkout', '5'],
    ['release', 'create', 'v1'], ['api', '-X', 'POST', 'repos/o/r/issues'], ['api', 'repos/o/r/pulls/5/merge', '-X', 'PUT'],
    ['api', 'graphql', '-f', 'query=mutation{x}'], ['issue', 'create'], ['repo', 'delete', 'o/r'], ['workflow', 'run', 'x'], ['frob']]) {
    assert.ok(held(w.verdict('gh', args)), args.join(' '));
  }
});

test('npm, yarn, pnpm: install, ci, test, run, ls and view run; publish, version and dist-tag are held', (t) => {
  const w = world(t);
  for (const [tool, args] of [['npm', ['install']], ['npm', ['ci']], ['npm', ['test']], ['npm', ['run', 'build']], ['npm', ['ls']],
    ['npm', ['view', 'atris', 'version']], ['yarn', ['install']], ['yarn', ['test']], ['pnpm', ['install']], ['pnpm', ['run', 'build']]]) {
    assert.ok(runs(w.verdict(tool, args)), `${tool} ${args.join(' ')}`);
  }
  for (const [tool, args] of [['npm', ['publish']], ['npm', ['version', 'patch']], ['npm', ['dist-tag', 'add', 'atris@1.0.0', 'latest']],
    ['npm', ['exec', 'x']], ['npm', ['pack']], ['yarn', ['publish']], ['pnpm', ['publish']], ['npx', ['np']], ['npm', ['--heading', 'x', 'test']]]) {
    assert.ok(held(w.verdict(tool, args)), `${tool} ${args.join(' ')}`);
  }
});

test('a held command in a woken run is one yes card, and the yes lets that one command run once', (t) => {
  const w = world(t);
  const v = w.verdict('git', ['push', 'origin', 'master']);
  assert.ok(held(v));
  assert.match(v.message, /^held: a handed-off job wants to git push origin master\./);
  assert.match(v.message, /git push origin <branch>/, 'the message says how a branch push runs without a yes');
  const cards = yesLock.askedYesLocks(w.stateDir, 'm-woken');
  assert.equal(cards.length, 1, 'one command, one card');
  yesLock.approveYesLock(w.stateDir, 'm-woken', cards[0].step, w.seal, undefined, { hash: cards[0].hash });
  const once = w.verdict('git', ['push', 'origin', 'master']);
  assert.ok(once.consume, 'the yes lets it run');
  assert.equal(once.args, undefined, 'a command the owner said yes to runs as written');
  assert.ok(held(w.verdict('git', ['push', 'origin', 'master'])), 'once');
});

// ---- bets keep reading commands by kind, with the same four holes closed --------------

function fakeGit(over = {}) {
  const ctx = {
    currentBranch: () => over.branch || 'feature',
    isTag: () => false,
    isBranch: n => ['master', 'main', 'feature'].includes(n),
    pushDest: () => null,
    remotePushSpecs: () => [],
    config: k => (over.config || {})[k] || '',
    alias: () => null,
    envConfigKeys: () => [],
    forRepo: () => ctx,
  };
  return ctx;
}

test('bet locks: the same four commands are read as what they touch', () => {
  assert.ok(yesLock.analyze('atris', ['business', 'deploy', 'acme']).cats.includes('deploy'));
  assert.deepEqual(yesLock.analyze('atris', ['business', 'status']), { cats: [], refuse: null });
  assert.ok(yesLock.analyze('git', ['push', 'origin', 'feature'], fakeGit({ config: { 'push.followTags': 'true' } })).cats.includes('tag'));
  assert.deepEqual(yesLock.analyze('git', ['push', '--no-follow-tags', 'origin', 'feature'], fakeGit({ config: { 'push.followTags': 'true' } })).cats, []);
  assert.ok(yesLock.analyze('git', ['push', 'mirror'], fakeGit({ config: { 'remote.mirror.mirror': 'true' } })).refuse);
  assert.ok(yesLock.analyze('git', ['symbolic-ref', 'refs/heads/master', 'refs/heads/feature'], fakeGit()).cats.includes('merge'));
  assert.deepEqual(yesLock.analyze('git', ['symbolic-ref', '--short', 'HEAD'], fakeGit()), { cats: [], refuse: null }, 'reading HEAD still runs');
});
