const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { harvestCommand } = require('../commands/harvest');

let originalCwd;
let originalHome;
let workspace;

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const result = fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

function writeFile(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-command-test-'));
  process.env.HOME = workspace;
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('--help prints usage and does not scan the workspace', () => {
  writeFile(workspace, 'atris/thinking.md', 'We need plain English previews.\n');

  const { result, lines } = captureLog(() => harvestCommand(['--help']));

  assert.deepStrictEqual(result, { ok: true, action: 'help' });
  assert.deepStrictEqual(lines, [
    'Usage: atris harvest [--write] [--json]',
    '',
    'Find plain next actions from mission receipts, run logs, and thinking.md.',
    "Read-only by default. Use --write to append actions to today's Inbox.",
  ]);
});

test('help works with -h and the bare help word', () => {
  for (const args of [['-h'], ['help']]) {
    const { result, lines } = captureLog(() => harvestCommand(args));
    assert.deepStrictEqual(result, { ok: true, action: 'help' });
    assert.strictEqual(lines[0], 'Usage: atris harvest [--write] [--json]');
  }
});

test('empty workspace reports no actions and returns an empty payload', () => {
  const { result, lines } = captureLog(() => harvestCommand([]));

  assert.deepStrictEqual(result, {
    ok: true,
    action: 'harvest',
    write: false,
    count: 0,
    actions: [],
    writes: [],
  });
  assert.deepStrictEqual(lines, ['No harvest actions found.']);
});

test('finds actions from receipts, run logs, and thinking.md in read-only mode', () => {
  writeFile(workspace, 'atris/runs/mission-1.json', JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    objective: 'Ship the sync fix',
    result: {
      verifier_result: { passed: false },
      landing: { proof: 'proof: abc123', checked: 'npm test' },
    },
  }));
  writeFile(workspace, 'atris/logs/runs/2026-10-23.log', 'step 4\nTraceback (most recent call last)\n');
  writeFile(workspace, 'atris/thinking.md', 'Previews should be plain English for non-engineers.\n');

  const { result, lines } = captureLog(() => harvestCommand([]));

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.write, false);
  assert.strictEqual(result.count, 3);
  assert.deepStrictEqual(result.writes, []);
  assert.deepStrictEqual(result.actions.map((a) => a.id), ['I1', 'I2', 'I3']);
  assert.deepStrictEqual(result.actions.map((a) => a.title), [
    'Fix failing verifier for Ship the sync fix',
    'Turn recent run-log failures into a bounded fix task with proof',
    'Make proof and task previews plain enough to understand without opening logs',
  ]);
  assert.deepStrictEqual(result.actions.map((a) => a.source), ['receipt', 'runlog', 'thinking']);
  assert.deepStrictEqual(result.actions.map((a) => a.evidence), [
    path.join('atris', 'runs', 'mission-1.json'),
    path.join('atris', 'logs', 'runs', '2026-10-23.log'),
    'atris/thinking.md',
  ]);

  assert.deepStrictEqual(lines.slice(0, 2), [
    '- **I1:** Fix failing verifier for Ship the sync fix',
    '  reason: Ship the sync fix npm test',
  ]);
  assert.strictEqual(lines.at(-1), "Read-only. Add --write to append these to today's Inbox.");
});

test('--json prints the same payload that is returned', () => {
  writeFile(workspace, 'atris/thinking.md', 'We should stop and ask instead of inventing fake work.\n');

  const { result, lines } = captureLog(() => harvestCommand(['--json']));

  assert.strictEqual(lines.length, 1);
  const printed = JSON.parse(lines[0]);
  assert.deepStrictEqual(printed, result);
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.actions[0].title, 'Make autonomous loops stop or ask instead of inventing fake work');
  assert.strictEqual(result.actions[0].evidence, 'atris/thinking.md');
});

test('ignores receipts with a different schema', () => {
  writeFile(workspace, 'atris/runs/other.json', JSON.stringify({
    schema: 'something.else.v1',
    objective: 'Ship the sync fix',
    result: { verifier_result: { passed: false } },
  }));

  const { result } = captureLog(() => harvestCommand(['--json']));

  assert.strictEqual(result.count, 0);
  assert.deepStrictEqual(result.actions, []);
});

test('--write appends actions to today\'s inbox once and marks repeats as present', () => {
  writeFile(workspace, 'atris/thinking.md', 'We should stop and ask instead of inventing fake work.\n');

  const first = captureLog(() => harvestCommand(['--write', '--json'])).result;

  assert.strictEqual(first.write, true);
  assert.strictEqual(first.writes.length, 1);
  assert.strictEqual(first.writes[0].title, 'Make autonomous loops stop or ask instead of inventing fake work');
  assert.strictEqual(first.writes[0].already_present, false);
  assert.ok(first.writes[0].file.startsWith(path.join('atris', 'logs')), first.writes[0].file);
  const journal = fs.readFileSync(path.join(workspace, first.writes[0].file), 'utf8');
  assert.match(journal, /## Inbox/);
  assert.ok(journal.includes('Make autonomous loops stop or ask instead of inventing fake work'));

  const second = captureLog(() => harvestCommand(['--write', '--json'])).result;

  assert.strictEqual(second.writes[0].already_present, true);
});
