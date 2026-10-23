const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findStaleTasks } = require('../commands/clean');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-stale-tasks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Undated claims exercise the supported fallback without reading the clock.
test('reports an undated claim in progress and ignores completed tasks', (t) => {
  const dir = fixture(t);
  const content = [
    '## In Progress',
    '### Task: First task   ',
    '**Claimed by:** alice',
    '## Done',
    '### Task: Completed task',
    '**Claimed by:** carol',
  ].join('\n');
  const file = path.join(dir, 'TODO.md');
  fs.writeFileSync(file, content);

  assert.deepStrictEqual(findStaleTasks(dir), [
    { title: 'First task', claimed: '**Claimed by:** alice', daysSinceClaim: '?' },
  ]);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
});

test('falls back to legacy tasks but gives an existing TODO file precedence', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'TASK_CONTEXTS.md'),
    '## In Progress\n### Task: Legacy task\n**Claimed by:** dana');
  assert.deepStrictEqual(findStaleTasks(dir), [
    { title: 'Legacy task', claimed: '**Claimed by:** dana', daysSinceClaim: '?' },
  ]);

  fs.writeFileSync(path.join(dir, 'TODO.md'), '## In Progress\n');
  assert.deepStrictEqual(findStaleTasks(dir), []);
});

test('returns no tasks for missing files, empty content, or no in-progress section', (t) => {
  const dir = fixture(t);
  assert.deepStrictEqual(findStaleTasks(dir), []);
  for (const content of ['', '## In Progress\n   \n## Done\n',
    '## In Progress\n### Task: Unclaimed task\nNo owner yet.',
    '## Done\n### Task: Finished\n**Claimed by:** erin']) {
    fs.writeFileSync(path.join(dir, 'TODO.md'), content);
    assert.deepStrictEqual(findStaleTasks(dir), []);
  }
});
