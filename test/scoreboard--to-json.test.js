'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scoreboard-to-json-'));
process.env.HOME = root;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { toJson } = require('../commands/scoreboard');

const DATE = '2024-06-15';

test('toJson copies a normal score and repo counts under a fixed date', () => {
  const best = { date: '2024-06-12', count: 41 };
  const commits = { total: 3, you: 1, members: 2 };
  const out = toJson({ today: 37, best, streak: 3, extra: 'dropped' }, commits, DATE);
  assert.deepStrictEqual(out, {
    date: DATE,
    today: 37,
    best: { date: '2024-06-12', count: 41 },
    streak: 3,
    repo: { total: 3, you: 1, members: 2 },
  });
  assert.strictEqual(out.best, best);
  assert.strictEqual(out.repo, commits);
  assert.strictEqual(out.extra, undefined);
});

test('toJson keeps a quiet board when there is no best day and no git repo', () => {
  assert.deepStrictEqual(toJson({ today: 0, best: null, streak: 0 }, null, DATE), {
    date: DATE,
    today: 0,
    best: null,
    streak: 0,
    repo: null,
  });
  assert.deepStrictEqual(
    toJson({ today: 1, best: { date: '2024-01-02', count: 1 }, streak: 1 }, { total: 0, you: 0, members: 0 }, DATE),
    {
      date: DATE,
      today: 1,
      best: { date: '2024-01-02', count: 1 },
      streak: 1,
      repo: { total: 0, you: 0, members: 0 },
    },
  );
});

test('toJson throws when the score is missing and leaves blanks when the score is empty', () => {
  assert.throws(() => toJson(null, null, DATE), TypeError);
  assert.throws(() => toJson(undefined, { total: 0, you: 0, members: 0 }, DATE), TypeError);
  assert.deepStrictEqual(toJson({}, null, DATE), {
    date: DATE,
    today: undefined,
    best: undefined,
    streak: undefined,
    repo: null,
  });
});
