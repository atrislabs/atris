'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an older blocker updated last is reopened before a later-created blocker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocker-order-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const { handleMissionBlocker } = require('../lib/self-drive');
    const metadata = {
      mission_id: 'mission-order',
      mission_blocker_class: 'repeated-error:runner-failed',
    };
    const rows = [
      { id: 'updated-last', status: 'done', created_at: 1767225600000, updated_at: 1767484800000, metadata },
      { id: 'created-later', status: 'failed', created_at: 1767312000000, updated_at: 1767398400000, metadata },
    ];
    const result = handleMissionBlocker({
      mission: { id: 'mission-order', objective: 'restore reliable runs', status: 'paused' },
      stopReason: 'repeated-error:runner-failed',
      workspaceRoot: root,
    }, {
      taskDb: {
        open: () => ({}),
        workspaceRoot: () => root,
        listTasks: () => rows,
        withTaskDisplayRefs: (tasks) => tasks.map((row) => ({ ...row, display_id: row.id })),
        reopenTask: (_db, { id, metadata: extra }) => {
          const row = rows.find((item) => item.id === id);
          row.status = 'open';
          row.claimed_by = null;
          row.done_at = null;
          row.metadata = { ...row.metadata, ...extra };
          return { reopened: true, row };
        },
        getTask: (_db, id) => rows.find((row) => row.id === id),
        noteTask: () => ({ noted: true }),
      },
      resolveEngineForRole: () => null,
      loadSwarloApiKey: () => null,
      httpPost: () => { throw new Error('unexpected network request'); },
    });
    assert.strictEqual(result.taskId, 'updated-last');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
