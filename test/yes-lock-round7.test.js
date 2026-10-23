'use strict';

// Codex review round 7 on #1483 found four outward commands that reading
// commands kind by kind let through. A run woken by a handoff now runs on an
// allowlist: only the commands named in lib/yes-lock.js run without a yes,
// and everything else is held as a yes card.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const yesLock = require('../lib/yes-lock');
const { prepareMissionGitGuard } = require('../lib/mission-protected-lane');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of Object.keys(GIT_ENV)) if (/^GIT_CONFIG_/.test(k)) delete GIT_ENV[k];
const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// A repo on a feature branch with a bare origin, and a run under the handoff seal.
function world(t) {
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
  // through the real wrapper and the real git
  const pathValue = [path.dirname(process.execPath), path.dirname(gitBin), '/usr/bin', '/bin'].join(path.delimiter);
  const guard = prepareMissionGitGuard({ root: w.root, missionId: 'm-woken', yesLockSeal: w.seal, stateDir: w.stateDir, pathValue });
  t.after(() => guard.cleanup());
  const res = spawnSync('sh', ['-c', 'git push -q origin feature'], { cwd: w.root, env: { ...GIT_ENV, PATH: guard.env.PATH }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(w.onOrigin('refs/heads/feature'), 'the branch reached origin');
  assert.equal(w.onOrigin('refs/tags/v9.9.9'), false, 'the annotated tag did not');
});

test('codex 3: a mirror remote is held, and origin set up as a mirror is held', (t) => {
  const w = world(t);
  const other = path.join(w.base, 'mirror.git');
  execFileSync('git', ['init', '-q', '--bare', other]);
  assert.ok(held(w.verdict('git', ['remote', 'add', '--mirror=push', 'mirror', other])));
  // the job can still write the config file itself, so the push is read too
  w.git('remote', 'add', '--mirror=push', 'mirror', other);
  assert.ok(held(w.verdict('git', ['push', 'mirror'])));
  assert.ok(held(w.verdict('git', ['push', 'mirror', 'feature'])));
  w.git('config', 'remote.origin.mirror', 'true');
  assert.ok(held(w.verdict('git', ['push', 'origin', 'feature'])), 'origin as a mirror pushes everything');
});

test('codex 4: git symbolic-ref onto master is held', (t) => {
  const w = world(t);
  assert.ok(held(w.verdict('git', ['symbolic-ref', 'refs/heads/master', 'refs/heads/feature'])));
  assert.ok(held(w.verdict('git', ['symbolic-ref', 'HEAD', 'refs/heads/master'])));
});

// ---- the allowlist's edges ----------------------------------------------------------

test('git: a branch push to origin runs, rewritten so it cannot carry tags or follow a mirror', (t) => {
  const w = world(t);
  assert.deepEqual(w.verdict('git', ['push', '-u', 'origin', 'feature']).args,
    ['-c', 'push.followTags=false', '-c', 'remote.origin.mirror=false', '-c', 'push.pushOption=', 'push', '--no-follow-tags', '--set-upstream', 'origin', 'refs/heads/feature:refs/heads/feature']);
  assert.ok(runs(w.verdict('git', ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/feature'])), 'the form gh pr create uses');
  assert.ok(runs(w.verdict('git', ['push', '-q', 'origin', 'HEAD:refs/heads/new-branch'])));
  for (const args of [
    ['push', 'origin', 'master'],
    ['push', 'origin', 'HEAD:refs/heads/master'],
    ['push', 'origin', 'HEAD:master'],
    ['push', 'origin', 'feature:master'],
    ['push', 'origin', 'refs/heads/master'],
    ['push', 'origin', 'master/sub'],
    ['push', 'origin', 'HEAD'],
    ['push', 'origin'],
    ['push'],
    ['push', '--force', 'origin', 'feature'],
    ['push', 'origin', '+feature'],
    ['push', '--tags', 'origin'],
    ['push', 'origin', 'v1'],
    ['push', 'origin', 'refs/tags/v1'],
    ['push', 'origin', 'feature', 'other'],
    ['push', 'other', 'feature'],
    ['-c', 'push.followTags=true', 'push', 'origin', 'feature'],
  ]) assert.ok(held(w.verdict('git', args)), args.join(' '));
  w.git('config', 'remote.origin.pushurl', path.join(w.base, 'elsewhere.git'));
  assert.ok(held(w.verdict('git', ['push', 'origin', 'feature'])), 'origin pushing somewhere else is held');
});

test('git: reads and local work run; anything that moves master, tags, or config is held', (t) => {
  const w = world(t);
  for (const args of [
    ['status'], ['diff', 'master'], ['log', '--oneline', '-3'], ['show', 'HEAD'], ['rev-parse', 'HEAD'], ['ls-files'],
    ['grep', 'x'], ['describe', '--always'], ['branch', '--list'], ['branch'], ['remote', '-v'], ['fetch', 'origin'], ['fetch'],
    ['add', '.'], ['rm', '--cached', 'x'], ['mv', 'a', 'b'], ['restore', '--source=master', 'x'], ['commit', '-m', 'x'],
    ['stash'], ['stash', 'pop'], ['checkout', '-b', 'next'], ['checkout', 'master', '--', 'file.js'], ['switch', '-c', 'next', 'origin/master'],
    ['branch', 'next', 'master'], ['branch', '-d', 'old'], ['config', '--get', 'user.name'], ['worktree', 'list'],
    ['worktree', 'add', '-b', 'next', '../wt', 'master'], ['-C', w.root, 'status'],
  ]) assert.ok(runs(w.verdict('git', args)), args.join(' '));
  for (const args of [
    ['checkout', 'master'], ['switch', 'master'], ['checkout', '-B', 'master'], ['switch', '-C', 'master'], ['branch', '-D', 'master'],
    ['branch', '-f', 'master', 'feature'], ['branch', '-m', 'master'], ['update-ref', 'refs/heads/next', 'HEAD'], ['replace', 'a', 'b'],
    ['tag', 'v2'], ['config', 'user.name', 'x'], ['config', 'alias.st', 'status'], ['remote', 'set-url', 'origin', 'x'],
    ['filter-branch', 'HEAD'], ['worktree', 'add', '../wt', 'master'], ['worktree', 'remove', '../wt'], ['fetch', 'origin', 'feature:master'],
    ['fetch', 'mirror'], ['fetch', '--all'], ['merge', 'master'], ['pull'], ['reset', '--hard', 'master'], ['send-pack', 'x'], ['frobnicate'],
    ['stash', 'branch', 'master'], ['--git-dir=.git', 'status'],
  ]) assert.ok(held(w.verdict('git', args)), args.join(' '));
  w.git('checkout', '-q', 'master');
  assert.ok(held(w.verdict('git', ['commit', '-m', 'x'])), 'a commit on master is held');
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
    ['npm', ['view', 'atris', 'version']], ['yarn', []], ['yarn', ['test']], ['pnpm', ['install']], ['pnpm', ['run', 'build']]]) {
    assert.ok(runs(w.verdict(tool, args)), `${tool} ${args.join(' ')}`);
  }
  for (const [tool, args] of [['npm', ['publish']], ['npm', ['version', 'patch']], ['npm', ['dist-tag', 'add', 'atris@1.0.0', 'latest']],
    ['npm', ['exec', 'x']], ['npm', ['pack']], ['yarn', ['publish']], ['pnpm', ['publish']], ['npx', ['np']], ['npm', ['--heading', 'x', 'test']]]) {
    assert.ok(held(w.verdict(tool, args)), `${tool} ${args.join(' ')}`);
  }
});

test('atris: the run\'s own machinery and reads run; outward and unknown verbs are held', (t) => {
  const w = world(t);
  for (const args of [['task', 'list'], ['task', 'note', 'T1', 'did it'], ['member', 'status'], ['member', 'handoff', 'a', 'b', 'next step'],
    ['mission', 'status', 'm-woken'], ['mission', 'tick', 'm-woken'], ['slop', 'detect', 'x.md'], ['verify'], ['status'], ['log', 'did it']]) {
    assert.ok(runs(w.verdict('atris', args)), args.join(' '));
  }
  for (const args of [['business', 'deploy', 'acme'], ['site', 'publish'], ['pay', 'vendor', '5'], ['feed', 'post', 'x'], ['deploy'], ['release'],
    ['frobnicate'], ['fix', 'the', 'bug'], ['member', 'run', 'builder', 'x'], ['member', 'wake', 'builder'], ['mission', 'start', 'x'],
    ['mission', 'tick', 'some-other-mission'], ['approve', '1'], ['land'], ['autoland'], ['--as', 'task', 'business', 'deploy']]) {
    assert.ok(held(w.verdict('atris', args)), args.join(' '));
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
