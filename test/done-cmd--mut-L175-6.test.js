'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('a failed check without a JSON explanation reports its stderr', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-check-error-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  t.after(() => {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.USER = 'alex';
  process.env.LOGNAME = 'alex';
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  process.chdir(root);
  fs.mkdirSync(path.join(root, 'atris'));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({ tasks: [{
      id: 'example', display_id: 'T42', title: 'Build a page',
      status: 'claimed', claimed_by: 'alex',
      created_at: '2020-01-01T00:00:00.000Z',
      claimed_at: '2020-01-02T00:00:00.000Z',
    }] }));
  const notes = path.join(root, 'notes.md');
  fs.writeFileSync(notes, '# Walks\nweekday mornings\n');
  fs.utimesSync(notes, 1578009600, 1578009600);

  t.mock.method(childProcess, 'spawnSync', () => ({
    status: 1, stdout: JSON.stringify({ ok: false }), stderr: 'permission denied',
  }));
  const { doneAtris } = require('../commands/done');
  const output = [];
  doneAtris(['T42', '--json'], { root, builder: 'claude', log: line => output.push(line) });
  assert.match(JSON.parse(output.join('\n')).reason, /permission denied/);
});
