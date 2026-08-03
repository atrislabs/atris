'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildToolResultBody } = require('../lib/tool-result-encode');

test('tool result request body is encoded and flagged by default', () => {
  const result = {
    status: 'error',
    stdout: '$(cat /etc/passwd)\nSELECT * FROM tasks;\n<script>alert(1)</script>',
    exit_code: 1,
  };

  const body = buildToolResultBody('call-1', result, {});

  assert.deepEqual(body, {
    call_id: 'call-1',
    result: body.result,
    output_encoding: 'base64',
  });
  assert.deepEqual(JSON.parse(Buffer.from(body.result, 'base64').toString('utf8')), result);
  assert.equal(JSON.stringify(body).includes('$(cat /etc/passwd)'), false);
  assert.deepEqual(buildToolResultBody('call-1', result, { ATRIS_TOOL_RESULT_B64: '1' }), body);
});

test('ATRIS_TOOL_RESULT_B64=0 restores the legacy request body', () => {
  const result = { status: 'ok', stdout: 'plain output' };

  assert.deepEqual(buildToolResultBody('call-2', result, { ATRIS_TOOL_RESULT_B64: '0' }), {
    call_id: 'call-2',
    result,
  });
});
