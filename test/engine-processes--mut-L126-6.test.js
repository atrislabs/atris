'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEngineProcess } = require('../lib/engine-processes');

test('atris chat requires both print mode and a prompt to count as an engine run', () => {
  for (const command of ['atris chat --print', 'atris chat Explain this change']) {
    assert.equal(parseEngineProcess({
      pid: 123,
      ppid: 1,
      elapsed_seconds: 5,
      command,
    }), null, command);
  }
});
