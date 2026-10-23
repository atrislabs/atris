'use strict';

// Direct tests for scheduledCopies in lib/zen.js. Every call passes the
// schedule text in, so the crontab and launchd agents on this machine are
// never read. Paths are plain strings under a throwaway folder, and nothing
// is written there.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scheduledCopies } = require('../lib/zen');

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-scheduled-copies-')));
const home = path.join(work, 'home');
fs.mkdirSync(home);
const realHome = process.env.HOME;
process.env.HOME = home;
delete process.env.ATRIS_ZEN_SCHEDULE_FILE;

after(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(work, { recursive: true, force: true });
});

const wt = (p) => ({ path: p });

test('returns only the side copies the schedule text names', () => {
  const a = path.join(work, 'side-a');
  const b = path.join(work, 'side-b');
  const c = path.join(work, 'side-c');
  const text = [
    `0 * * * * cd ${a} && ./sync.sh`,
    `30 2 * * * ${c}/run.sh --once`,
    `5 * * * * ls ${a}`,
  ].join('\n');

  const used = scheduledCopies([wt(a), wt(b), wt(c)], text);

  assert.ok(used instanceof Set);
  assert.deepStrictEqual([...used], [a, c]);
});

test('a path that only starts the same way is not a match', () => {
  const copy = path.join(work, 'wt');
  const siblings = [`${copy}-2/run.sh`, `${copy}.bak`, `${copy}x`].join('\n');

  assert.strictEqual(scheduledCopies([wt(copy)], siblings).size, 0);

  for (const text of [`${copy}/run.sh`, `"${copy}"`, `ls ${copy}`]) {
    assert.deepStrictEqual([...scheduledCopies([wt(copy)], text)], [copy]);
  }
});

test('regex characters in a path match literally', () => {
  const dotted = path.join(work, 'a.b');
  const plus = path.join(work, 'c+d(1)');

  // "aXb" would match "a.b" if the dot were not escaped.
  const text = `${work}/aXb/run.sh\n${plus} --go`;
  assert.deepStrictEqual([...scheduledCopies([wt(dotted), wt(plus)], text)], [plus]);

  assert.deepStrictEqual([...scheduledCopies([wt(dotted)], `${dotted}/run.sh`)], [dotted]);
});

test('~, $HOME and ${HOME} in the schedule text point at the home folder', () => {
  const side = path.join(home, 'side');
  const texts = [
    'cd ~/side && ./run.sh',
    'cd $HOME/side && ./run.sh',
    'cd ${HOME}/side && ./run.sh',
  ];

  for (const text of texts) {
    assert.deepStrictEqual([...scheduledCopies([wt(side)], text)], [side]);
  }
});

test('a worktree path with a trailing slash is compared in resolved form', () => {
  const side = path.join(work, 'side');
  const used = scheduledCopies([wt(`${side}/`)], `${side}/run.sh`);

  assert.deepStrictEqual([...used], [side]);
});

test('empty schedule text or no worktrees gives an empty set', () => {
  const side = path.join(work, 'side');

  const none = scheduledCopies([wt(side)], '');
  assert.ok(none instanceof Set);
  assert.strictEqual(none.size, 0);

  assert.strictEqual(scheduledCopies([], `${side}/run.sh`).size, 0);
});
