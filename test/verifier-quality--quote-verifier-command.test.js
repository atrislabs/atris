'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { quoteVerifierCommand } = require('../lib/verifier-quality');

test('extracts a command from verified proof and prefers it over earlier quotes', () => {
  assert.strictEqual(
    quoteVerifierCommand('Ran [verified] `node --test test/example.test.js` passed.'),
    'node --test test/example.test.js'
  );
  assert.strictEqual(
    quoteVerifierCommand('Earlier `git diff --check`; [VERIFIED] ` custom-check   --all ` PASSED'),
    'custom-check --all'
  );
});

test('extracts a recognized backticked command and normalizes whitespace', () => {
  assert.strictEqual(
    quoteVerifierCommand('Proof:\n\t`  npm   test\n -- --runInBand  ` succeeded'),
    'npm test -- --runInBand'
  );
  assert.strictEqual(quoteVerifierCommand('Checked `git diff --check`.'), 'git diff --check');
});

test('returns null for empty proof or proof without an eligible quoted command', () => {
  for (const proof of [undefined, null, '', ' \n\t ', 'node --test passed', '`custom-check` passed', '`nodejs` passed']) {
    assert.strictEqual(quoteVerifierCommand(proof), null);
  }
});

test('only considers the first backticked command when no verified proof exists', () => {
  assert.strictEqual(quoteVerifierCommand('`custom-check` then `npm test`'), null);
  assert.strictEqual(quoteVerifierCommand('`npm test` then `git diff --check`'), 'npm test');
});
