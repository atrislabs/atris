'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAgentToday, claudeProjectDir } = require('../lib/agent-today');

test('a session whose modification time cannot be read is skipped', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-today-stat-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const dir = claudeProjectDir(root, cwd, {});
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    cwd,
    timestamp: '2024-06-15T12:00:00.000Z',
    type: 'user',
    message: { content: 'Explain this project' },
  }) + '\n');

  // Keep a readable, valid session behind a failed metadata lookup. If the
  // failure is treated as recent activity, this session will be counted.
  const statSync = fs.statSync;
  t.mock.method(fs, 'statSync', function (target, ...args) {
    if (target === file) {
      const error = new Error('metadata unavailable');
      error.code = 'EACCES';
      throw error;
    }
    return statSync.call(this, target, ...args);
  });

  const summary = buildAgentToday({
    cwd,
    home: root,
    env: {},
    now: new Date('2024-06-15T12:00:00.000Z'),
  });
  assert.deepStrictEqual(summary.sessions, { claude: 0, codex: 0 });
  assert.strictEqual(summary.prompts, 0);
});
