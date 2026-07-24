'use strict';

// skill audit's score line must use singular nouns for a count of 1
// ("1 error", "1 warning") — not the machine-plural "1 errors, 1 warnings".

const test = require('node:test');
const assert = require('node:assert/strict');
const { countLabel } = require('../commands/skill');

test('countLabel uses the singular noun for exactly one', () => {
  assert.equal(countLabel(1, 'error'), '1 error');
  assert.equal(countLabel(1, 'warning'), '1 warning');
});

test('countLabel pluralizes zero and many', () => {
  assert.equal(countLabel(0, 'error'), '0 errors');
  assert.equal(countLabel(2, 'warning'), '2 warnings');
});
