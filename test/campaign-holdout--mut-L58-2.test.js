'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scrub } = require('../lib/campaign-holdout');

test('scrub masks trimmed held-out lines of exactly four characters', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-holdout-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'holdout.txt');
  fs.writeFileSync(file, '  abcd  \nabc\n');

  assert.equal(scrub('judge: abcd, abc, abcd', file), 'judge: [held out], abc, [held out]');
});
