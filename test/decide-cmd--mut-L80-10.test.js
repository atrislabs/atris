'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideCommand } = require('../commands/decide');

test('a separate note value is saved with the answered ask', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-note-value-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const previousExitCode = process.exitCode;
  const output = [];
  const exitSignal = new Error('command exited');
  try {
    process.chdir(root);
    process.env.HOME = root;
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    const ledger = path.join(state, 'missions.jsonl');
    fs.writeFileSync(ledger, JSON.stringify({
      id: 'mission-note-fixture',
      objective: 'Review the proposed change',
      status: 'paused',
      created_at: '2024-01-02T03:04:05.000Z',
      updated_at: '2024-01-02T03:04:05.000Z',
      human_asks: [{ text: 'Proceed with the draft?', answered_at: null }],
    }) + '\n');
    console.log = (...parts) => output.push(parts.join(' '));
    console.error = (...parts) => output.push(parts.join(' '));
    process.exit = () => { throw exitSignal; };
    try {
      decideCommand(['1', 'y', '--note', '  Keep the draft private.  ', '--json']);
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    const saved = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.strictEqual(saved.human_asks[0].note, 'Keep the draft private.');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.exitCode = previousExitCode;
  }
});
