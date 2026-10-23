'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleMissionBlocker } = require('../lib/self-drive');

test('blocker task title preserves a concrete failure description', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocker-title-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rows = [];
  handleMissionBlocker({
    mission: { id: 'mission-title', objective: 'repair exports', status: 'paused' },
    stopReason: 'runner-failed',
    workspaceRoot: root,
  }, {
    taskDb: {
      open: () => ({}),
      listTasks: () => rows,
      withTaskDisplayRefs: (tasks) => tasks,
      addTask: (_db, input) => {
        rows.push({ id: 'task-title', status: 'open', ...input });
        return { id: 'task-title', inserted: true };
      },
      getTask: () => rows[0],
      noteTask: () => ({ noted: true }),
    },
    resolveEngineForRole: () => null,
    loadSwarloApiKey: () => null,
  });
  assert.match(rows[0].title, /runner failed/);
});
