'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a bare claim flag retains its boolean owner instead of using the fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-owner-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'state-home');
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    process.chdir(root);
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: 'm1', status: 'active', objective: 'Keep improving the queue',
    }) + '\n');
    const { createNextLoopTask } = require('../commands/loop-front');
    const result = createNextLoopTask(['--as'], root, { print: false });
    assert.strictEqual(result.task?.claimed_by, 'true');
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});
