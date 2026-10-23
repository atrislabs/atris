'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleMissionBlocker } = require('../lib/self-drive');

test('a different blocker on the same mission does not suppress a new repair task', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocker-class-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rows = [{
    id: 'prior-repair', status: 'open', created_at: 1, updated_at: 1,
    metadata: { mission_id: 'mission-widget', mission_blocker_class: 'verifier-failed' },
  }];
  const result = handleMissionBlocker({
    mission: { id: 'mission-widget', objective: 'repair the widget', status: 'paused' },
    stopReason: 'repeated-error:runner-failed',
    workspaceRoot: root,
  }, {
    taskDb: {
      open: () => ({}),
      workspaceRoot: () => root,
      listTasks: () => rows,
      withTaskDisplayRefs: tasks => tasks.map(row => ({ ...row, display_id: row.id })),
      addTask: (_db, input) => {
        rows.push({ id: 'new-repair', status: 'open', created_at: 2, updated_at: 2, ...input });
        return { id: 'new-repair', inserted: true };
      },
      getTask: (_db, id) => rows.find(row => row.id === id),
      noteTask: () => ({ noted: true }),
    },
    resolveEngineForRole: () => null,
    loadSwarloApiKey: () => null,
  });
  assert.equal(result.taskId, 'new-repair');
});
