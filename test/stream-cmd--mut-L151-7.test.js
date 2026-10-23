'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectStreamEvents } = require('../commands/stream');

test('task completed and done events produce finished summary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stream-mut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, 'tasks.projection.json'),
    JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          title: 'clean the engine',
          status: 'completed',
          events: [
            {
              event_type: 'completed',
              actor: 'alice',
              created_at: '2026-07-06T08:00:00.000Z',
            },
            {
              event_type: 'done',
              actor: 'bob',
              created_at: '2026-07-06T08:05:00.000Z',
            },
          ],
        },
      ],
    }),
  );

  const events = collectStreamEvents({
    root,
    sinceMs: Date.parse('2026-07-06T07:00:00.000Z'),
    nowMs: Date.parse('2026-07-06T09:00:00.000Z'),
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].summary, 'finished clean the engine.');
  assert.equal(events[1].summary, 'finished clean the engine.');
});
