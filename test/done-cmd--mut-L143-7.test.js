'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { doneAtris } = require('../commands/done');

test('done selects the current person\'s task over another person\'s newer task', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-owner-'));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = path.join(root, '.home');
  process.env.ATRIS_OPERATOR = 'alex';
  process.env.ATRIS_TASKS_DB = path.join(root, '.home', 'tasks.db');
  fs.mkdirSync(process.env.HOME);
  fs.mkdirSync(path.join(root, 'atris'));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  // Neither task is an onboarding starter, so selection must respect ownership.
  fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({ tasks: [
      {
        id: 'alex-task', display_id: 'T1', title: 'Repair the menu',
        status: 'claimed', claimed_by: 'alex', updated_at: 1000,
        claimed_at: '2020-01-01T00:00:00.000Z',
      },
      {
        id: 'sam-task', display_id: 'T2', title: 'Repair the footer',
        status: 'claimed', claimed_by: 'sam', updated_at: 2000,
        claimed_at: '2020-01-01T00:00:00.000Z',
      },
    ] }));

  const output = [];
  assert.equal(doneAtris(['--json'], {
    root, builder: 'claude', log: line => output.push(line),
  }), 0);
  assert.deepEqual(output, [JSON.stringify({
    schema: 'atris.one_lap.v1',
    ok: true,
    status: 'nothing_new',
    reason: 'nothing new here since you started Repair the menu',
    task: { display_id: 'T1', title: 'Repair the menu' },
    built: [],
    next_action: 'claude "Repair the menu"',
  }, null, 2)]);
});
