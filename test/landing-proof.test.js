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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
