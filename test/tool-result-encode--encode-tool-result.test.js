'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { encodeToolResult } = require('../lib/tool-result-encode');

test('encodes a normal tool result as base64 JSON', () => {
  const result = { ok: true, items: [1, 'two'] };

  assert.strictEqual(
    encodeToolResult(result),
    'eyJvayI6dHJ1ZSwiaXRlbXMiOlsxLCJ0d28iXX0='
  );
  assert.deepStrictEqual(result, { ok: true, items: [1, 'two'] });
});

test('preserves Unicode and JSON escaping through UTF-8 encoding', () => {
  const result = { text: 'café 世界 😀\n"quoted"\\' };
  const encoded = encodeToolResult(result);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');

  assert.strictEqual(decoded, '{"text":"café 世界 😀\\n\\"quoted\\"\\\\"}');
  assert.deepStrictEqual(JSON.parse(decoded), result);
});

test('encodes null and empty JSON values', () => {
  assert.strictEqual(encodeToolResult(null), 'bnVsbA==');
  assert.strictEqual(encodeToolResult({}), 'e30=');
  assert.strictEqual(encodeToolResult([]), 'W10=');
  assert.strictEqual(encodeToolResult(''), 'IiI=');
});

test('throws for values that cannot be encoded as JSON', () => {
  const circular = {};
  circular.self = circular;

  assert.throws(() => encodeToolResult(circular), TypeError);
  assert.throws(() => encodeToolResult(1n), TypeError);
  assert.throws(() => encodeToolResult(undefined), TypeError);
});
