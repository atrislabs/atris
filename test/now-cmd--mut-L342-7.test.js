'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderDefaultNow } = require('../commands/now');

test('renderDefaultNow rejects a mission move with a next action but no objective', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-now-incomplete-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-incomplete',
      objective: '',
      owner: 'codex',
      status: 'running',
      runner: 'codex_goal',
      cadence: 'manual',
      verifier: 'git diff --check',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }) + '\n');

    const content = renderDefaultNow(root);
    const matters = content.split('## What Matters Now\n\n')[1].split('\n\n##')[0];
    assert.equal(matters, '- Decide the next useful move before opening more context.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
