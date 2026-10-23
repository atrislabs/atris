'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocked-count-'));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { collectSnapshot } = require('../commands/stream');

test('blocked work counts as waiting for the operator', () => {
  const state = path.join(home, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.tasks_projection.v1',
    generated_at: '2026-07-06T12:00:00.000Z',
    tasks: [{
      id: 'task-needs-access',
      title: 'restore deployment access',
      status: 'blocked',
      claimed_by: 'builder',
      updated_at: '2026-07-06T09:00:00.000Z',
      events: [],
    }],
  }));
  const snapshot = collectSnapshot({
    root: home,
    nowMs: Date.parse('2026-07-06T12:00:00.000Z'),
    skipLanding: true,
    deps: {
      listWorktrees: () => [],
      runGit: () => ({ status: 1, stdout: '', stderr: '' }),
    },
  });
  assert.equal(snapshot.waiting_operator, 1);
});

test.after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});
