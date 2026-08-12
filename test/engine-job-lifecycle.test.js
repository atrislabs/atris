'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  engineTerminalReason,
  engineTerminalStatus,
} = require('../lib/engine-job-lifecycle');

test('empty exit zero is no_output and missing exit metadata is unknown', () => {
  assert.equal(engineTerminalReason({ exitCode: 0, stdout: ' \n', stderr: '' }), 'no_output');
  assert.equal(engineTerminalStatus({ exitCode: 0, stdout: '', stderr: '' }), 'failed');
  assert.equal(engineTerminalReason({ stdout: 'answer without exit metadata' }), 'unknown');
  assert.equal(engineTerminalStatus({ stdout: 'answer without exit metadata' }), 'failed');
  assert.equal(engineTerminalStatus({ exit_code: 0, stdout: 'answer' }), 'answered');
});
