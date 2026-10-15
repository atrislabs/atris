'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { proveLanding, proveTaskLanding } = require('../lib/landing-proof');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commit(cwd, message, files = {}) {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), body);
  }
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

// A clone with an origin, the way every real workspace looks.
function makeRepo({ remote = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-proof-'));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Proof']);
  git(root, ['config', 'user.email', 'proof@example.com']);
  const base = commit(root, 'base', { 'README.md': '# fixture\n', '.gitignore': 'runs/\n' });
  if (remote) {
    git(dir, ['init', '-q', '--bare', '-b', 'master', 'origin.git']);
    git(root, ['remote', 'add', 'origin', path.join(dir, 'origin.git')]);
    git(root, ['push', '-q', 'origin', 'master']);
  }
  return { dir, root, base };
}

const CHECK = 'node --test test/feature.test.js';
const FEATURE = { 'test/feature.test.js': "require('node:test')('feature', () => {});\n" };
const push = (root) => git(root, ['push', '-q', 'origin', 'HEAD:master']);

test('a committed change pushed to origin with a check that can fail is landed', () => {
  const { dir, root, base } = makeRepo();
  try {
    const work = commit(root, 'feature', FEATURE);
    push(root);
    const proof = proveLanding(root, { commit: work, start: base, verify: CHECK, files: ['test/feature.test.js'], checkedWorkingTree: true });
    assert.equal(proof.status, 'landed', JSON.stringify(proof));
    assert.equal(proof.target, 'origin/master');
    assert.deepEqual(proof.changed_files, ['test/feature.test.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a squash merge lands by content even though the commit id changed, and survives a later edit', () => {
  const { dir, root, base } = makeRepo();
  try {
    git(root, ['checkout', '-q', '-b', 'worker/side']);
    commit(root, 'feature part one', { 'lib/a.js': 'one\n' });
    const work = commit(root, 'feature part two', { 'lib/b.js': 'two\n' });
    git(root, ['checkout', '-q', 'master']);
    git(root, ['merge', '-q', '--squash', 'worker/side']);
    git(root, ['commit', '-q', '-m', 'Squashed feature (#12)']);
    push(root);
    const squashed = proveLanding(root, { commit: work, verify: CHECK });
    assert.equal(squashed.status, 'landed', JSON.stringify(squashed));
    assert.equal(squashed.matched_by, 'content');

    // Someone edits one of the files after the squash: still landed.
    commit(root, 'later edit', { 'lib/a.js': 'one, improved\n' });
    push(root);
    assert.equal(proveLanding(root, { commit: work, verify: CHECK }).status, 'landed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a landing that was later reverted is not landed, whether the merge kept its id or not', () => {
  const { dir, root, base } = makeRepo();
  try {
    // Ancestry path: the commit is on origin, then reverted.
    const work = commit(root, 'feature', { 'lib/a.js': 'one\n' });
    push(root);
    assert.equal(proveLanding(root, { commit: work, start: base, verify: CHECK }).status, 'landed');
    git(root, ['revert', '--no-edit', work]);
    push(root);
    const reverted = proveLanding(root, { commit: work, start: base, verify: CHECK });
    assert.equal(reverted.status, 'not_landed', JSON.stringify(reverted));
    assert.equal(reverted.reason, 'reverted');
    assert.deepEqual(reverted.reverted_files, ['lib/a.js']);

    // Content path: a squash of a change to an existing file, then reverted.
    const fork = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', '-b', 'worker/side']);
    const side = commit(root, 'edit readme', { 'README.md': '# fixture, better\n' });
    git(root, ['checkout', '-q', 'master']);
    git(root, ['merge', '-q', '--squash', 'worker/side']);
    git(root, ['commit', '-q', '-m', 'Squashed (#13)']);
    push(root);
    assert.equal(proveLanding(root, { commit: side, start: fork, verify: CHECK }).status, 'landed');
    commit(root, 'Revert squash', { 'README.md': '# fixture\n' });
    push(root);
    const squashReverted = proveLanding(root, { commit: side, start: fork, verify: CHECK });
    assert.equal(squashReverted.status, 'not_landed', JSON.stringify(squashReverted));
    assert.equal(squashReverted.reason, 'reverted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a deleted file that comes back is a revert; a later edit on top of the work is still landed', () => {
  const { dir, root } = makeRepo();
  try {
    const start = commit(root, 'add old helper', { 'lib/old.js': 'old\n', 'lib/keep.js': 'keep\n' });
    push(root);
    fs.rmSync(path.join(root, 'lib/old.js'));
    const work = commit(root, 'delete old helper and tune keep', { 'lib/keep.js': 'keep, tuned\n' });
    push(root);
    assert.equal(proveLanding(root, { commit: work, start, verify: CHECK }).status, 'landed');

    // Someone edits the kept file again: landed, edited since.
    commit(root, 'tune keep more', { 'lib/keep.js': 'keep, tuned twice\n' });
    push(root);
    const edited = proveLanding(root, { commit: work, start, verify: CHECK });
    assert.equal(edited.status, 'landed', JSON.stringify(edited));
    assert.equal(edited.reason, 'edited_since');
    assert.deepEqual(edited.edited_since, ['lib/keep.js']);

    // The deleted file is restored: the deletion was reverted.
    commit(root, 'bring old helper back', { 'lib/old.js': 'old\n' });
    push(root);
    const restored = proveLanding(root, { commit: work, start, verify: CHECK });
    assert.equal(restored.status, 'not_landed', JSON.stringify(restored));
    assert.equal(restored.reason, 'reverted');
    assert.deepEqual(restored.reverted_files, ['lib/old.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no recorded start, a merged branch is measured from where the branch began', () => {
  const { dir, root, base } = makeRepo();
  try {
    git(root, ['checkout', '-q', '-b', 'worker/side']);
    commit(root, 'feature part one', { 'lib/a.js': 'one\n' });
    const work = commit(root, 'feature part two', FEATURE);
    git(root, ['checkout', '-q', 'master']);
    commit(root, 'unrelated mainline work', { 'lib/other.js': 'other\n' });
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge worker/side', 'worker/side']);
    const merge = git(root, ['rev-parse', 'HEAD']);
    push(root);
    const proof = proveLanding(root, { commit: work, verify: CHECK, files: ['test/feature.test.js'] });
    assert.equal(proof.status, 'landed', JSON.stringify(proof));
    assert.equal(proof.base, base);
    assert.equal(proof.base_from, `merge ${merge}`);
    assert.deepEqual([...proof.changed_files].sort(), ['lib/a.js', 'test/feature.test.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a commit that only lives on a side branch is not landed', () => {
  const { dir, root } = makeRepo();
  try {
    git(root, ['checkout', '-q', '-b', 'worker/side']);
    const side = commit(root, 'feature', FEATURE);
    const proof = proveLanding(root, { commit: side, verify: CHECK });
    assert.equal(proof.status, 'not_landed');
    assert.equal(proof.reason, 'content_not_on_target');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no origin, or an origin branch never fetched, is unverified, never landed', () => {
  const local = makeRepo({ remote: false });
  try {
    const work = commit(local.root, 'feature', FEATURE);
    const proof = proveLanding(local.root, { commit: work, start: local.base, verify: CHECK });
    assert.equal(proof.status, 'unverified');
    assert.equal(proof.reason, 'no_remote_target');

    git(local.root, ['remote', 'add', 'origin', path.join(local.dir, 'nowhere.git')]);
    assert.equal(proveLanding(local.root, { commit: work, start: local.base, verify: CHECK }).reason, 'no_remote_target');
  } finally {
    fs.rmSync(local.dir, { recursive: true, force: true });
  }
});

test('a local-only commit is not landed until it reaches origin', () => {
  const { dir, root, base } = makeRepo();
  try {
    const work = commit(root, 'feature', FEATURE);
    assert.equal(proveLanding(root, { commit: work, start: base, verify: CHECK }).status, 'not_landed');
    push(root);
    assert.equal(proveLanding(root, { commit: work, start: base, verify: CHECK }).status, 'landed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty commit is a no-op; a commit already on target with no recorded start is unverified', () => {
  const { dir, root, base } = makeRepo();
  try {
    const empty = commit(root, 'Start flight: nothing');
    push(root);
    const proof = proveLanding(root, { commit: empty, start: base, verify: CHECK });
    assert.equal(proof.status, 'no_op');
    assert.equal(proof.reason, 'empty_diff');

    // Working on the target branch itself: without the task's own start,
    // there is no honest way to say which change was the task's.
    const someone = commit(root, 'someone else', FEATURE);
    push(root);
    const unknown = proveLanding(root, { commit: someone, verify: CHECK });
    assert.equal(unknown.status, 'unverified');
    assert.equal(unknown.reason, 'no_base');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claimed tracked files must be in the change; ignored or untracked artifacts are not held against it', () => {
  const { dir, root, base } = makeRepo();
  try {
    const work = commit(root, 'feature', FEATURE);
    push(root);
    const skipped = proveLanding(root, { commit: work, start: base, verify: CHECK, files: ['README.md'] });
    assert.equal(skipped.status, 'unverified');
    assert.equal(skipped.reason, 'claimed_files_untouched');

    const artifacts = proveLanding(root, { commit: work, start: base, verify: CHECK, files: ['runs/receipt.json', 'notes/never-committed.md', 'test/feature.test.js'] });
    assert.equal(artifacts.status, 'landed', JSON.stringify(artifacts));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a check that cannot fail does not back a landing', () => {
  const { dir, root, base } = makeRepo();
  try {
    const work = commit(root, 'feature', FEATURE);
    push(root);
    const proof = proveLanding(root, { commit: work, start: base, verify: 'git diff --check' });
    assert.equal(proof.status, 'unverified');
    assert.equal(proof.reason, 'check_cannot_fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a check that ran on a checkout without the work, or on uncommitted edits to it, does not back a landing', () => {
  const { dir, root, base } = makeRepo();
  try {
    git(root, ['checkout', '-q', '-b', 'worker/side']);
    const work = commit(root, 'feature', FEATURE);
    push(root);
    // The checkout went back to an older commit before the check ran.
    git(root, ['checkout', '-q', '--detach', base]);
    const stale = proveLanding(root, { commit: work, start: base, verify: CHECK, checkedWorkingTree: true });
    assert.equal(stale.status, 'unverified');
    assert.equal(stale.reason, 'check_ran_without_the_work');

    git(root, ['checkout', '-q', 'worker/side']);
    // A stray untracked file elsewhere says nothing about this work.
    fs.writeFileSync(path.join(root, 'scratch.txt'), 'stray\n');
    assert.equal(proveLanding(root, { commit: work, start: base, verify: CHECK, checkedWorkingTree: true }).status, 'landed');
    // An uncommitted edit to the work's own file does.
    fs.appendFileSync(path.join(root, 'test', 'feature.test.js'), '// edited\n');
    const dirty = proveLanding(root, { commit: work, start: base, verify: CHECK, checkedWorkingTree: true });
    assert.equal(dirty.status, 'unverified');
    assert.equal(dirty.reason, 'checked_uncommitted_files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a check that runs untracked or outside files does not back a landing', () => {
  const { dir, root, base } = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-proof-outside-'));
  try {
    const work = commit(root, 'feature', FEATURE);
    push(root);
    fs.writeFileSync(path.join(root, 'untracked-check.js'), 'process.exit(0);\n');
    const untracked = proveLanding(root, { commit: work, start: base, verify: 'node untracked-check.js', checkedWorkingTree: true });
    assert.equal(untracked.status, 'unverified');
    assert.match(untracked.detail, /git does not track/);

    fs.writeFileSync(path.join(outside, 'check.test.js'), FEATURE['test/feature.test.js']);
    const elsewhere = proveLanding(root, { commit: work, start: base, verify: `node ${path.join(outside, 'check.test.js')}`, checkedWorkingTree: true });
    assert.equal(elsewhere.status, 'unverified');
    assert.equal(elsewhere.reason, 'checked_untracked_content');
    assert.match(elsewhere.detail, /outside this checkout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a task proves from its own recorded commits, never from the checkout HEAD', () => {
  const { dir, root, base } = makeRepo();
  try {
    const work = commit(root, 'feature', FEATURE);
    push(root);
    const none = proveTaskLanding({ workspace_root: root, metadata: { verify: CHECK } });
    assert.equal(none.status, 'unverified');
    assert.equal(none.reason, 'no_task_commit');

    const idle = proveTaskLanding({ workspace_root: root, metadata: { verify: CHECK, start_commit: work, work_commit: work } });
    assert.equal(idle.status, 'no_op');

    const real = proveTaskLanding({ workspace_root: root, metadata: { verify: CHECK, start_commit: base, work_commit: work } });
    assert.equal(real.status, 'landed', JSON.stringify(real));

    // The check that actually ran (the verifier's cache or the proof) is
    // what counts, even when the builder never wrote metadata.verify.
    const fromVerifier = proveTaskLanding({ workspace_root: root, metadata: { start_commit: base, work_commit: work } }, { verify: CHECK });
    assert.equal(fromVerifier.status, 'landed', JSON.stringify(fromVerifier));
    const noCheck = proveTaskLanding({ workspace_root: root, metadata: { start_commit: base, work_commit: work } });
    assert.equal(noCheck.reason, 'no_check');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only the builder stamps the work commit; the verifier and reviewers never do', () => {
  const taskDb = require('../lib/task-db');
  const { dir, root, base } = makeRepo();
  const db = taskDb.open(path.join(dir, 'tasks.db'));
  try {
    const { id } = taskDb.addTask(db, { title: 'Ship the feature', workspaceRoot: fs.realpathSync(root) });
    taskDb.claimTask(db, { id, claimedBy: 'builder' });
    assert.equal(taskDb.getTask(db, id).metadata.start_commit, base);

    const work = commit(root, 'feature', FEATURE);
    taskDb.readyTask(db, { id, actor: 'builder', proof: 'feature shipped' });
    assert.equal(taskDb.getTask(db, id).metadata.work_commit, work);

    // The verifier's and a reviewer's checkouts moved on; their ready passes
    // must not rename the work.
    commit(root, 'someone else on the same checkout', { 'lib/other.js': 'other\n' });
    taskDb.readyTask(db, { id, actor: 'autoland-verifier', proof: 'reran the check' });
    taskDb.readyTask(db, { id, actor: 'codex-review', proof: 'looks right' });
    taskDb.readyTask(db, { id, proof: 'no actor at all' });
    assert.equal(taskDb.getTask(db, id).metadata.work_commit, work);

    // A task with no builder on record gets no stamp from anyone.
    const orphan = taskDb.addTask(db, { title: 'Unclaimed work', workspaceRoot: fs.realpathSync(root) });
    taskDb.readyTask(db, { id: orphan.id, actor: 'autoland-verifier', proof: 'reran the check' });
    assert.equal(taskDb.getTask(db, orphan.id).metadata.work_commit, undefined);
  } finally {
    taskDb.close(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claim and ready in a folder outside any git repo stamp nothing and start no git', () => {
  const taskDb = require('../lib/task-db');
  const childProcess = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-proof-plain-'));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const realSpawnSync = childProcess.spawnSync;
  const gitCalls = [];
  const previousGitDir = process.env.GIT_DIR;
  delete process.env.GIT_DIR;
  const db = taskDb.open(path.join(dir, 'tasks.db'));
  try {
    childProcess.spawnSync = (command, ...rest) => {
      if (command === 'git') gitCalls.push(rest[0]);
      return realSpawnSync(command, ...rest);
    };
    const { id } = taskDb.addTask(db, { title: 'Plain folder work', workspaceRoot: fs.realpathSync(root) });
    assert.equal(taskDb.claimTask(db, { id, claimedBy: 'builder' }).claimed, true);
    assert.equal(taskDb.readyTask(db, { id, actor: 'builder', proof: 'feature shipped' }).ready, true);
    const metadata = taskDb.getTask(db, id).metadata || {};
    assert.equal(metadata.start_commit, undefined);
    assert.equal(metadata.work_commit, undefined);
    assert.deepEqual(gitCalls, []);
  } finally {
    childProcess.spawnSync = realSpawnSync;
    if (previousGitDir !== undefined) process.env.GIT_DIR = previousGitDir;
    taskDb.close(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-accept proves from the task as stored now, with the check the verifier ran', () => {
  const taskDb = require('../lib/task-db');
  const { stampAutoAcceptMetadata, landingProofVerify } = require('../commands/task');
  const { dir, root, base } = makeRepo();
  const db = taskDb.open(path.join(dir, 'tasks.db'));
  try {
    const { id } = taskDb.addTask(db, { title: 'Ship the feature', workspaceRoot: fs.realpathSync(root) });
    taskDb.claimTask(db, { id, claimedBy: 'builder' });
    // The caller read the task here, before ready and the verifier's re-run.
    const stale = taskDb.getTask(db, id);
    const work = commit(root, 'feature', FEATURE);
    push(root);
    taskDb.readyTask(db, { id, actor: 'builder', proof: 'feature shipped' });
    // The verifier's passing re-run is recorded; the builder's metadata.verify is not.
    const row = taskDb.getTask(db, id);
    const metadata = { ...row.metadata, verify_cache: { command: CHECK, ok: true, ran_by: 'autoland-verifier' } };
    delete metadata.verify;
    db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), id);

    assert.equal(landingProofVerify({ metadata }), CHECK);
    assert.equal(landingProofVerify({ metadata: { ...metadata, verify_cache: { command: CHECK, ok: false } } }), '');

    const landing = stampAutoAcceptMetadata(taskDb, db, stale, 'auto-accept-certified', 'test');
    assert.equal(landing.status, 'landed', JSON.stringify(landing));
    assert.equal(landing.commit, work);
    assert.equal(landing.base, base);
    assert.equal(taskDb.getTask(db, id).metadata.landing.status, 'landed');
  } finally {
    taskDb.close(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a local branch is never a landing target unless the caller has no remote at all', () => {
  const { dir, root, base } = makeRepo();
  try {
    const work = commit(root, 'feature', FEATURE);
    const local = proveLanding(root, { commit: work, start: base, target: 'refs/heads/master', verify: CHECK });
    assert.equal(local.status, 'unverified', JSON.stringify(local));
    assert.equal(local.reason, 'local_target');

    const task = proveTaskLanding({ workspace_root: root, metadata: { verify: CHECK, start_commit: base, work_commit: work, base_ref: 'refs/heads/master' } });
    assert.equal(task.status, 'unverified');
    assert.equal(task.reason, 'local_target');

    const allowed = proveLanding(root, { commit: work, start: base, target: 'refs/heads/master', verify: CHECK, localTargetOk: true });
    assert.equal(allowed.status, 'landed', JSON.stringify(allowed));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
