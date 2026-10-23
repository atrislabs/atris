const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { statusAtris } = require('../commands/status');
const { getLogPath } = require('../lib/journal');

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-atris-test-'));
  const originalCwd = process.cwd();
  const savedEnv = { ...process.env };

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }

  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  process.env.ATRIS_TASK_DB = '0';
  process.chdir(root);

  t.after(() => {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });

  return root;
}

function captureConsole(method, fn) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console[method] = original;
  }
  return lines;
}

function captureExit(fn) {
  const originalExit = process.exit;
  const exits = [];
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`__exit__:${code}`);
  };
  try {
    fn();
  } catch (error) {
    if (!String(error.message).startsWith('__exit__:')) throw error;
  } finally {
    process.exit = originalExit;
  }
  return exits;
}

test('normal input: statusAtris reports task board counts in json and quick modes', (t) => {
  const root = createWorkspace(t);
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });

  const todoContent = [
    '## Backlog',
    '- **T1:** Implement new feature',
    '',
    '## In Progress',
    '- **T2:** Write documentation',
    '',
    '## Completed',
    '- **T3:** Old completed task',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'), todoContent);

  const lessonsContent = [
    '- **Lesson 1:** Test thoroughly',
    '- **Lesson 2:** Keep changes small',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), lessonsContent);

  // 1. JSON mode
  const jsonLines = captureConsole('log', () => {
    statusAtris(false, true, true);
  });
  assert.strictEqual(jsonLines.length, 1);
  const data = JSON.parse(jsonLines[0]);

  assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(data.backlog.length, 1);
  assert.strictEqual(data.backlog[0].id, 'T1');
  assert.strictEqual(data.backlog[0].title, 'Implement new feature');

  assert.strictEqual(data.inProgress.length, 1);
  assert.strictEqual(data.inProgress[0].id, 'T2');
  assert.strictEqual(data.inProgress[0].title, 'Write documentation');

  assert.strictEqual(data.completed.length, 1);
  assert.strictEqual(data.completed[0].id, 'T3');
  assert.strictEqual(data.completed[0].title, 'Old completed task');

  assert.strictEqual(data.lessons, 2);
  assert.deepStrictEqual(data.inbox, []);
  assert.deepStrictEqual(data.team, []);

  // 2. Quick mode
  const quickLines = captureConsole('log', () => {
    statusAtris(true, false, true);
  });
  assert.deepStrictEqual(quickLines, ['📋 1 | 🔨 1 | ✅ 1 | 📥 0 | 📚 2']);
});

test('edge case: journal fallback for empty backlog, inbox parsing, and completion slicing', (t) => {
  const root = createWorkspace(t);
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });

  // Empty TODO.md (no backlog items)
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '## Backlog\n(empty)\n');

  // Populate daily journal with backlog fallback, inbox items, and more than 3 completions
  const { logFile } = getLogPath();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, [
    '## Backlog',
    '- **B1:** Journal backlog item',
    '',
    '## Inbox',
    '- **I10:** Review incoming report',
    '- non-task line to ignore',
    '',
    '## Completed ✅',
    '- **C1:** First completion',
    '- **C2:** Second completion',
    '- **C3:** Third completion',
    '- **C4:** Fourth completion',
    '',
  ].join('\n'));

  const jsonLines = captureConsole('log', () => {
    statusAtris(false, true, true);
  });
  assert.strictEqual(jsonLines.length, 1);
  const data = JSON.parse(jsonLines[0]);

  // Backlog fell back to journal
  assert.deepStrictEqual(data.backlog, [{ id: 'B1', title: 'Journal backlog item' }]);

  // Inbox parsed correctly
  assert.deepStrictEqual(data.inbox, [{ id: '10', title: 'Review incoming report' }]);

  // Completions capped at the last 3 items
  assert.strictEqual(data.completions.length, 3);
  assert.deepStrictEqual(data.completions, [
    { id: '2', title: 'Second completion' },
    { id: '3', title: 'Third completion' },
    { id: '4', title: 'Fourth completion' },
  ]);

  // Full visual status table verifies rendering with inbox and backlog
  const visualLines = captureConsole('log', () => {
    statusAtris(false, false, true);
  });
  assert.ok(visualLines.some(l => l.includes('📋 Backlog (1)')));
  assert.ok(visualLines.some(l => l.includes('B1: Journal backlog item')));
  assert.ok(visualLines.some(l => l.includes('📥 Inbox (1)')));
  assert.ok(visualLines.some(l => l.includes('I10: Review incoming report')));
});

test('empty case: statusAtris in fresh workspace exits reporting nothing running', (t) => {
  const root = createWorkspace(t);
  // Do not create atris/ directory -> isFreshWorkspace() will be true

  // 1. Text mode in fresh workspace exits with code 0
  let textExits;
  const textLines = captureConsole('log', () => {
    textExits = captureExit(() => {
      statusAtris(false, false, false);
    });
  });
  assert.deepStrictEqual(textExits, [0]);
  assert.ok(textLines.some(l => l.includes('nothing is running')));

  // 2. JSON mode in fresh workspace exits with code 2 and structured status
  let jsonExits;
  const jsonLines = captureConsole('log', () => {
    jsonExits = captureExit(() => {
      statusAtris(false, true, false);
    });
  });
  assert.deepStrictEqual(jsonExits, [2]);
  assert.strictEqual(jsonLines.length, 1);
  const parsed = JSON.parse(jsonLines[0]);
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.status, 'stuck');
  assert.strictEqual(parsed.reason, 'nothing is running');
});
