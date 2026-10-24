'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-audit-shares-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { sharesMeaningfulWords } = require('../lib/wish-audit');

test('shares a leftover noun and ignores a shared verb', () => {
  assert.strictEqual(
    sharesMeaningfulWords('fix the invoice button', 'update the invoice header'),
    true,
  );
  assert.strictEqual(
    sharesMeaningfulWords('fix the layout', 'fix the spacing'),
    false,
  );
});

test('treats a trailing s and end punctuation as the same word', () => {
  assert.strictEqual(
    sharesMeaningfulWords('polish the Buttons!', 'move the button'),
    true,
  );
  assert.strictEqual(
    sharesMeaningfulWords('invoice-button spacing', 'update the invoice'),
    false,
  );
});

test('returns false when a side has no meaningful words', () => {
  assert.strictEqual(sharesMeaningfulWords('', 'fix the invoice button'), false);
  assert.strictEqual(sharesMeaningfulWords(null, undefined), false);
  assert.strictEqual(sharesMeaningfulWords('please fix the', 'please update it'), false);
});
