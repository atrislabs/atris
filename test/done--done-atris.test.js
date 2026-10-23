'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { doneAtris } = require('../commands/done');

function fixture(t, task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-atris-'));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = path.join(root, '.home');
  process.env.USER = 'alex';
  process.env.LOGNAME = 'alex';
  fs.mkdirSync(process.env.HOME);
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'atris'));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({ tasks: [task] }));
  return root;
}

function run(root, args) {
  const output = [];
  const code = doneAtris(args, { root, builder: 'claude', log: line => output.push(line) });
  assert.strictEqual(output.length, 1);
  return { code, payload: JSON.parse(output[0]) };
}

const task = {
  id: 'local-example-task', display_id: 'T42', title: 'Build a page',
  status: 'claimed', claimed_by: 'alex',
  created_at: '2020-01-01T00:00:00.000Z', claimed_at: '2020-01-02T00:00:00.000Z',
};

test('doneAtris reports no new work for the current person without a task argument', t => {
  const root = fixture(t, task);
  const { code, payload } = run(root, ['--json']);
  assert.strictEqual(code, 0);
  assert.strictEqual(payload.schema, 'atris.one_lap.v1');
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.status, 'nothing_new');
  assert.strictEqual(payload.reason, 'nothing new here since you started Build a page');
  assert.deepStrictEqual(payload.built, []);
  assert.deepStrictEqual(payload.task, { display_id: 'T42', title: 'Build a page' });
  assert.match(payload.next_action, /claude/);
  assert.match(payload.next_action, /Build a page/);
});

test('doneAtris matches references case insensitively and reports blocked work', t => {
  const root = fixture(t, { ...task, status: 'blocked', title: '  Build   a page!? ' });
  const { code, payload } = run(root, ['t42', '--json']);
  assert.strictEqual(code, 2);
  assert.strictEqual(payload.ok, false);
  assert.strictEqual(payload.status, 'stuck');
  assert.strictEqual(payload.reason, 'Build a page is blocked');
  assert.strictEqual(payload.next_action, 'atris task show T42');
});

test('doneAtris refuses to finish when the only new file is empty', t => {
  const root = fixture(t, task);
  const file = path.join(root, 'index.html');
  fs.writeFileSync(file, '');
  const modified = new Date('2020-01-03T00:00:00.000Z');
  fs.utimesSync(file, modified, modified);
  const { code, payload } = run(root, ['T42', '--json']);
  assert.strictEqual(code, 1);
  assert.strictEqual(payload.ok, false);
  assert.strictEqual(payload.status, 'stuck');
  assert.strictEqual(payload.reason, 'nothing built has content to check yet');
  assert.deepStrictEqual(payload.built, ['index.html']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '');
});

test('doneAtris help returns usage before inspecting the workspace', t => {
  const root = fixture(t, task);
  const output = [];
  assert.strictEqual(doneAtris(['--help'], { root, log: line => output.push(line) }), 0);
  assert.deepStrictEqual(output, ['Usage: atris done [<task>] [--json]']);
});
