'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { doneAtris } = require('../commands/done');

test('a failed acceptance preserves the database error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-lookup-'));
  const saved = { ...process.env };
  const cwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      HOME: root, USER: 'alex', LOGNAME: 'alex',
      ATRIS_TASKS_DB: root,
      ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1',
    });
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ tasks: [{
      id: 'missing-local-task', display_id: 'T42', title: 'Build a page',
      status: 'review', claimed_by: 'alex',
      created_at: '2020-01-01T00:00:00.000Z', claimed_at: '2020-01-02T00:00:00.000Z',
    }] }));
    const file = path.join(root, 'index.html');
    fs.writeFileSync(file, '<html><body>Welcome</body></html>');
    fs.utimesSync(file, new Date('2020-01-03T00:00:00Z'), new Date('2020-01-03T00:00:00Z'));
    let payload;
    doneAtris(['T42', '--json'], { root, builder: 'claude', log: line => { payload = JSON.parse(line); } });
    assert.match(payload.reason, /database/i);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
