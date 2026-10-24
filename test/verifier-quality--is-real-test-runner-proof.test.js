'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isRealTestRunnerProof } = require('../lib/verifier-quality');

test('isRealTestRunnerProof accepts a known runner paired with a pass word', () => {
  assert.strictEqual(isRealTestRunnerProof('node --test test/foo.test.js passed'), true);
  assert.strictEqual(isRealTestRunnerProof('[verified] `npm test` passed'), true);
  assert.strictEqual(isRealTestRunnerProof('npm run test:unit all green'), true);
  assert.strictEqual(isRealTestRunnerProof('pnpm test ok'), true);
  assert.strictEqual(isRealTestRunnerProof('yarn test pass'), true);
  assert.strictEqual(isRealTestRunnerProof('pytest -q 5 passed'), true);
  assert.strictEqual(isRealTestRunnerProof('go test ./... ok'), true);
  assert.strictEqual(isRealTestRunnerProof('cargo test finished with 0 failures'), true);
  assert.strictEqual(isRealTestRunnerProof('vitest run 0 failure'), true);
  assert.strictEqual(isRealTestRunnerProof('jest suite complete 12/12'), true);
});

test('isRealTestRunnerProof ignores case and collapses odd whitespace', () => {
  assert.strictEqual(isRealTestRunnerProof('NODE --TEST x.test.js PASSED'), true);
  assert.strictEqual(isRealTestRunnerProof('node   --test\n  test/foo.test.js\n\tpassed'), true);
  assert.strictEqual(isRealTestRunnerProof('  npm\ttest   green  '), true);
});

test('isRealTestRunnerProof rejects a runner with no pass signal', () => {
  assert.strictEqual(isRealTestRunnerProof('node --test test/foo.test.js'), false);
  assert.strictEqual(isRealTestRunnerProof('npm test'), false);
  assert.strictEqual(isRealTestRunnerProof('npm test failed'), false);
});

test('isRealTestRunnerProof rejects a pass word with no runner', () => {
  assert.strictEqual(isRealTestRunnerProof('all checks passed'), false);
  assert.strictEqual(isRealTestRunnerProof('looks green to me, 3/3 ok'), false);
  assert.strictEqual(isRealTestRunnerProof('test -f lib/foo.js && ok'), false);
});

test('isRealTestRunnerProof respects word boundaries on both halves', () => {
  // "ok" hides inside broken/token but is not a standalone word.
  assert.strictEqual(isRealTestRunnerProof('npm test broken'), false);
  assert.strictEqual(isRealTestRunnerProof('npm test token'), false);
  // runner names must not be prefixes of longer words.
  assert.strictEqual(isRealTestRunnerProof('npm testing passed'), false);
  assert.strictEqual(isRealTestRunnerProof('jestures passed'), false);
  assert.strictEqual(isRealTestRunnerProof('attest passed'), false);
});

test('isRealTestRunnerProof returns false for empty and non-string input', () => {
  assert.strictEqual(isRealTestRunnerProof(), false);
  assert.strictEqual(isRealTestRunnerProof(undefined), false);
  assert.strictEqual(isRealTestRunnerProof(null), false);
  assert.strictEqual(isRealTestRunnerProof(''), false);
  assert.strictEqual(isRealTestRunnerProof('   \n\t  '), false);
  assert.strictEqual(isRealTestRunnerProof(0), false);
  assert.strictEqual(isRealTestRunnerProof(12), false);
  assert.strictEqual(isRealTestRunnerProof({}), false);
  assert.strictEqual(isRealTestRunnerProof([]), false);
});
