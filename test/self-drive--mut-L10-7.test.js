'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('fleet escalation uses the configured hub URL when the legacy setting is absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hub-url-'));
  const keys = ['HOME', 'SWARLO_HUB_URL', 'SWARLO_HUB'];
  const previous = keys.map(key => process.env[key]);
  process.env.HOME = home;
  process.env.SWARLO_HUB_URL = 'https://fleet.example.com';
  delete process.env.SWARLO_HUB;
  try {
    const { handleMissionBlocker } = require('../lib/self-drive');
    const rows = [];
    let destination;
    handleMissionBlocker({
      mission: { id: 'mission-hub-url', objective: 'repair a failed build', status: 'paused' },
      stopReason: 'runner-failed',
      workspaceRoot: home,
    }, {
      taskDb: {
        open: () => ({}),
        workspaceRoot: root => root,
        listTasks: () => rows,
        withTaskDisplayRefs: tasks => tasks,
        addTask: (_db, input) => {
          rows.push({ ...input, id: 'blocker-task', status: 'open' });
          return { id: 'blocker-task', inserted: true };
        },
      },
      resolveEngineForRole: () => null,
      loadSwarloApiKey: () => 'test-api-key',
      httpPost: url => {
        destination = url;
        return { ok: true, status: 201, body: '{"post_id":"escalation-post"}' };
      },
    });
    assert.equal(new URL(destination).origin, 'https://fleet.example.com');
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
