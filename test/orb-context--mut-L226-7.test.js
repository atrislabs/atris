'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectOrbContext } = require('../lib/orb-context');

test('backlog tasks with different titles that shorten to the same label offer one start choice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-duplicate-backlog-'));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [
      { id: 'guide-one', title: 'Write the deployment guide for the entire engineering team alpha', status: 'open' },
      { id: 'guide-two', title: 'Write the deployment guide for the entire engineering team beta', status: 'open' },
    ],
  }));
  const result = await collectOrbContext(root, { now: Date.parse('2025-02-12T12:00:00Z') });
  assert.equal(result.suggestions.filter((suggestion) => suggestion.id.startsWith('start:')).length, 1);
});
