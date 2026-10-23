const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexGoalCommand } = require('../commands/codex-goal');

test('status reads a private snapshot after sqlite refuses a readonly database', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-goal-readonly-'));
  const savedPath = process.env.PATH;
  const savedLog = console.log;
  const output = [];
  try {
    const db = path.join(sandbox, 'goals.sqlite');
    fs.writeFileSync(db, 'snapshot fixture');
    // A local sqlite executable models the readonly-open failure without a
    // platform-dependent WAL lock or an installed sqlite dependency.
    fs.writeFileSync(path.join(sandbox, 'sqlite3'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-readonly')) {
  process.stderr.write('Error: unable to open database file');
  process.exit(1);
}
if (fs.readFileSync(args[1], 'utf8') !== 'snapshot fixture') process.exit(2);
const rows = args[2].includes('sqlite_master')
  ? [{ name: 'threads' }]
  : [{ thread_id: 'thread-fixture', status: 'active', objective: 'Read the snapshot', tokens_used: 7, time_used_seconds: 2 }];
process.stdout.write(JSON.stringify(rows));
`, { mode: 0o755 });
    process.env.PATH = sandbox;
    console.log = (...parts) => output.push(parts.join(' '));

    codexGoalCommand(['status', '--state', db, '--threads-db', db, '--thread', 'thread-fixture']);

    assert.deepEqual(output, [
      'Codex goal: active\nThread: thread-fixture\nObjective: Read the snapshot\nTokens/time: 7 tokens, 2s',
    ]);
  } finally {
    console.log = savedLog;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
