'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeToolResult } = require('../lib/tool-result-encode');

test('tool result encoding round-trips relay output that can trigger the WAF', () => {
  const result = {
    status: 'error',
    stdout: '$(whoami)\nSELECT * FROM tasks;\n<script>alert(1)</script>',
    exit_code: 1,
  };

  const encoded = encodeToolResult(result);

  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), result);
});
