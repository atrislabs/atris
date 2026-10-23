const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reviewCommand } = require('../commands/review');

test('review does not discover an engine three parents above the working directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-depth-'));
  const cwd = path.join(root, 'one', 'two', 'three');
  const engine = path.join(root, 'atris', 'business', 'claude-code-review', 'workspace');
  const original = { cwd: process.cwd(), log: console.log, error: console.error, exit: process.exit };
  const logs = [];
  const errors = [];
  const exitSignal = new Error('captured exit');
  let exitCode;

  try {
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(engine, { recursive: true });
    // Discovery alone should distinguish the boundary; no engine is executed.
    fs.writeFileSync(path.join(engine, 'review_engine.py'), '');
    process.chdir(cwd);
    console.log = (message) => logs.push(message);
    console.error = (message) => errors.push(message);
    process.exit = (code) => { exitCode = code; throw exitSignal; };

    await assert.rejects(reviewCommand('--all', '--json'), (error) => error === exitSignal);
    assert.deepEqual(errors, []);
    assert.deepEqual(logs, [JSON.stringify({
      ok: false,
      error: 'not installed',
      expected: 'atris/business/claude-code-review/workspace/review_engine.py',
      specialists: ['Security', 'Testing', 'Performance', 'Maintainability', 'Database', 'Async'],
      install: 'atris skill install code-review',
    }, null, 2)]);
    assert.equal(exitCode, 2);
  } finally {
    process.chdir(original.cwd);
    console.log = original.log;
    console.error = original.error;
    process.exit = original.exit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
