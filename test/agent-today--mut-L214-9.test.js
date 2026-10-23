'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAgentToday } = require('../lib/agent-today');

test('a Codex session without a recorded folder is excluded from the folder summary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-today-missing-cwd-'));
  try {
    const cwd = path.join(root, 'project');
    const home = path.join(root, 'home');
    const day = path.join(home, '.codex', 'sessions', '2000', '01', '02');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(day, { recursive: true });
    const now = new Date(2000, 0, 2, 12);
    const timestamp = now.toISOString();
    const log = path.join(day, 'missing-cwd.jsonl');
    fs.writeFileSync(log, [
      { type: 'session_meta', payload: {} },
      {
        type: 'response_item', timestamp,
        payload: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'Explain this project.' }],
        },
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.utimesSync(log, now, now);

    assert.deepStrictEqual(buildAgentToday({ cwd, home, env: {}, now }), {
      folder: 'project',
      since: new Date(2000, 0, 2).toISOString(),
      sessions: { claude: 0, codex: 0 },
      prompts: 0,
      autoRuns: 0,
      files: [],
      areas: [],
      commits: [],
      unsaved: 0,
      isGit: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
