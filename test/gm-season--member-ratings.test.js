'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-season-ratings-'));
process.env.HOME = tmpDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

const { memberRatings } = require('../lib/gm-season');

test('memberRatings scores active members and counts finished jobs across multiple plays', () => {
  const outcomes = [
    { member: 'alice', kind: 'landed', at: 1000 },
    { member: 'alice', kind: 'landed', at: 2000 },
    { member: 'alice', kind: 'landed', at: 3000 },
    { member: 'bob', kind: 'landed', at: 1000 },
    { member: 'bob', kind: 'dropped', at: 2000 },
    { member: 'bob', kind: 'sent_back', at: 3000 },
    { member: 'bob', kind: 'abandoned', at: 4000 },
    { member: 'carol', kind: 'landed', at: 1000 },
    { member: 'carol', kind: 'landed', at: 2000 },
  ];

  const ratings = memberRatings(outcomes);

  assert.ok(ratings instanceof Map);
  assert.strictEqual(ratings.size, 3);

  // alice: 3 landed of 3 finished -> the Atris Rating 76, finished 3 (3 in a row is not a 99)
  assert.deepStrictEqual(ratings.get('alice'), { ovr: 76, finished: 3 });

  // bob: 1 landed, 1 dropped, 1 sent_back, 1 abandoned -> 1 of 4 landed rates 52, finished 4
  assert.deepStrictEqual(ratings.get('bob'), { ovr: 52, finished: 4 });

  // carol: 2 landed (< 3 finished threshold) -> rookie ovr null, finished 2
  assert.deepStrictEqual(ratings.get('carol'), { ovr: null, finished: 2 });
});

test('memberRatings handles edge cases: rookie threshold, non-finished plays, and malformed entries', () => {
  const outcomes = [
    // dave: only 'took' plays -> 0 finished, ovr null
    { member: 'dave', kind: 'took', at: 500 },
    { member: 'dave', kind: 'took', at: 600 },

    // eve: exactly 3 finished, all dropped -> 0 of 3 landed rates 42, finished 3
    { member: 'eve', kind: 'dropped', at: 1000 },
    { member: 'eve', kind: 'dropped', at: 2000 },
    { member: 'eve', kind: 'dropped', at: 3000 },

    // frank: exactly 3 finished (1 landed, 2 abandoned) -> 1 of 3 rates 55, finished 3
    { member: 'frank', kind: 'landed', at: 1000 },
    { member: 'frank', kind: 'abandoned', at: 2000 },
    { member: 'frank', kind: 'abandoned', at: 3000 },

    // Malformed and incomplete entries should be skipped cleanly
    null,
    undefined,
    {},
    { kind: 'landed' },
    { member: '', kind: 'landed' },
  ];

  const ratings = memberRatings(outcomes);

  assert.strictEqual(ratings.size, 3);
  assert.deepStrictEqual(ratings.get('dave'), { ovr: null, finished: 0 });
  assert.deepStrictEqual(ratings.get('eve'), { ovr: 42, finished: 3 });
  assert.deepStrictEqual(ratings.get('frank'), { ovr: 55, finished: 3 });
});

test('memberRatings handles empty inputs and missing arguments', () => {
  assert.strictEqual(memberRatings([]).size, 0);
  assert.strictEqual(memberRatings().size, 0);
  assert.strictEqual(memberRatings(null).size, 0);
  assert.strictEqual(memberRatings(undefined).size, 0);
});
