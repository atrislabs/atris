'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { proveLanding } = require('../lib/landing-proof');

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

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-proof-'));
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Proof']);
  git(root, ['config', 'user.email', 'proof@example.com']);
  const base = commit(root, 'base', { 'README.md': '# fixture\n' });
  return { root, base };
}

const CHECK = 'node --test test/feature.test.js';
const FEATURE = { 'test/feature.test.js': "require('node:test')('feature', () => {});\n" };

test('a real committed change on master with a check that can fail is landed', () => {
  const { root, base } = makeRepo();
  try {
    commit(root, 'feature', FEATURE);
    const proof = proveLanding(root, { base, verify: CHECK, files: ['test/feature.test.js'], checkedWorkingTree: true });
    assert.equal(proof.status, 'landed', JSON.stringify(proof));
    assert.deepEqual(proof.changed_files, ['test/feature.test.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a commit that only lives on a side branch is not landed', () => {
  const { root, base } = makeRepo();
  try {
    git(root, ['checkout', '-q', '-b', 'worker/side']);
    const side = commit(root, 'feature', FEATURE);
    const proof = proveLanding(root, { commit: side, base, target: 'master', verify: CHECK });
    assert.equal(proof.status, 'not_landed');
    assert.equal(proof.reason, 'commit_not_on_target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty commit, or a checkout older than the work, is a no-op', () => {
  const { root, base } = makeRepo();
  try {
    commit(root, 'Start flight: nothing');
    const empty = proveLanding(root, { base, verify: CHECK });
    assert.equal(empty.status, 'no_op');
    assert.equal(empty.reason, 'empty_diff');

    const later = commit(root, 'someone else', FEATURE);
    const stale = proveLanding(root, { commit: base, base: later, verify: CHECK });
    assert.equal(stale.status, 'no_op', 'a check on a commit from before the work began proves nothing about the work');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a change that skips the files the work claims is unverified', () => {
  const { root, base } = makeRepo();
  try {
    commit(root, 'feature', FEATURE);
    const proof = proveLanding(root, { base, verify: CHECK, files: ['lib/claimed.js'] });
    assert.equal(proof.status, 'unverified');
    assert.equal(proof.reason, 'claimed_files_untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a check that cannot fail does not back a landing', () => {
  const { root, base } = makeRepo();
  try {
    commit(root, 'feature', FEATURE);
    const proof = proveLanding(root, { base, verify: 'git diff --check' });
    assert.equal(proof.status, 'unverified');
    assert.equal(proof.reason, 'check_cannot_fail');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a check that ran on untracked or outside files does not back a landing', () => {
  const { root, base } = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-proof-outside-'));
  try {
    commit(root, 'feature', { 'README.md': '# fixture, edited\n' });
    // The verifier's test file was never committed: it passed on the working tree.
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'feature.test.js'), FEATURE['test/feature.test.js']);
    const untracked = proveLanding(root, { base, verify: CHECK, checkedWorkingTree: true });
    assert.equal(untracked.status, 'unverified');
    assert.equal(untracked.reason, 'checked_uncommitted_files');
    fs.rmSync(path.join(root, 'test'), { recursive: true, force: true });

    // Bookkeeping edits under atris/ do not taint the check.
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), 'scratch\n');
    // A check file under atris/ escapes the dirty scan but not the path check.
    fs.mkdirSync(path.join(root, 'atris', 'checks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'checks', 'x.test.js'), FEATURE['test/feature.test.js']);
    const hidden = proveLanding(root, { base, verify: 'node --test atris/checks/x.test.js', checkedWorkingTree: true });
    assert.equal(hidden.status, 'unverified');
    assert.match(hidden.detail, /git does not track/);
    // The verifier ran a file from some other checkout.
    fs.writeFileSync(path.join(outside, 'check.test.js'), FEATURE['test/feature.test.js']);
    const elsewhere = proveLanding(root, { base, verify: `node ${path.join(outside, 'check.test.js')}`, checkedWorkingTree: true });
    assert.equal(elsewhere.status, 'unverified');
    assert.equal(elsewhere.reason, 'checked_untracked_content');
    assert.match(elsewhere.detail, /outside this checkout/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('with a remote, only origin counts: a local-only commit is not landed', () => {
  const { root, base } = makeRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-proof-remote-'));
  try {
    git(remote, ['init', '-q', '--bare', '-b', 'master']);
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['push', '-q', 'origin', 'master']);
    commit(root, 'feature', FEATURE);
    const unpushed = proveLanding(root, { base, verify: CHECK });
    assert.equal(unpushed.status, 'not_landed');
    assert.equal(unpushed.target, 'origin/master');
    git(root, ['push', '-q', 'origin', 'master']);
    assert.equal(proveLanding(root, { base, verify: CHECK }).status, 'landed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});
