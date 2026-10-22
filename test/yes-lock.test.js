'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const yesLock = require('../lib/yes-lock');
const { prepareMissionGitGuard } = require('../lib/mission-protected-lane');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

// A repo with a bare remote, a state folder outside it, and stand-in npm,
// gh, and atris that only say what they were asked.
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-lock-'));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  const stateDir = path.join(base, 'state');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('tag', 'v1.0.0');
  git('remote', 'add', 'origin', remote);
  for (const tool of ['npm', 'gh', 'atris', 'npx']) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "ran ${tool} $*"\n`, { mode: 0o755 });
  const gitDir = path.dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
  const pathValue = [bin, path.dirname(process.execPath), gitDir, '/usr/bin', '/bin'].join(path.delimiter);
  return { root, stateDir, pathValue, git };
}

function runner(root, guard) {
  return cmd => spawnSync('sh', ['-c', cmd], { cwd: root, env: { ...guard.env, ...GIT_ENV, PATH: guard.env.PATH }, encoding: 'utf8' });
}

const STEPS = [
  { text: 'draft the release notes', who: 'team', member: 'builder', public: false },
  { text: 'release the gm game to npm', who: 'you', public: true },
  { text: 'post the clip and the show hn link', who: 'you', public: true },
];

test('yes lock: a held publish exits 77 and files the yes card; the yes lets exactly that step through, once', () => {
  const { root, stateDir, pathValue } = setup();
  const seal = yesLock.sealFor(STEPS);
  assert.deepEqual(seal.map(l => [l.step, l.categories]), [[2, ['publish', 'tag']], [3, ['post']]]);
  yesLock.writeYesLocks(stateDir, 'mission-x', { betId: 'bet-1', seal });
  const guard = prepareMissionGitGuard({ root, missionId: 'mission-x', yesLockSeal: seal, stateDir, pathValue });
  const run = runner(root, guard);
  try {
    // ordinary work runs as usual
    assert.equal(run('npm test').stdout.trim(), 'ran npm test');
    assert.equal(run('gh pr view 3').stdout.trim(), 'ran gh pr view 3');
    // the owner's steps are held, with a plain message, before the real tool runs
    const held = run('npm publish --access public');
    assert.equal(held.status, 77);
    assert.equal(held.stdout, '', 'the real npm never ran');
    assert.match(held.stderr, /^held: "npm publish --access public" would publish or release a package, and step 2 \("release the gm game to npm"\) needs the owner's yes first\. a yes card is now on the owner's phone\./);
    assert.equal(run('atris twitter post "we shipped"').status, 77);
    // pushing a branch is not an owner step in this bet
    assert.equal(run('git push -q origin master').status, 0);
    assert.deepEqual(yesLock.askedYesLocks(stateDir, 'mission-x').map(l => [l.step, l.held_command]), [[2, 'npm publish --access public'], [3, 'atris twitter post we shipped']], 'each card shows the command it would let through');
    // yes on step 2 lets that one command through once, and only step 2
    yesLock.approveYesLock(stateDir, 'mission-x', 2, seal);
    assert.equal(run('npm publish --access public').stdout.trim(), 'ran npm publish --access public');
    assert.equal(run('npm publish --access public').status, 77, 'the yes was used; a second publish needs its own');
    assert.equal(run('atris twitter post "we shipped"').status, 77, 'the post still waits for its own yes');
    // a release and a tag push each need a yes for that exact command
    assert.equal(run('gh release create v1.0.0').status, 77);
    yesLock.approveYesLock(stateDir, 'mission-x', 2, seal);
    assert.equal(run('gh release create v1.0.0').stdout.trim(), 'ran gh release create v1.0.0');
    assert.equal(run('git push origin v1.0.0').status, 77, 'a tag pushed by name is a tag push');
    yesLock.approveYesLock(stateDir, 'mission-x', 2, seal);
    assert.equal(run('git push origin --tags').status, 77, '--tags is closed outright, even with a yes');
    assert.equal(run('git push -q origin v1.0.0').status, 77, 'asking for --tags replaced the yes for the named tag');
    yesLock.approveYesLock(stateDir, 'mission-x', 2, seal);
    assert.equal(run('git push -q origin v1.0.0').status, 0, 'one named tag, with its own yes');
  } finally {
    guard.cleanup();
  }
});

test('yes lock: a mission with no seal runs free, and the seal must come with the mission record', () => {
  const { root, stateDir, pathValue } = setup();
  const free = prepareMissionGitGuard({ root, missionId: 'mission-free', pathValue, stateDir });
  try {
    assert.equal(runner(root, free)('npm publish').stdout.trim(), 'ran npm publish');
    assert.equal(fs.existsSync(path.join(free.pathPrefix, 'npm')), false, 'no seal, no wrappers beyond git');
  } finally {
    free.cleanup();
  }
});

// ---- reading commands, without a repo -------------------------------------------------

function fakeGit(over = {}) {
  const ctx = {
    currentBranch: () => over.branch || 'feature',
    isTag: n => (over.tags || []).includes(n),
    isBranch: n => ['master', 'main', 'feature'].includes(n),
    pushDest: () => over.pushDest || null,
    remotePushSpecs: () => over.pushSpecs || [],
    config: k => (over.config || {})[k] || '',
    alias: n => (over.aliases || {})[n] || null,
    envConfigKeys: () => over.envKeys || [],
    forRepo: () => (over.repo ? fakeGit(over.repo) : ctx),
  };
  return ctx;
}

test('yes lock: what each command touches, after options are skipped', () => {
  const a = (tool, args, ctx) => yesLock.analyze(tool, args, ctx);
  assert.deepEqual(a('npm', ['--registry', 'x', 'publish']).cats, ['publish']);
  assert.deepEqual(a('pnpm', ['publish', '--no-git-checks']).cats, ['publish']);
  assert.deepEqual(a('npm', ['dist-tag', 'add', 'atris@3.72.0', 'latest']).cats, ['publish']);
  assert.match(a('npm', ['exec', '--', 'npm', 'publish']).refuse, /can run any command/);
  assert.match(a('pnpm', ['dlx', 'np']).refuse, /can run any command/);
  assert.match(a('npm', ['set-script', 'x']).refuse, /not on the list/);
  assert.match(a('npm', ['pack']).refuse, /use --dry-run/);
  assert.deepEqual(a('npm', ['pack', '--dry-run']), { cats: [], refuse: null });
  assert.deepEqual(a('npm', ['run', 'test']), { cats: [], refuse: null });
  assert.deepEqual(a('gh', ['release', 'create', 'v1']).cats, ['publish']);
  assert.deepEqual(a('gh', ['-R', 'o/r', 'pr', 'merge', '3']).cats, ['merge']);
  assert.deepEqual(a('gh', ['issue', 'comment', '3', '-b', 'hi']).cats, ['post']);
  assert.deepEqual(a('gh', ['api', 'repos/o/r/pulls']), { cats: [], refuse: null });
  assert.deepEqual(a('gh', ['api', '-X', 'POST', 'repos/o/r/git/refs', '-f', 'ref=refs/tags/v2']).cats, ['tag', 'merge']);
  assert.match(a('gh', ['api', '-X', 'DELETE', 'repos/o/r']).refuse, /gh api with a write/);
  assert.match(a('gh', ['repo', 'delete', 'o/r']).refuse, /not on the list/);
  assert.deepEqual(a('git', ['push', 'origin', 'feature:main'], fakeGit()).cats, ['merge']);
  assert.deepEqual(a('git', ['push', 'origin', 'HEAD'], fakeGit({ branch: 'master' })).cats, ['merge']);
  assert.deepEqual(a('git', ['push'], fakeGit({ pushDest: 'origin/main' })).cats, ['merge']);
  assert.deepEqual(a('git', ['push'], fakeGit({ config: { 'push.followTags': 'true' } })).cats, ['tag']);
  assert.deepEqual(a('git', ['push', 'origin', 'refs/heads/*:refs/heads/*'], fakeGit()).cats, ['merge', 'tag']);
  assert.match(a('git', ['push', 'origin', ':'], fakeGit()).refuse, /every matching branch/);
  assert.match(a('git', ['push'], fakeGit({ envKeys: ['remote.origin.push'] })).refuse, /remote\.origin\.push/);
  assert.match(a('git', ['doit'], fakeGit({ aliases: { doit: '!git push origin HEAD:master' } })).refuse, /alias that runs a shell command/);
  assert.deepEqual(a('git', ['update-ref', 'refs/heads/main', 'abc'], fakeGit()).cats, ['merge']);
  assert.deepEqual(a('git', ['branch', '-f', 'master', 'feature'], fakeGit()).cats, ['merge']);
  assert.deepEqual(a('git', ['status'], fakeGit()), { cats: [], refuse: null });
  assert.deepEqual(a('atris', ['slack', 'send', 'C1', 'hi']).cats, ['send', 'post']);
  assert.deepEqual(a('atris', ['mission', 'ping', 'm', 'x']), { cats: [], refuse: null });
  assert.match(a('npx', ['np']).refuse, /can run any command/);
  assert.deepEqual(a('curl', ['-X', 'POST', 'https://api.example.com']), { cats: [], refuse: null }, 'a direct call to an API is not one of the named commands');
  assert.deepEqual(yesLock.stepLocks('publish the page and post the recording on x'), ['publish', 'tag', 'post']);
  assert.deepEqual(yesLock.stepLocks('approve the prize'), [], 'nothing a command can be told apart for');
});

test('yes lock: mission start seals the owner steps into the mission record, and refuses a bad seal', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-seal-'));
  fs.mkdirSync(path.join(ws, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'atris', 'team', 'builder', 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const start = extra => spawnSync(process.execPath, [cli, 'mission', 'start', 'write the page', '--owner', 'builder', '--runner', 'manual', '--verify', 'test -s page.md', ...extra, '--json'], { cwd: ws, env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  const seal = [{ step: 3, text: 'publish the page', categories: ['publish', 'tag'] }];
  const ok = start(['--yes-lock', JSON.stringify(seal)]);
  assert.equal(ok.status, 0, ok.stderr);
  const rows = fs.readFileSync(path.join(ws, '.atris', 'state', 'missions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const mission = rows[rows.length - 1];
  assert.deepEqual(mission.yes_locks.steps, seal);
  assert.ok(mission.yes_locks.sealed_at);
  assert.doesNotMatch(mission.objective, /yes-lock|publish the page/, 'the seal is not part of the objective text');
  const bad = start(['--yes-lock', JSON.stringify([{ step: 1, categories: ['launch-rockets'] }])]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /--yes-lock takes a JSON list/);
});
