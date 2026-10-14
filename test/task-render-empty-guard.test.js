const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function hasNodeSqlite() {
  try { require('node:sqlite'); return true; } catch { return false; }
}

function setup(todo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-render-guard-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  const todoPath = path.join(dir, 'atris', 'TODO.md');
  fs.writeFileSync(todoPath, todo, 'utf8');
  const env = { ...process.env, ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  const run = args => spawnSync(process.execPath, [BIN, 'task', 'render', '--out', 'atris/TODO.md', ...args], {
    cwd: dir, env, encoding: 'utf8', timeout: 15000,
  });
  return { dir, todoPath, run };
}

// A rendered board whose tasks live in some other database, the way an agent
// copy of the repo sees the main checkout's board.
const GENERATED_BOARD = [
  '# TODO.md',
  '',
  '> Regenerated from durable Atris task state. Do not treat this file as truth.',
  '',
  '## Backlog',
  '',
  '- **[CLI-9]** Ship the thing',
  '',
  '## In Progress',
  '',
  '- **[CLI-8]** Fix the other thing · codex',
  '',
  '## Review',
  '',
  '(Empty)',
  '',
].join('\n');

test('render refuses to replace a board of live tasks with an empty one', () => {
  if (!hasNodeSqlite()) return;
  const { dir, todoPath, run } = setup(GENERATED_BOARD);
  try {
    const result = run([]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /refused/);
    assert.match(result.stderr, /2 live tasks/);
    assert.match(result.stderr, /main checkout/);
    assert.equal(fs.readFileSync(todoPath, 'utf8'), GENERATED_BOARD);

    const json = run(['--json']);
    assert.equal(json.status, 2);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.action, 'refused');
    assert.equal(payload.live_tasks_in_file, 2);
    assert.equal(fs.readFileSync(todoPath, 'utf8'), GENERATED_BOARD);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render empties the board on purpose with --allow-empty', () => {
  if (!hasNodeSqlite()) return;
  const { dir, todoPath, run } = setup(GENERATED_BOARD);
  try {
    const result = run(['--allow-empty']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(todoPath, 'utf8'), /## Backlog\n\n\(Empty\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render still imports a hand-written board into an empty database', () => {
  if (!hasNodeSqlite()) return;
  const handBoard = ['# TODO.md', '', '## Backlog', '', '- **[T1]** Hand written task', ''].join('\n');
  const { dir, todoPath, run } = setup(handBoard);
  try {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(todoPath, 'utf8'), /Hand written task/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
