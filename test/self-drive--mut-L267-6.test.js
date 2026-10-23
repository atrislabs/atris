'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleMissionBlocker } = require('../lib/self-drive');

test('an open blocker can dispatch with a task store that has no claim operation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-optional-claim-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const rows = [];
  let dispatched = false;
  const result = handleMissionBlocker({
    mission: { id: 'mission-repair', objective: 'repair exports', status: 'paused' },
    stopReason: 'runner-failed',
    workspaceRoot: root,
  }, {
    taskDb: {
      open: () => ({}),
      workspaceRoot: () => root,
      listTasks: () => rows,
      withTaskDisplayRefs: (tasks) => tasks,
      addTask: (_db, input) => {
        rows.push({ id: 'repair-task', status: 'open', created_at: 1, updated_at: 1, ...input });
        return { id: 'repair-task', inserted: true };
      },
      getTask: () => rows[0],
      noteTask: () => ({ noted: true }),
    },
    resolveEngineForRole: () => ({ id: 'codex' }),
    createAgentWorktree: () => ({ path: path.join(root, 'repair') }),
    dispatchToEngine: () => { dispatched = true; return { exitCode: 0 }; },
    recordDispatchOutcome: () => null,
    loadSwarloApiKey: () => null,
    httpPost: () => { throw new Error('unexpected network request'); },
    clock: () => 1780000000000,
  });
  assert.equal(result.dispatched, true);
  assert.equal(dispatched, true);
});
