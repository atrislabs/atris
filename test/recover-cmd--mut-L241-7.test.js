'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recoverCommand } = require('../commands/recover');

test('recovery reports the spawn error when the mission tick cannot start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-spawn-error-'));
  const executable = process.execPath;
  const originalLog = console.log;
  const missingExecutable = path.join(root, 'missing-node');
  const output = [];
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), `${JSON.stringify({
      id: 'resume-spawn-error',
      status: 'paused',
      stop_reason: 'aborted',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    })}\n`);
    // Exercise a real, immediate spawn failure without starting a worker.
    process.execPath = missingExecutable;
    console.log = (value) => output.push(value);
    assert.equal(recoverCommand(['--apply', '--json'], { root }), 0);
    const report = JSON.parse(output.join('\n'));
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].outcome, 'failed');
    assert.equal(report.results[0].detail, `spawnSync ${missingExecutable} ENOENT`);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, report.receipt_path), 'utf8'));
    assert.equal(receipt.results[0].detail, `spawnSync ${missingExecutable} ENOENT`);
  } finally {
    process.execPath = executable;
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
