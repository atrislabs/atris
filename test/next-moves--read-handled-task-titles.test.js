'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readHandledTaskTitles } = require('../lib/next-moves');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-handled-titles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { root, file };
}

test('reads review and done titles from the task projection in their original order', (t) => {
  const { root, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [
    { title: '  Ready for review  ', status: 'ReViEw' },
    { title: 'Still open', status: 'open' },
    { title: 'Finished task', status: 'DONE' },
    { title: 'Being worked on', status: 'claimed' },
    { title: 'Unknown state', status: 'blocked' },
    { title: 'No status' },
  ] }));

  assert.deepStrictEqual(readHandledTaskTitles(root), ['Ready for review', 'Finished task']);
});

test('explicit tasks override the projection and keep duplicate titles and internal spacing', (t) => {
  const { root, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ title: 'From disk', status: 'done' }] }));
  const tasks = [
    null, undefined, {},
    { title: '', status: 'done' },
    { title: ' \t\n ', status: 'review' },
    { title: '  Keep  spacing\t ', status: 'review' },
    { title: 'Keep  spacing', status: 'done' },
    { title: 42, status: 'done' },
  ];

  assert.deepStrictEqual(readHandledTaskTitles(root, tasks), ['Keep  spacing', 'Keep  spacing', '42']);
  assert.deepStrictEqual(readHandledTaskTitles(root, []), []);
  assert.strictEqual(tasks[5].title, '  Keep  spacing\t ');
});

test('returns an empty list for absent, empty, malformed, or unusable projections', (t) => {
  const { root, file } = fixture(t);
  assert.deepStrictEqual(readHandledTaskTitles(root), []);

  for (const content of ['', '{invalid json', 'null', '{}', '[]', '{"tasks":{}}', '{"tasks":[]}']) {
    fs.writeFileSync(file, content);
    assert.deepStrictEqual(readHandledTaskTitles(root), [], `projection content: ${JSON.stringify(content)}`);
  }
});
