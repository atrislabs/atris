const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTaskCounts } = require('../lib/memory-view');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-counts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  return {
    root,
    write(value) {
      fs.writeFileSync(path.join(state, 'tasks.projection.json'), value);
    },
  };
}

test('counts status aliases case-insensitively and includes other tasks in total', (t) => {
  const { root, write } = fixture(t);
  write(JSON.stringify({ tasks: [
    { status: 'DONE' },
    { status: 'Accepted' },
    { status: 'ACTIVE' },
    { status: 'in_progress' },
    { status: 'Review' },
    { status: 'READY' },
    { status: 'open' },
    { status: '' },
    {},
  ] }));
  assert.deepStrictEqual(readTaskCounts(root), {
    total: 9, done: 2, active: 2, review: 2,
  });
});

test('empty, missing, and non-array task collections produce zero counts', (t) => {
  const { root, write } = fixture(t);
  for (const value of [{ tasks: [] }, {}, { tasks: null }, { tasks: {} }]) {
    write(JSON.stringify(value));
    assert.deepStrictEqual(readTaskCounts(root), {
      total: 0, done: 0, active: 0, review: 0,
    });
  }
});

test('missing, empty, and invalid projection files return null', (t) => {
  const { root, write } = fixture(t);
  assert.strictEqual(readTaskCounts(root), null);
  for (const text of ['', '{invalid json', 'null']) {
    write(text);
    assert.strictEqual(readTaskCounts(root), null);
  }
});
