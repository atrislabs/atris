'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideCommand } = require('../commands/decide');

test('the first open question has decision number one in json output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-decision-number-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const previousExitCode = process.exitCode;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# Atris\n');
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'),
      JSON.stringify({
        schema: 'atris.mission.v1',
        id: 'review-choice',
        owner: 'reviewer',
        objective: 'Review a choice',
        status: 'running',
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-02T00:00:00.000Z',
        human_asks: ['Approve the draft?'],
      }) + '\n');
    console.log = (...parts) => output.push(parts.join(' '));
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };

    decideCommand(['--json']);

    assert.strictEqual(JSON.parse(output.join('\n')).decisions[0].number, 1);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.exitCode = previousExitCode;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
