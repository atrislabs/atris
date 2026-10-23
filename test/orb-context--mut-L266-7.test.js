'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectOrbContext } = require('../lib/orb-context');

test('a single failed task keeps its task id in the repair suggestion side', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-failed-task-'));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [{ id: 'repair-release', title: 'Repair the release', status: 'failed' }],
  }));

  const result = await collectOrbContext(root, { now: Date.parse('2025-02-12T12:00:00Z') });
  const repair = result.suggestions.find((suggestion) => suggestion.side === 'repair-release');
  assert.equal(repair?.side, 'repair-release');
});
