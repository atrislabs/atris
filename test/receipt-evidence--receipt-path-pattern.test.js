const test = require('node:test');
const assert = require('node:assert');

const { RECEIPT_PATH_PATTERN } = require('../lib/receipt-evidence');

// The export is a shared global regex, so its lastIndex is stateful. Every
// helper below works on a fresh copy, the same way the callers do.
function fresh() {
  return new RegExp(RECEIPT_PATH_PATTERN.source, RECEIPT_PATH_PATTERN.flags);
}

function paths(text) {
  return Array.from(String(text).matchAll(fresh()), (m) => m[1]);
}

test('RECEIPT_PATH_PATTERN is a global RegExp with one capture group', () => {
  assert.ok(RECEIPT_PATH_PATTERN instanceof RegExp);
  assert.strictEqual(RECEIPT_PATH_PATTERN.global, true);
  assert.strictEqual(new RegExp(`${RECEIPT_PATH_PATTERN.source}|`).exec('')?.length, 2);
});

test('captures receipt paths under atris/runs and .atris/state', () => {
  assert.deepStrictEqual(
    paths('verified in atris/runs/mission-42.json today'),
    ['atris/runs/mission-42.json'],
  );
  assert.deepStrictEqual(
    paths('state: .atris/state/tasks.projection.json'),
    ['.atris/state/tasks.projection.json'],
  );
  assert.deepStrictEqual(
    paths('nested atris/runs/2026/10/run-a.json ok'),
    ['atris/runs/2026/10/run-a.json'],
  );
});

test('matches at the start of the text and after newlines', () => {
  assert.deepStrictEqual(paths('atris/runs/a.json'), ['atris/runs/a.json']);
  assert.deepStrictEqual(
    paths('first line\natris/runs/a.json\n.atris/state/b.json'),
    ['atris/runs/a.json', '.atris/state/b.json'],
  );
});

test('accepts quote, backtick and paren prefixes and stops at closing punctuation', () => {
  assert.deepStrictEqual(paths('receipt "atris/runs/a.json" ok'), ['atris/runs/a.json']);
  assert.deepStrictEqual(paths("receipt 'atris/runs/a.json' ok"), ['atris/runs/a.json']);
  assert.deepStrictEqual(paths('receipt `atris/runs/a.json` ok'), ['atris/runs/a.json']);
  assert.deepStrictEqual(paths('receipt (atris/runs/a.json) ok'), ['atris/runs/a.json']);
  assert.deepStrictEqual(paths('see atris/runs/a.json; then more'), ['atris/runs/a.json']);
  assert.deepStrictEqual(paths('see atris/runs/a.json, then more'), ['atris/runs/a.json']);
});

test('finds several paths in one proof and keeps source order', () => {
  const text = 'ran `atris/runs/one.json` and (.atris/state/two.json) then atris/runs/three.json';
  assert.deepStrictEqual(paths(text), [
    'atris/runs/one.json',
    '.atris/state/two.json',
    'atris/runs/three.json',
  ]);
});

test('empty and unrelated text produce no matches', () => {
  assert.deepStrictEqual(paths(''), []);
  assert.deepStrictEqual(paths('all green, no receipts named here'), []);
  assert.strictEqual(fresh().test(''), false);
});

test('rejects other directories, other extensions and incomplete paths', () => {
  assert.deepStrictEqual(paths('atris/other/a.json'), []);
  assert.deepStrictEqual(paths('atris/state/a.json'), []);
  assert.deepStrictEqual(paths('atris/runs/a.txt'), []);
  assert.deepStrictEqual(paths('atris/runs/.json'), []);
  assert.deepStrictEqual(paths('atris/runs/'), []);
  assert.deepStrictEqual(paths('atris\\runs\\a.json'), []);
});

test('requires a boundary character before the path', () => {
  assert.deepStrictEqual(paths('xatris/runs/a.json'), []);
  assert.deepStrictEqual(paths('/abs/dir/atris/runs/a.json'), []);
  assert.deepStrictEqual(paths('.atris/runs/a.json'), []);
  // A comma ends a path but is not a valid prefix for the next one.
  assert.deepStrictEqual(paths('atris/runs/a.json,atris/runs/b.json'), ['atris/runs/a.json']);
});

test('glob shorthand still matches the pattern, so callers must filter it', () => {
  assert.deepStrictEqual(paths('see atris/runs/*.json for all'), ['atris/runs/*.json']);
});

test('fresh copies are repeatable while the shared regex stays untouched', () => {
  const text = 'atris/runs/a.json';
  assert.deepStrictEqual(paths(text), ['atris/runs/a.json']);
  assert.deepStrictEqual(paths(text), ['atris/runs/a.json']);
  assert.strictEqual(RECEIPT_PATH_PATTERN.lastIndex, 0);
});
