const test = require('node:test');
const assert = require('node:assert');

const { WAITING_INPUT_STATUSES } = require('../lib/wish-audit');

// WAITING_INPUT_STATUSES is a constant Set, not a function, so the tests
// exercise it the way lib/wish-delegate.js and lib/next-moves.js do: `.has(...)`.

test('WAITING_INPUT_STATUSES is a Set holding exactly the two waiting statuses', () => {
  assert.ok(WAITING_INPUT_STATUSES instanceof Set);
  assert.strictEqual(WAITING_INPUT_STATUSES.size, 2);
  assert.deepStrictEqual([...WAITING_INPUT_STATUSES].sort(), ['needs_input', 'waiting_input']);
  assert.strictEqual(WAITING_INPUT_STATUSES.has('needs_input'), true);
  assert.strictEqual(WAITING_INPUT_STATUSES.has('waiting_input'), true);
});

test('WAITING_INPUT_STATUSES rejects statuses that are not waiting on the user', () => {
  for (const status of ['done', 'running', 'queued', 'dispatched', 'failed', 'needs-input', 'waiting']) {
    assert.strictEqual(WAITING_INPUT_STATUSES.has(status), false, `${status} should not wait on input`);
  }
});

test('WAITING_INPUT_STATUSES matches exactly: no case folding, no trimming', () => {
  assert.strictEqual(WAITING_INPUT_STATUSES.has('NEEDS_INPUT'), false);
  assert.strictEqual(WAITING_INPUT_STATUSES.has('Waiting_Input'), false);
  assert.strictEqual(WAITING_INPUT_STATUSES.has(' needs_input'), false);
  assert.strictEqual(WAITING_INPUT_STATUSES.has('waiting_input '), false);
});

test('WAITING_INPUT_STATUSES treats empty and missing statuses as not waiting', () => {
  // Callers normalise with String(row.status || ''), so empty string is the real edge input.
  assert.strictEqual(WAITING_INPUT_STATUSES.has(''), false);
  assert.strictEqual(WAITING_INPUT_STATUSES.has(String(undefined || '')), false);
  assert.strictEqual(WAITING_INPUT_STATUSES.has(String(null || '')), false);
  // The Set holds strings only, so non-string values never match.
  assert.strictEqual(WAITING_INPUT_STATUSES.has(undefined), false);
  assert.strictEqual(WAITING_INPUT_STATUSES.has(null), false);
  assert.strictEqual(WAITING_INPUT_STATUSES.has(['needs_input']), false);
});

test('WAITING_INPUT_STATUSES is the same shared Set on every require', () => {
  const again = require('../lib/wish-audit').WAITING_INPUT_STATUSES;
  assert.strictEqual(again, WAITING_INPUT_STATUSES);
});
