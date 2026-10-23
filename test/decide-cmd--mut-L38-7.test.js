'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decideCommand } = require('../commands/decide');

test('answered questions stay out of the decision list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-answered-question-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalLog = console.log;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), '{}');
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: 'answered-question-mission',
      owner: 'builder',
      status: 'running',
      human_asks: [{
        text: 'Should we publish the draft?',
        answered_at: '2025-01-01T12:00:00.000Z',
        answer: 'yes',
      }],
    }) + '\n');
    console.log = (...parts) => output.push(parts.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

    decideCommand(['--json']);

    assert.strictEqual(JSON.parse(output.join('\n')).decisions.length, 0);
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
