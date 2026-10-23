'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOneLap } = require('../commands/one-lap');

test('retrying with the saved verifier does not report a verifier conflict', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lap-saved-verifier-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  try {
    process.env.HOME = root;
    process.chdir(root);
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    const verifier = 'node --test';
    fs.writeFileSync(path.join(state, 'wishes.jsonl'), JSON.stringify({
      id: 'wish-retry', text: 'fix parser', status: 'delegated',
      mission_id: 'mission-retry', task_id: 'task-retry', one_lap: true,
      ts: '2020-01-01T00:00:00Z',
    }) + '\n');
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: 'mission-retry', objective: 'fix parser', status: 'running',
      verifier, lane: 'code', runner: 'codex_goal',
      created_at: '2020-01-01T00:00:00Z',
    }) + '\n');
    let result;
    await runOneLap('fix parser', {
      root, verifier, quiet: true, onResult(value) { result = value; },
      ownCli(args) {
        if (args[0] !== 'task' || args[1] !== 'show') throw new Error('unexpected CLI call');
        return { status: 0, stdout: JSON.stringify({ id: 'task-retry', title: 'fix parser', status: 'review' }) };
      },
      progress() {},
    });
    assert.match(result.reason, /Review/);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
