'use strict';

// spends: nothing (temp git repos under the OS temp folder, no network)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pile = require('../lib/waiting-pile');
const { lintMap } = require('../lib/check-plan');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const HOUR = 3600;
const DAY = 24 * HOUR;

function git(dir, args, env = {}) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function at(secondsAgo) {
  const stamp = `${Math.floor(Date.now() / 1000) - secondsAgo} +0000`;
  return { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
}

function commit(dir, file, text, message, secondsAgo) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, ['add', file]);
  git(dir, ['commit', '-qm', message], at(secondsAgo));
}

// A project whose master moved after its branches were cut. Two stale
// branches edit the line master changed (they clash), one edits its own file
// (clean), and three are not waiting: too fresh, past the 7 day limit, and
// already merged.
function makeRepo({ extraStale = 0, limit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-waiting-pile-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  fs.mkdirSync(path.join(dir, '.atris'));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.atris/\n');
  git(dir, ['add', '.gitignore']);
  commit(dir, 'shared.txt', 'one\n', 'start', 10 * DAY);
  if (limit !== undefined) {
    fs.mkdirSync(path.join(dir, 'atris'));
    fs.writeFileSync(path.join(dir, 'atris', 'checks.json'), JSON.stringify({ checks: { unit: { run: 'node --test' } }, waiting_limit: limit }));
    git(dir, ['add', 'atris/checks.json']);
    git(dir, ['commit', '-qm', 'map'], at(10 * DAY));
  }
  const branch = (name, file, text, secondsAgo) => {
    git(dir, ['checkout', '-q', '-b', name, 'master']);
    commit(dir, file, text, name, secondsAgo);
    git(dir, ['checkout', '-q', 'master']);
  };
  branch('clash-a', 'shared.txt', 'two\n', 3 * DAY);
  branch('clash-b', 'shared.txt', 'three\n', 3 * DAY);
  branch('clean-c', 'own.txt', 'own\n', 3 * DAY);
  for (let i = 0; i < extraStale; i += 1) branch(`extra-${i}`, `extra-${i}.txt`, `${i}\n`, 3 * DAY);
  branch('fresh', 'fresh.txt', 'fresh\n', HOUR);
  branch('too-old', 'old.txt', 'old\n', 9 * DAY);
  branch('merged', 'merged.txt', 'merged\n', 3 * DAY);
  git(dir, ['merge', '-q', '--ff-only', 'merged']);
  commit(dir, 'shared.txt', 'master moved\n', 'master moves', 2 * DAY);
  return dir;
}

function cleanup(...dirs) {
  for (const dir of dirs) if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

test('counts the waiting branches and the ones that clash with the default branch', () => {
  const dir = makeRepo();
  try {
    const counted = pile.readPile(dir, { clashes: true, budgetMs: 30000 });
    assert.equal(counted.waiting, 3);
    assert.equal(counted.clashing, 2);
    assert.equal(counted.unchecked, 0);
    assert.equal(counted.limit, 10);
    assert.equal(pile.pileLine(counted), '3 finished changes are waiting to land here, 2 clash with master.');
    // The answer is kept in the project's .atris state and stays tiny.
    const file = path.join(dir, pile.FILE);
    assert.ok(fs.statSync(file).size < 1024);
    assert.equal(pile.readPile(dir, { clashes: true }).source, 'local');
  } finally {
    cleanup(dir);
  }
});

test('the lander records its count, and later calls read that record', () => {
  const dir = makeRepo();
  try {
    const recorded = pile.fromLander(dir, { base: 'master', names: ['clash-a', 'clean-c'] });
    assert.equal(recorded.waiting, 2);
    assert.equal(recorded.clashing, 1);
    assert.equal(recorded.line, '2 finished changes are waiting to land here, 1 clashes with master.');
    const read = pile.readPile(dir, { clashes: true });
    assert.equal(read.source, 'lander');
    assert.equal(read.waiting, 2);
    // A dry run counts but writes nothing.
    pile.fromLander(dir, { base: 'master', names: ['clash-a'], dryRun: true });
    assert.equal(pile.readPile(dir).waiting, 2);
  } finally {
    cleanup(dir);
  }
});

test('over the limit prints the one line; at the limit prints nothing', () => {
  const over = makeRepo({ limit: 2 });
  const even = makeRepo({ limit: 3 });
  try {
    assert.equal(pile.startNotice(over, { budgetMs: 30000 }), '3 changes are waiting to land here. Clear those first.');
    assert.equal(pile.startNotice(even, { budgetMs: 30000 }), '');
    // From the kept record no process starts: it still answers with no git on PATH.
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '';
      const started = Date.now();
      assert.equal(pile.startNotice(over), '3 changes are waiting to land here. Clear those first.');
      assert.ok(Date.now() - started < 300, 'the kept record answers in under 300 ms');
    } finally {
      process.env.PATH = savedPath;
    }
  } finally {
    cleanup(over, even);
  }
});

test('a missing map uses 10', () => {
  const dir = makeRepo({ extraStale: 7 });
  try {
    assert.equal(pile.readLimit(dir), 10);
    assert.equal(pile.startNotice(dir, { budgetMs: 30000 }), '');
    git(dir, ['checkout', '-q', '-b', 'one-more', 'master~1']);
    commit(dir, 'more.txt', 'more\n', 'one more', 3 * DAY);
    git(dir, ['checkout', '-q', 'master']);
    fs.rmSync(path.join(dir, pile.FILE));
    assert.equal(pile.startNotice(dir, { budgetMs: 30000 }), '11 changes are waiting to land here. Clear those first.');
  } finally {
    cleanup(dir);
  }
});

test('a bad state file or no repo prints nothing and never throws', () => {
  const dir = makeRepo({ limit: 5 });
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-waiting-pile-none-'));
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, pile.FILE), '{not json');
    assert.equal(pile.startNotice(dir, { budgetMs: 30000 }), '');
    assert.equal(pile.startNotice(notRepo), '');
    assert.equal(pile.reportLine(notRepo), '');
    assert.equal(pile.startNotice(dir, { base: 'no-such-branch' }), '');
    // A repo with no .atris folder is not counted at all.
    fs.rmSync(path.join(dir, '.atris'), { recursive: true, force: true });
    assert.equal(pile.startNotice(dir, { budgetMs: 30000 }), '');
  } finally {
    cleanup(dir, notRepo);
  }
});

test('atris worktree start prints the line over the limit and still exits 0', () => {
  const over = makeRepo({ limit: 2 });
  const even = makeRepo({ limit: 3 });
  const corrupt = makeRepo({ limit: 2 });
  const copies = [];
  try {
    fs.mkdirSync(path.join(corrupt, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(corrupt, pile.FILE), 'garbage');
    const start = (dir) => {
      const copy = `${dir}-copy`;
      copies.push(copy);
      return spawnSync(process.execPath, [CLI, 'worktree', 'start', '--agent', 'tester', '--task', 'pile check', '--path', copy, '--no-deps'], {
        cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_WAITING_PILE_BUDGET_MS: '30000' },
      });
    };
    const loud = start(over);
    assert.equal(loud.status, 0, loud.stderr || loud.stdout);
    assert.match(loud.stdout, /^3 changes are waiting to land here\. Clear those first\.$/m);
    const quiet = start(even);
    assert.equal(quiet.status, 0, quiet.stderr || quiet.stdout);
    assert.doesNotMatch(quiet.stdout, /waiting to land/);
    // A corrupt record is ignored and counted again.
    const recount = start(corrupt);
    assert.equal(recount.status, 0, recount.stderr || recount.stdout);
    assert.match(recount.stdout, /^3 changes are waiting to land here\. Clear those first\.$/m);
  } finally {
    cleanup(over, even, corrupt, ...copies);
  }
});

test('the map linter accepts waiting_limit and refuses a value that is not a number', () => {
  const base = { checks: { unit: { run: 'node --test' } } };
  assert.deepEqual(lintMap({ ...base, waiting_limit: 10 }).errors, []);
  assert.deepEqual(lintMap(base).errors, []);
  for (const bad of ['10', -1, 2.5, null, true]) {
    const { errors } = lintMap({ ...base, waiting_limit: bad });
    assert.ok(errors.some((line) => /waiting_limit must be a whole number/.test(line)), `refuses ${JSON.stringify(bad)}`);
  }
});
