'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAgentToday, claudeProjectDir } = require('../lib/agent-today');

test('a tool write on a user turn is not a file the assistant changed', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-today-mut-l181-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-today-mut-l181-proj-')));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const now = new Date(2026, 5, 15, 15, 0, 0);
  const file = path.join(project, 'src', 'sneak.js');
  const dir = claudeProjectDir(home, project, {});
  fs.mkdirSync(dir, { recursive: true });
  const row = {
    type: 'user',
    timestamp: now.toISOString(),
    message: {
      content: [
        { type: 'tool_use', name: 'Write', input: { file_path: file } },
      ],
    },
  };
  fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify(row) + '\n');

  const today = buildAgentToday({ cwd: project, home, env: {}, now });

  assert.deepEqual(
    {
      sessions: today.sessions,
      prompts: today.prompts,
      autoRuns: today.autoRuns,
      files: today.files,
      areas: today.areas,
    },
    {
      sessions: { claude: 0, codex: 0 },
      prompts: 0,
      autoRuns: 0,
      files: [],
      areas: [],
    },
  );
});
