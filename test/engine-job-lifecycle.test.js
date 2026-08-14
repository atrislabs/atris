'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  engineTerminalStatus,
  createEngineTerminalEmitter,
} = require('../lib/engine-job-lifecycle');

test('engine terminal status names answered, failed, timed out, and cancelled', () => {
  assert.equal(engineTerminalStatus({ ok: true, exit_code: 0, stdout: 'answer' }), 'answered');
  assert.equal(engineTerminalStatus({ ok: false, reason: 'exit_1' }), 'failed');
  assert.equal(engineTerminalStatus({ timed_out: true }), 'timed out');
  assert.equal(engineTerminalStatus({ cancelled: true, timed_out: true }), 'cancelled');
  assert.equal(engineTerminalStatus({ exitCode: 0, report: 'answer' }), 'answered');
  assert.equal(engineTerminalStatus({ exitCode: 0, stdout: ' \n', stderr: '' }), 'failed');
  assert.equal(engineTerminalStatus({ stdout: 'answer without exit metadata' }), 'failed');
});

test('terminal emitter reports a job once and ignores a later poll of the same key', () => {
  const events = [];
  const emit = createEngineTerminalEmitter((event) => events.push(event));
  const first = emit('grok:1', { ok: true, exit_code: 0, stdout: 'now' });
  const poll = emit('grok:1', { ok: true, exit_code: 0, stdout: 'now again' });
  const other = emit('cursor:2', { ok: false, reason: 'timeout', timed_out: true });
  assert.equal(first.status, 'answered');
  assert.equal(poll, null);
  assert.equal(other.status, 'timed out');
  assert.equal(events.length, 2);
  assert.equal(events[0].stdout, 'now');
  assert.equal(events[1].job_key, 'cursor:2');
});
