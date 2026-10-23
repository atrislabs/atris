const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAgentToday, claudeProjectDir, startOfToday } = require('../lib/agent-today');

// A fixed afternoon, so "today" is the same no matter when this runs.
const NOW = new Date(2026, 9, 23, 15, 0, 0);
const DAY_TIME = new Date(startOfToday(NOW).getTime() + 60 * 60 * 1000);

// Claude Code keys each folder by its path with every non-alphanumeric
// character turned into a dash. The key is as long as the folder path.
// Claude Code starts shortening keys past 200 characters.
function deepFolder(t, keyLength) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-today-mut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = fs.realpathSync(root);
  const folder = path.join(home, 'p'.repeat(keyLength - home.length - 1));
  fs.mkdirSync(folder);
  const dir = claudeProjectDir(home, folder, {});
  assert.strictEqual(path.basename(dir).length, keyLength, 'fixture key length');
  fs.mkdirSync(dir, { recursive: true });
  return { home, folder, dir };
}

// One log from today: a typed ask and an edit to src/login.js.
// No row records a cwd, so the folder check cannot confirm it.
function writeUncheckedLog(dir, folder) {
  const at = DAY_TIME.toISOString();
  const rows = [
    { type: 'user', timestamp: at, message: { content: 'add a login page' } },
    {
      type: 'assistant',
      timestamp: at,
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(folder, 'src', 'login.js') } }],
      },
    },
  ];
  const file = path.join(dir, 'session-1.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, DAY_TIME, DAY_TIME);
}

test('a folder whose key is exactly 200 characters trusts its own log without a recorded cwd', (t) => {
  const { home, folder, dir } = deepFolder(t, 200);
  writeUncheckedLog(dir, folder);
  const today = buildAgentToday({ cwd: folder, home, env: {}, now: NOW });
  assert.strictEqual(today.sessions.claude, 1);
  assert.strictEqual(today.prompts, 1);
  assert.deepStrictEqual(today.files, ['src/login.js']);
  assert.deepStrictEqual(today.areas, ['src']);
});

test('a folder whose key is 201 characters skips a log that records no cwd', (t) => {
  const { home, folder, dir } = deepFolder(t, 201);
  writeUncheckedLog(dir, folder);
  const today = buildAgentToday({ cwd: folder, home, env: {}, now: NOW });
  assert.strictEqual(today.sessions.claude, 0);
  assert.strictEqual(today.prompts, 0);
  assert.deepStrictEqual(today.files, []);
});
