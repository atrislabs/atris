'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scrub } = require('../lib/campaign-holdout');

test('scrub returns a boxed string unchanged when the holdout would mask a primitive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-holdout-mut-'));
  const file = path.join(dir, 'h.txt');
  fs.writeFileSync(file, 'What is 2+2? Show work\n');
  const text = new String('judge said: What is 2+2? Show work');
  assert.equal(scrub(text, file), text);
});
