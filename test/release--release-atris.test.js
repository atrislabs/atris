'use strict';

// releaseAtris has a real path that commits, tags, pushes, and runs `gh release
// create`. These tests only use { dryRun: true } plus the early stops that
// return before any write, so nothing leaves the temp repo. Every repo is a
// throwaway git repo under os.tmpdir() with a fixed git identity and a fresh
// HOME. Commit hashes and dates are never asserted.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { releaseAtris } = require('../commands/release');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-atris-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'release-atris-home-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  git(root, ['init', '-q', '-b', 'master']);
  return root;
}

function writePackage(dir, version) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'atris', version }, null, 2) + '\n',
  );
  git(dir, ['add', 'package.json']);
}

function commit(dir, message) {
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
}

function writeScorecard(dir, reward) {
  const scorecards = path.join(dir, 'atris', 'scorecards');
  fs.mkdirSync(scorecards, { recursive: true });
  fs.writeFileSync(path.join(scorecards, 'planner.md'), `# planner\n\nreward: ${reward}\n`);
}

// releaseAtris reads process.cwd(), so run it from inside the repo and capture
// everything it prints.
async function runIn(dir, options) {
  const lines = [];
  const originalLog = console.log;
  const originalCwd = process.cwd();
  console.log = (...args) => lines.push(args.join(' '));
  process.chdir(dir);
  try {
    await releaseAtris(options);
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
  }
  return lines.join('\n');
}

test('dry run lists commits since the last tag and drafts a patch bump without writing', async (t) => {
  const dir = makeRepo(t);
  writePackage(dir, '1.2.3');
  commit(dir, 'base');
  git(dir, ['tag', 'v1.2.3']);
  commit(dir, 'fix the flaky parser');
  commit(dir, 'add release notes');
  const headBefore = git(dir, ['rev-parse', 'HEAD']);
  const packageBefore = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');

  const out = await runIn(dir, { dryRun: true });

  assert.match(out, /^commits since v1\.2\.3: 2$/m);
  assert.match(out, /^bump type: patch$/m);
  assert.match(out, /^version: 1\.2\.3 → 1\.2\.4$/m);
  assert.match(out, /^- [0-9a-f]{7,} add release notes$/m);
  assert.match(out, /^- [0-9a-f]{7,} fix the flaky parser$/m);
  assert.match(out, /^--- dry-run: draft release ---$/m);
  assert.match(out, /^tag: v1\.2\.4$/m);
  assert.match(out, /^Atris v1\.2\.4 is out\.$/m);
  // newest commit leads the launch post
  assert.match(out, /^🚀 add release notes$/m);
  assert.match(out, /^⚡ fix the flaky parser$/m);

  // a dry run must not touch the repo or package.json
  assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(dir, ['tag', '--list']), 'v1.2.3');
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), packageBefore);
});

test('a scorecard with reward 5 makes the dry run a minor bump', async (t) => {
  const dir = makeRepo(t);
  writePackage(dir, '1.2.3');
  commit(dir, 'base');
  git(dir, ['tag', 'v1.2.3']);
  commit(dir, 'ship the planner');
  writeScorecard(dir, 5);

  const out = await runIn(dir, { dryRun: true });

  assert.match(out, /^bump type: minor$/m);
  assert.match(out, /^version: 1\.2\.3 → 1\.3\.0$/m);
  assert.match(out, /^tag: v1\.3\.0$/m);
});

test('a scorecard with reward 4 stays a patch bump', async (t) => {
  const dir = makeRepo(t);
  writePackage(dir, '1.2.3');
  commit(dir, 'base');
  git(dir, ['tag', 'v1.2.3']);
  commit(dir, 'ship the planner');
  writeScorecard(dir, 4);

  const out = await runIn(dir, { dryRun: true });

  assert.match(out, /^bump type: patch$/m);
  assert.match(out, /^version: 1\.2\.3 → 1\.2\.4$/m);
});

test('with no tags the dry run covers the whole history', async (t) => {
  const dir = makeRepo(t);
  writePackage(dir, '0.1.0');
  commit(dir, 'first');
  commit(dir, 'second');

  const out = await runIn(dir, { dryRun: true });

  assert.match(out, /^commits since beginning: 2$/m);
  assert.match(out, /^version: 0\.1\.0 → 0\.1\.1$/m);
});

test('nothing new since the last tag stops with one message and no version math', async (t) => {
  const dir = makeRepo(t);
  writePackage(dir, '1.2.3');
  commit(dir, 'base');
  git(dir, ['tag', 'v1.2.3']);

  const out = await runIn(dir, { dryRun: true });

  assert.equal(out, 'no new commits since last tag (v1.2.3). nothing to release.');
});

test('a repo with no commits at all is treated as nothing to release', async (t) => {
  const dir = makeRepo(t);

  const out = await runIn(dir, { dryRun: true });

  assert.equal(out, 'no new commits since last tag. nothing to release.');
});

test('a missing package.json stops after the changelog with no version line', async (t) => {
  const dir = makeRepo(t);
  commit(dir, 'base');
  commit(dir, 'work without a package');

  const out = await runIn(dir, { dryRun: true });

  assert.match(out, /^commits since beginning: 2$/m);
  assert.match(out, /^no package\.json found\. cannot bump version\.$/m);
  assert.doesNotMatch(out, /^version:/m);
  assert.doesNotMatch(out, /dry-run/);
});
