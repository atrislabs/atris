'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { releaseAtris, releasePreflight } = require('../commands/release');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Throwaway repo: one seed commit at version 1.2.3, tagged v1.2.3 unless tag is false.
// Each subject in `after` becomes an empty commit on top of the seed.
function makeRepo(t, { tag = true, after = [], pkg = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  git(dir, 'init', '--initial-branch=master');
  git(dir, 'config', 'user.email', 'release-command@test.invalid');
  git(dir, 'config', 'user.name', 'release command test');
  git(dir, 'config', 'commit.gpgsign', 'false');

  if (pkg) {
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'release-command-fixture', version: '1.2.3' }, null, 2)}\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'seed');
  if (tag) git(dir, 'tag', 'v1.2.3');
  for (const subject of after) git(dir, 'commit', '--allow-empty', '-m', subject);
  return dir;
}

// Makes origin/master point at HEAD. Preflight only compares refs, so no real remote is needed.
function publishOrigin(dir, ref = 'HEAD') {
  git(dir, 'update-ref', 'refs/remotes/origin/master', ref);
}

// Runs fn with console.log captured. Returns the printed lines and fn's result.
// Multi-line messages (the changelog) are split so each commit is its own line.
async function capture(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(...args.join(' ').split('\n'));
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console.log = log;
  }
}

// releaseAtris reads process.cwd(), so move into the repo for the call and restore after.
async function inDir(dir, fn) {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

test('dry-run plans a patch bump from the commits since the last tag and changes nothing', async (t) => {
  const dir = makeRepo(t, { after: ['fix the parser', 'add the status line'] });

  const { lines } = await capture(() => inDir(dir, () => releaseAtris({ dryRun: true })));

  assert.ok(lines.includes('commits since v1.2.3: 2'));
  assert.ok(lines.includes('bump type: patch'));
  assert.ok(lines.includes('version: 1.2.3 → 1.2.4'));
  assert.ok(lines.some(l => /^- [a-f0-9]+ fix the parser$/.test(l)));
  assert.ok(lines.some(l => /^- [a-f0-9]+ add the status line$/.test(l)));
  assert.ok(lines.includes('tag: v1.2.4'));
  assert.ok(lines.includes('Atris v1.2.4 is out.'));
  // git log is newest first, so the launch post leads with the latest commit.
  assert.ok(lines.includes('🚀 add the status line'));
  assert.ok(lines.includes('⚡ fix the parser'));

  assert.equal(git(dir, 'tag', '--list'), 'v1.2.3');
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '3');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.2.3');
});

test('a scorecard reward of 5 plans a minor bump, and 4 stays a patch', async (t) => {
  const dir = makeRepo(t, { after: ['ship the thing'] });
  const scorecards = path.join(dir, 'atris', 'scorecards');
  fs.mkdirSync(scorecards, { recursive: true });
  const card = path.join(scorecards, 'alpha.md');

  fs.writeFileSync(card, '# alpha\n\nreward: 4\n');
  const low = await capture(() => inDir(dir, () => releaseAtris({ dryRun: true })));
  assert.ok(low.lines.includes('bump type: patch'));
  assert.ok(low.lines.includes('version: 1.2.3 → 1.2.4'));

  fs.writeFileSync(card, '# alpha\n\nreward: 5\n');
  const high = await capture(() => inDir(dir, () => releaseAtris({ dryRun: true })));
  assert.ok(high.lines.includes('bump type: minor'));
  assert.ok(high.lines.includes('version: 1.2.3 → 1.3.0'));
});

test('dry-run with no commits since the last tag says so and stops', async (t) => {
  const dir = makeRepo(t);

  const { lines } = await capture(() => inDir(dir, () => releaseAtris({ dryRun: true })));

  assert.deepEqual(lines, ['no new commits since last tag (v1.2.3). nothing to release.']);
});

test('release stops before bumping when there is no package.json', async (t) => {
  const dir = makeRepo(t, { pkg: false, after: ['docs only'] });

  const { lines } = await capture(() => inDir(dir, () => releaseAtris({ dryRun: true })));

  assert.ok(lines.includes('no package.json found. cannot bump version.'));
  assert.equal(lines.some(l => l.startsWith('version:')), false);
});

test('preflight passes on a clean master that matches origin, with no tag yet, and runs the suite once', async (t) => {
  const dir = makeRepo(t, { tag: false });
  publishOrigin(dir);
  const calls = [];

  const { lines, result } = await capture(() => releasePreflight({
    cwd: dir,
    runTests: (cwd) => {
      calls.push(cwd);
      return { status: 0 };
    },
  }));

  assert.equal(result, 0);
  assert.deepEqual(calls, [dir]);
  assert.deepEqual(lines, [
    'pass: current branch is master',
    'pass: working tree is clean',
    'pass: local master matches origin/master',
    'pass: no tag v1.2.3',
    'pass: test suite',
    '',
    'release preflight passed',
  ]);
});

test('preflight fails on a feature branch with a dirty tree and an existing tag, and skips the suite', async (t) => {
  const dir = makeRepo(t);
  publishOrigin(dir);
  git(dir, 'checkout', '-b', 'feature/status-line');
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirt\n');
  const calls = [];

  const { lines, result } = await capture(() => releasePreflight({
    cwd: dir,
    runTests: () => {
      calls.push('npm test');
      return { status: 0 };
    },
  }));

  assert.equal(result, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(lines, [
    'fail: current branch is feature/status-line, need master',
    'fail: working tree is not clean',
    'pass: local master matches origin/master',
    'fail: tag v1.2.3 already exists',
    'skip: test suite (earlier checks failed)',
    '',
    'release preflight failed',
  ]);
});

test('preflight fails when local master has commits that origin/master does not', async (t) => {
  const dir = makeRepo(t, { tag: false, after: ['unpushed work'] });
  publishOrigin(dir, 'HEAD~1');

  const { lines, result } = await capture(() => releasePreflight({
    cwd: dir,
    runTests: () => ({ status: 0 }),
  }));

  assert.equal(result, 1);
  assert.ok(lines.includes('fail: local master does not match origin/master'));
  assert.equal(lines.at(-1), 'release preflight failed');
});

test('preflight reports a failing suite by its exit code, and a suite that cannot start by its error', async (t) => {
  const dir = makeRepo(t, { tag: false });
  publishOrigin(dir);

  const exited = await capture(() => releasePreflight({
    cwd: dir,
    runTests: () => ({ status: 3 }),
  }));
  assert.equal(exited.result, 1);
  assert.ok(exited.lines.includes('fail: test suite exited 3'));
  assert.equal(exited.lines.at(-1), 'release preflight failed');

  const missing = await capture(() => releasePreflight({
    cwd: dir,
    runTests: () => ({ error: new Error('spawn npm ENOENT') }),
  }));
  assert.equal(missing.result, 1);
  assert.ok(missing.lines.includes('fail: test suite could not run (spawn npm ENOENT)'));
});
