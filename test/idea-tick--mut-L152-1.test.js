'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { addIdea, readIdeas } = require('../lib/idea-inbox');
const { runIdeaTick } = require('../lib/idea-tick');

const CLOCK = Date.parse('2026-01-15T12:00:00Z');
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 'tester@example.com',
};

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-tick-mut-')));
  git(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:fast': 'node --test' } }));
  return dir;
}

// A real checkout with a `base` branch and one commit on top of it, so the
// default change reader (real git diff) has something to read.
function builtWorktree() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-tick-wt-')));
  git(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['branch', 'base']);
  fs.writeFileSync(path.join(dir, 'search.txt'), 'faster search\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'faster search']);
  return dir;
}

function signedOffLap(worktree) {
  return {
    status: 'done',
    task_id: 'T-9',
    engine: 'claude',
    changed: 'Make the inbox search faster',
    worktree,
    result: {
      passed: true,
      validator_result: { passed: true, independent: true, engine: 'codex', executor_engine: 'claude', worktree_unchanged: true },
    },
  };
}

// No inspectChange is passed, so the tick reads the built change with its own
// git diff against the land target.
function tickWith({ repo, worktree, target }) {
  const ships = [];
  const logs = [];
  return runIdeaTick({
    root: repo,
    log: (line) => logs.push(line),
    clock: () => CLOCK,
    runLap: async (text, options) => {
      options.onResult(signedOffLap(worktree));
      return 0;
    },
    ship: (dir, args) => {
      ships.push({ dir, args });
      return { status: 0, stdout: 'pr: https://github.com/o/r/pull/9\nmerge: merged\ndone: worktree shipped\n', stderr: '' };
    },
    landTarget: () => target,
  }).then((outcome) => ({ outcome, ships, logs }));
}

test('a change git can read against the land target goes on to land', async () => {
  const repo = tempRepo();
  const worktree = builtWorktree();
  const idea = addIdea(repo, 'make the inbox search faster');

  const { outcome, ships } = await tickWith({ repo, worktree, target: 'base' });

  assert.equal(outcome.status, 'landed');
  assert.equal(outcome.link, 'https://github.com/o/r/pull/9');
  assert.equal(ships.length, 1, 'the landing step ran once');
  assert.equal(ships[0].dir, worktree);
  const row = readIdeas(repo).find((entry) => entry.id === idea.id);
  assert.equal(row.status, 'landed');
  assert.equal(row.link, 'https://github.com/o/r/pull/9');
});

test('a land target git cannot find stops the tick before anything lands', async () => {
  const repo = tempRepo();
  const worktree = builtWorktree();
  const idea = addIdea(repo, 'make the inbox search faster');

  const { outcome, ships } = await tickWith({ repo, worktree, target: 'no-such-branch' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.stage, 'review');
  assert.match(outcome.reason, /^could not read the built change: ./);
  assert.equal(ships.length, 0, 'nothing was landed');
  const row = readIdeas(repo).find((entry) => entry.id === idea.id);
  assert.equal(row.status, 'refused');
});
