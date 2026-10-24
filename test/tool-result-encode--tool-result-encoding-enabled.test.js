'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toolResultEncodingEnabled } = require('../lib/tool-result-encode');

const VAR = 'ATRIS_TOOL_RESULT_B64';

test('encoding stays on unless ATRIS_TOOL_RESULT_B64 is exactly "0"', () => {
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: '1' }), true);
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: 'false' }), true);
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: '0' }), false);

  // Only the exact string "0" turns it off. Near misses keep it on.
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: ' 0' }), true);
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: '0 ' }), true);
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: '00' }), true);
});

test('unset, empty, and unrelated env leave encoding on', () => {
  assert.strictEqual(toolResultEncodingEnabled({}), true);
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: '' }), true);
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: undefined }), true);
  assert.strictEqual(toolResultEncodingEnabled({ [VAR]: null }), true);

  // Other ATRIS_* flags must not switch this one off.
  assert.strictEqual(toolResultEncodingEnabled({ ATRIS_OTHER_FLAG: '0' }), true);
});

test('with no argument it reads process.env, restored afterwards', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, VAR);
  const previous = process.env[VAR];

  try {
    delete process.env[VAR];
    assert.strictEqual(toolResultEncodingEnabled(), true);

    process.env[VAR] = '0';
    assert.strictEqual(toolResultEncodingEnabled(), false);

    process.env[VAR] = '1';
    assert.strictEqual(toolResultEncodingEnabled(), true);
  } finally {
    if (had) {
      process.env[VAR] = previous;
    } else {
      delete process.env[VAR];
    }
  }
});
