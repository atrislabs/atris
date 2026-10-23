'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectStreamEvents } = require('../commands/stream');

test('task projection events preserve their task source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-task-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
    tasks: [{
      id: 'source-test',
      title: 'check the stream source',
      status: 'claimed',
      claimed_by: 'tester',
      updated_at: '2025-01-02T12:00:00.000Z',
    }],
  }));

  const events = collectStreamEvents({
    root,
    nowMs: Date.parse('2025-01-02T13:00:00.000Z'),
    skipLanding: true,
    deps: {
      runGit: () => ({ status: 1, stdout: '', stderr: '' }),
    },
  });

  assert.deepEqual(events.map(({ event, source }) => ({ event, source })), [
    { event: 'task_claimed', source: 'task' },
  ]);
});
