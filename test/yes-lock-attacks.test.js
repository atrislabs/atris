'use strict';

// Every hole Codex found in the first yes lock (commit 01e5b12b), as a test
// through the real wrappers. Each attack must come back held (exit 77).
// Every tool but git is a stand-in that only prints, so nothing can publish.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const yesLock = require('../lib/yes-lock');
const { prepareMissionGitGuard } = require('../lib/mission-protected-lane');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const NEW_API = typeof yesLock.check === 'function';

function makeRepo(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('tag', 'v1');
  if (remote) git('remote', 'add', 'origin', remote);
  return git;
}

// A locked job for these owner steps, through whichever lock this code has.
function lockedJob(steps) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-attack-'));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  const stateDir = path.join(base, 'home-state');
  const bin = path.join(base, 'bin');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const git = makeRepo(root, remote);
  git('push', '-q', 'origin', 'master');
  git('checkout', '-q', '-b', 'feature');
  git('commit', '-q', '--allow-empty', '-m', 'work');
  fs.mkdirSync(bin);
  for (const tool of ['npm', 'gh', 'atris', 'npx']) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "ran ${tool} $*"\n`, { mode: 0o755 });
  const gitDir = path.dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
  const pathValue = [bin, path.dirname(process.execPath), gitDir, '/usr/bin', '/bin'].join(path.delimiter);
  const id = 'mission-attack';
  let seal = null;
  let guard;
  if (NEW_API) {
    seal = yesLock.sealFor(steps);
    yesLock.writeYesLocks(stateDir, id, { betId: 'bet-a', seal });
    guard = prepareMissionGitGuard({ root, missionId: id, yesLockSeal: seal, stateDir, pathValue });
  } else {
    yesLock.writeYesLocks(root, id, { betId: 'bet-a', steps });
    guard = prepareMissionGitGuard({ root, missionId: id, pathValue });
  }
  const run = (cmd, cwd = root) => spawnSync('sh', ['-c', cmd], { cwd, env: { ...guard.env, ...GIT_ENV, PATH: guard.env.PATH }, encoding: 'utf8' });
  const lockFiles = NEW_API ? [path.join(stateDir, 'yes-locks', `${id}.json`)] : [path.join(root, '.atris', 'state', 'yes-locks', `${id}.json`)];
  const approve = step => (NEW_API ? yesLock.approveYesLock(stateDir, id, step, seal) : yesLock.approveYesLock(root, id, step));
  return { base, root, remote, git, run, approve, lockFiles, cleanup: () => guard.cleanup() };
}

const PUBLISH = [{ text: 'write the notes', who: 'team', public: false }, { text: 'release the package to npm', who: 'you', public: true }];
const MERGE = [{ text: 'build it', who: 'team', public: false }, { text: 'merge it to master', who: 'you', public: false }];
const POST = [{ text: 'write the update', who: 'team', public: false }, { text: 'post the update in the team channel', who: 'you', public: true }];
const held = r => r.status === 77;

test('attack 1: the job erasing or breaking its own lock does not open anything', () => {
  const j = lockedJob(PUBLISH);
  try {
    for (const f of j.lockFiles) fs.rmSync(f, { force: true });
    assert.ok(held(j.run('npm publish')), 'a missing lock file is locked');
    for (const f of j.lockFiles) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}'); }
    assert.ok(held(j.run('npm publish')), 'a broken lock file is locked');
    for (const f of j.lockFiles) fs.writeFileSync(f, JSON.stringify({ locks: [{ step: 2, categories: ['send'], approved_at: '2026-01-01' }] }));
    assert.ok(held(j.run('npm publish')), 'a lock file that does not match the seal is locked');
    // nothing in the workspace holds the lock any more
    assert.equal(fs.existsSync(path.join(j.root, '.atris', 'state', 'yes-locks')), !NEW_API);
  } finally {
    j.cleanup();
  }
});

test('attack 2: options and aliases do not hide a publish', () => {
  const j = lockedJob(PUBLISH);
  try {
    assert.ok(held(j.run('npm --registry https://registry.npmjs.org publish')));
    assert.ok(held(j.run('npm pub')));
    assert.ok(held(j.run('gh release new v1 --notes hi')));
    assert.ok(held(j.run('npm --userconfig ./x.npmrc publish --tag next')));
    // ordinary work still runs
    assert.equal(j.run('npm test').stdout.trim(), 'ran npm test');
    assert.equal(j.run('npm --prefix sub run build').stdout.trim(), 'ran npm --prefix sub run build');
    assert.equal(j.run('gh pr view 3').stdout.trim(), 'ran gh pr view 3');
  } finally {
    j.cleanup();
  }
});

test('attack 3: git destinations are resolved, risky config is refused, and -C checks the named repo', () => {
  const j = lockedJob(MERGE);
  try {
    assert.ok(held(j.run('git push --repo=origin HEAD:refs/heads/master')));
    assert.ok(held(j.run('git push --mirror origin')));
    assert.ok(held(j.run('git push --all origin')));
    assert.ok(held(j.run('git -c remote.origin.push=HEAD:refs/heads/master push origin')));
    assert.ok(held(j.run('git -c alias.x=push x origin HEAD:master')));
    j.git('config', 'alias.p', 'push');
    assert.ok(held(j.run('git p origin HEAD:master')), 'an alias set in the repo config is read through');
    j.git('config', 'remote.origin.push', 'HEAD:refs/heads/master');
    assert.ok(held(j.run('git push origin')), 'a push spec set in the repo config is read through');
    j.git('config', '--unset', 'remote.origin.push');
    // a repo on master named with -C, from a caller on a feature branch
    const other = path.join(j.base, 'other');
    makeRepo(other)('branch', 'feature');
    assert.ok(held(j.run(`git -C ${other} merge feature`)));
    assert.ok(held(j.run(`git --git-dir=${path.join(other, '.git')} --work-tree=${other} commit --allow-empty -m x`)));
    // pushing a feature branch is still fine
    assert.equal(j.run('git push -q origin feature').status, 0);
  } finally {
    j.cleanup();
  }
});

test('attack 4: one category does not mask another', () => {
  const merge = lockedJob(MERGE);
  try {
    assert.ok(held(merge.run('git push origin HEAD:refs/heads/master --tags')));
  } finally {
    merge.cleanup();
  }
  const post = lockedJob(POST);
  try {
    assert.ok(held(post.run('atris slack send C123 update --approved')), 'a slack send is also a post');
  } finally {
    post.cleanup();
  }
});

test('attack 5: unchecked routes inside covered tools are closed', () => {
  const j = lockedJob([...PUBLISH, { text: 'merge it to master', who: 'you', public: false }]);
  try {
    assert.ok(held(j.run("gh api 'repos/{owner}/{repo}/releases' -f tag_name=v1")));
    assert.ok(held(j.run('gh api -X PUT repos/o/r/pulls/1/merge')));
    assert.ok(held(j.run('npm exec --yes --package=npm -- npm publish')));
    assert.ok(held(j.run('npx npm publish')));
    // a read through gh api still runs
    assert.equal(j.run('gh api repos/o/r/pulls/1').stdout.trim(), 'ran gh api repos/o/r/pulls/1');
  } finally {
    j.cleanup();
  }
});

test('attack 6: one yes covers one successful run, then the step closes', () => {
  const j = lockedJob(PUBLISH);
  try {
    assert.ok(held(j.run('npm publish')));
    j.approve(2);
    assert.equal(j.run('npm publish').stdout.trim(), 'ran npm publish', 'the yes lets one publish through');
    assert.ok(held(j.run('npm publish ../package-B')), 'a second publish needs a new yes');
  } finally {
    j.cleanup();
  }
});
