const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexGoalCommand } = require('../commands/codex-goal');

test('status never sends a nonexistent threads database to sqlite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-goal-missing-db-'));
  const goals = path.join(dir, 'goals.sqlite');
  const missing = path.join(dir, 'missing.sqlite');
  const calls = path.join(dir, 'calls.jsonl');
  const savedPath = process.env.PATH;
  const savedLog = console.log;
  const output = [];
  try {
    fs.writeFileSync(goals, '');
    // A local sqlite stand-in records the database paths passed to the process.
    // Empty rows ensure that status also checks the separate threads database.
    fs.writeFileSync(path.join(dir, 'sqlite3'),
      `#!${process.execPath}\n` +
      `const fs = require('node:fs');\n` +
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv[4]) + '\\n');\n` +
      `process.stdout.write('[]');\n`, { mode: 0o755 });
    process.env.PATH = dir;
    console.log = (value) => output.push(value);

    codexGoalCommand(['status', '--state', goals, '--threads-db', missing,
      '--thread', 'absent-thread', '--json']);

    assert.equal(output.join('\n'), JSON.stringify({
      ok: true, schema: 'atris.codex_goal.v1', action: 'status',
      state_path: goals, goals: [],
    }, null, 2));
    // Each goal query probes the existing goals DB, then reads its goals.
    // The missing threads DB must never appear in the subprocess output log.
    assert.equal(fs.readFileSync(calls, 'utf8'),
      `${JSON.stringify(goals)}\n`.repeat(4));
  } finally {
    console.log = savedLog;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
