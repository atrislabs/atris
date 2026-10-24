'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const recorder = require('../lib/rsi-record');
const { runCommand } = require('../commands/pulse');

test('idle heartbeat records nothing instead of a failed attempt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-outcome-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const write = process.stdout.write;
  const finish = recorder.finishAttempt;
  const begin = recorder.beginAttempt;
  recorder.beginAttempt = () => ({ tree: 'test-tree', node: 'test-node', lane: 'pulse', hint: null });
  let outcome;
  recorder.finishAttempt = (_root, _attempt, value) => { outcome = value; return true; };
  process.env.HOME = root;
  process.chdir(root);
  process.stdout.write = () => true;
  try {
    await runCommand(['--no-claude', '--no-autopilot', '--json'], root);
    assert.equal(outcome.status, 'nothing');
  } finally {
    recorder.beginAttempt = begin;
    recorder.finishAttempt = finish;
    process.stdout.write = write;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
