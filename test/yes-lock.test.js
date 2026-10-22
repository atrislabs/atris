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

// A repo with a bare remote, and stand-in npm, gh, and atris that only say
// what they were asked, so nothing ever leaves the machine.
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-lock-'));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('tag', 'v1.0.0');
  git('remote', 'add', 'origin', remote);
  for (const tool of ['npm', 'gh', 'atris']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "ran ${tool} $*"\n`, { mode: 0o755 });
  }
  const gitDir = path.dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
  const pathValue = [bin, path.dirname(process.execPath), gitDir, '/usr/bin', '/bin'].join(path.delimiter);
  return { root, pathValue, git };
}

function runner(root, guard) {
  return cmd => spawnSync('sh', ['-c', cmd], { cwd: root, env: { ...guard.env, ...GIT_ENV, PATH: guard.env.PATH }, encoding: 'utf8' });
}

const STEPS = [
  { text: 'draft the release notes', who: 'team', member: 'builder', public: false },
  { text: 'release the gm game to npm', who: 'you', public: true },
  { text: 'post the clip and the show hn link', who: 'you', public: true },
];

test('yes lock: a held publish exits 77 and files the yes card; the yes lets exactly that step through', () => {
  const { root, pathValue } = setup();
  const locks = yesLock.writeYesLocks(root, 'mission-x', { betId: 'bet-1', steps: STEPS });
  assert.deepEqual(locks.map(l => [l.step, l.categories]), [[2, ['publish', 'tag']], [3, ['post']]]);
  const guard = prepareMissionGitGuard({ root, missionId: 'mission-x', pathValue });
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
    assert.equal(run('gh release create v1.0.0').status, 77);
    assert.equal(run('git push origin --tags').status, 77);
    assert.equal(run('git push origin v1.0.0').status, 77, 'a tag pushed by name is a tag push');
    assert.equal(run('atris twitter post "we shipped"').status, 77);
    // pushing a branch is not an owner step in this bet
    assert.equal(run('git push -q origin master').status, 0);
    // the held steps are now yes cards
    assert.deepEqual(yesLock.askedYesLocks(root, 'mission-x').map(l => [l.step, l.held_command]), [[2, 'git push origin v1.0.0'], [3, 'atris twitter post we shipped']], 'each card shows the newest held command for its step');
    // yes on step 2 lets step 2 through, and only step 2
    yesLock.approveYesLock(root, 'mission-x', 2);
    assert.equal(run('npm publish --access public').stdout.trim(), 'ran npm publish --access public');
    assert.equal(run('gh release create v1.0.0').stdout.trim(), 'ran gh release create v1.0.0');
    assert.equal(run('git push -q origin --tags').status, 0);
    assert.equal(run('atris twitter post "we shipped"').status, 77, 'the post still waits for its own yes');
    assert.deepEqual(yesLock.askedYesLocks(root, 'mission-x').map(l => l.step), [3]);
  } finally {
    guard.cleanup();
  }
});

test('yes lock: merging to master is held only when a your-yes step says merge; jobs with no lock run free', () => {
  const { root, pathValue, git } = setup();
  yesLock.writeYesLocks(root, 'mission-m', { betId: 'bet-2', steps: [STEPS[0], { text: 'merge the change to master', who: 'you', public: false }] });
  const guard = prepareMissionGitGuard({ root, missionId: 'mission-m', pathValue });
  const run = runner(root, guard);
  try {
    git('checkout', '-q', '-b', 'feature');
    assert.equal(run('git push origin HEAD:master').status, 77);
    assert.equal(run('gh pr merge 3 --squash').status, 77);
    assert.equal(run('git push -q origin feature').status, 0);
    git('checkout', '-q', 'master');
    assert.equal(run('git merge feature').status, 77, 'merging into master locally is held too');
    assert.equal(run('npm publish').stdout.trim(), 'ran npm publish', 'this bet has no publish step');
  } finally {
    guard.cleanup();
  }
  // a mission with no lock file, and a guard with no mission, change nothing
  const free = prepareMissionGitGuard({ root, missionId: 'mission-free', pathValue });
  try {
    assert.equal(runner(root, free)('npm publish').stdout.trim(), 'ran npm publish');
  } finally {
    free.cleanup();
  }
  const plain = prepareMissionGitGuard({ root, pathValue });
  try {
    assert.equal(fs.existsSync(path.join(plain.pathPrefix, 'npm')), false, 'no mission, no wrappers beyond git');
  } finally {
    plain.cleanup();
  }
});

test('yes lock: which commands are which action, and what a step locks', () => {
  const c = (tool, args, ctx) => yesLock.commandCategory(tool, args, ctx);
  assert.equal(c('npm', ['publish']), 'publish');
  assert.equal(c('/usr/local/bin/pnpm', ['publish', '--no-git-checks']), 'publish');
  assert.equal(c('npm', ['dist-tag', 'add', 'atris@3.72.0', 'latest']), 'publish');
  assert.equal(c('npm', ['run', 'publish-docs']), null);
  assert.equal(c('npm', ['test']), null);
  assert.equal(c('gh', ['release', 'create', 'v1']), 'publish');
  assert.equal(c('gh', ['release', 'view', 'v1']), null);
  assert.equal(c('gh', ['pr', 'merge', '3']), 'merge');
  assert.equal(c('git', ['push', '--follow-tags']), 'tag');
  assert.equal(c('git', ['push', 'origin', 'refs/tags/v1']), 'tag');
  assert.equal(c('git', ['push'], { currentBranch: () => 'master' }), 'merge');
  assert.equal(c('git', ['push'], { currentBranch: () => 'feature' }), null);
  assert.equal(c('git', ['-C', 'x', 'push', 'origin', 'feature:main']), 'merge');
  assert.equal(c('atris', ['gmail', 'send', 'a@b.c']), 'send');
  assert.equal(c('atris', ['slack', 'dm', 'U1', 'hi']), 'send');
  assert.equal(c('atris', ['imessage', 'send']), 'send');
  assert.equal(c('atris', ['mission', 'ping', 'm', 'x']), null);
  assert.equal(c('curl', ['-X', 'POST', 'https://api.example.com']), null, 'a direct call to an API is not one of the named commands');
  assert.deepEqual(yesLock.stepLocks('publish the page and post the recording on x'), ['publish', 'tag', 'post']);
  assert.deepEqual(yesLock.stepLocks('email the ten installers'), ['send']);
  assert.deepEqual(yesLock.stepLocks('approve the prize'), [], 'nothing a command can be told apart for');
});
