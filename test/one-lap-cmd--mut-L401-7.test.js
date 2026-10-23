'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a resumed request awaiting input retains its saved task identifier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lap-saved-task-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    const { runOneLap } = require('../commands/one-lap');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'wishes.jsonl'), JSON.stringify({
      id: 'wish-parser',
      text: 'fix parser',
      status: 'waiting_input',
      ts: '2020-01-01T00:00:00Z',
      task_id: 'CLI-42',
      questions: ['Which input format?'],
    }) + '\n');
    let result;
    await runOneLap('fix parser', {
      root,
      quiet: true,
      onResult(value) { result = value; },
      ownCli() { throw new Error('resuming a question must not invoke commands'); },
      progress() { throw new Error('resuming a question must not dispatch work'); },
    });
    assert.strictEqual(result.task_id, 'CLI-42');
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
