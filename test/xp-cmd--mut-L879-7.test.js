'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('collecting again without new episodes preserves the last processed episode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-xp-cursor-'));
  const cwd = process.cwd();
  const savedEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_') || key === 'CODEX_STATE_DB') delete process.env[key];
    }
    process.env.HOME = root;
    process.env.CODEX_STATE_DB = path.join(root, 'absent.sqlite');
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), 'temporary workspace\n');
    process.chdir(root);
    const { collectLocalXpProjection } = require('../commands/xp');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'task_episodes.jsonl'), JSON.stringify({
      episode_id: 'accepted-proof',
      task_id: 'task-proof',
      created_at: '2020-02-03T12:00:00.000Z',
      state: { status: 'done', title: 'Finish proof', claimed_by: 'builder' },
      action: { actor: 'reviewer' },
      rl: { label: 'accepted' },
      reward: { value: 1 },
      proof: 'node --test passed',
    }) + '\n');
    collectLocalXpProjection(['--workspace', root]);
    const result = collectLocalXpProjection(['--workspace', root]);
    assert.strictEqual(result.integrity.cursor.last_episode_id, 'accepted-proof');
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
