'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appendEngineLiveLogChunk,
  createEngineLiveLog,
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

test('live logs are created beside receipts and append every output chunk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-live-log-'));
  try {
    const receiptPath = path.join(root, 'engine-ask-example.json');
    const liveLogPath = createEngineLiveLog(receiptPath);
    appendEngineLiveLogChunk(liveLogPath, Buffer.from('first chunk\n'));
    appendEngineLiveLogChunk(liveLogPath, 'second chunk\n');
    assert.equal(liveLogPath, path.join(root, 'engine-ask-example.live.log'));
    assert.equal(fs.readFileSync(liveLogPath, 'utf8'), 'first chunk\nsecond chunk\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
