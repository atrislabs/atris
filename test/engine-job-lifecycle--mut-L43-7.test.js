'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { engineTerminalReason } = require('../lib/engine-job-lifecycle');

test('a timeout flag alone classifies an interrupted result as timeout', () => {
  assert.strictEqual(engineTerminalReason({
    timed_out: true,
    exitCode: null,
    stdout: 'Partial answer before interruption',
    stderr: '',
  }), 'timeout');
});
