const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These synchronous tests change process-wide state and must run serially.
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-command-'));
  const cwd = process.cwd();
  const keys = ['HOME', 'ATRIS_TASKS_DB', 'ATRIS_TASK_DB'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    process.chdir(cwd);
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  process.env.ATRIS_TASK_DB = '0';
  process.chdir(root);
  fs.mkdirSync(path.join(root, 'atris'));
  return root;
}

function capture(t) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  t.after(() => { console.log = original; });
  return lines;
}

test('JSON status reads journal backlog, inbox, recent completions and lessons', { concurrency: false }, t => {
  const root = workspace(t);
  const { statusAtris } = require('../commands/status');
  const { getLogPath } = require('../lib/journal');
  const { logFile, dateFormatted } = getLogPath();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, [
    '## Backlog', '- **B1:** Ship the report', '',
    '## Inbox', '- **I7:** Read the feedback', '- ordinary note', '',
    '## Completed ✅', '- **C1:** First', '- **C2:** Second',
    '- **C3:** Third', '- **C4:** Fourth', '', '## Notes', 'ignored',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'),
    '- **Keep:** Useful lesson\nordinary text\n- **Check:** Another lesson\n');
  const lines = capture(t);

  assert.strictEqual(statusAtris(false, true, true), undefined);
  assert.strictEqual(lines.length, 1);
  const output = JSON.parse(lines[0]);
  assert.strictEqual(output.date, dateFormatted);
  assert.deepStrictEqual(output.backlog, [{ id: 'B1', title: 'Ship the report' }]);
  assert.deepStrictEqual(output.inProgress, []);
  assert.deepStrictEqual(output.completed, []);
  assert.deepStrictEqual(output.inbox, [{ id: '7', title: 'Read the feedback' }]);
  assert.deepStrictEqual(output.completions, [
    { id: '2', title: 'Second' },
    { id: '3', title: 'Third' },
    { id: '4', title: 'Fourth' },
  ]);
  assert.strictEqual(output.lessons, 2);
  assert.deepStrictEqual(output.team, []);
});

test('quick status prints empty counts and creates the missing daily journal', { concurrency: false }, t => {
  workspace(t);
  const { statusAtris } = require('../commands/status');
  const { getLogPath } = require('../lib/journal');
  const { logFile, dateFormatted } = getLogPath();
  assert.strictEqual(fs.existsSync(logFile), false);
  const lines = capture(t);

  statusAtris(true, false, true);

  assert.deepStrictEqual(lines, ['📋 0 | 🔨 0 | ✅ 0 | 📥 0 | 📚 0']);
  const journal = fs.readFileSync(logFile, 'utf8');
  assert.ok(journal.startsWith(`# Log, ${dateFormatted}\n`));
  assert.ok(journal.includes('## Inbox\n'));
  assert.ok(journal.includes('## Backlog\n'));
});
