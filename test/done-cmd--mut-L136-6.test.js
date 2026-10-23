'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { doneAtris } = require('../commands/done');

test('done selects the matching ID prefix rather than the first task with an ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-id-prefix-'));
  const overrides = {
    HOME: path.join(root, 'home'),
    ATRIS_TASKS_DB: path.join(root, 'absent.db'),
    ATRIS_OPERATOR: 'Alex',
  };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    fs.mkdirSync(overrides.HOME);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { id: 'unrelated-task', display_id: 'T1', title: 'Unrelated work', status: 'blocked' },
        { id: 'target-task-full-id', display_id: 'T2', title: 'Requested work', status: 'blocked' },
      ],
    }));

    const output = [];
    const code = doneAtris(['TARGET-', '--json'], { root, log: line => output.push(line) });

    assert.deepEqual(output.map(line => JSON.parse(line)), [{
      schema: 'atris.one_lap.v1',
      ok: false,
      status: 'stuck',
      reason: 'Requested work is blocked',
      next_action: 'atris task show T2',
    }]);
    assert.equal(code, 2);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
