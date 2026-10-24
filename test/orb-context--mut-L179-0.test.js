'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectOrbContext } = require('../lib/orb-context');

test('multiple failed tasks use a plural noun in the unblock suggestion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-plural-'));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [
      { id: 'draft', title: 'Write the draft', status: 'failed', certified: true },
      { id: 'guide', title: 'Write the guide', status: 'failed', certified: true },
    ],
  }));
  const result = await collectOrbContext(root, { now: Date.parse('2025-02-12T12:00:00Z') });
  const suggestion = result.suggestions.find((item) => item.id === 'unblock:failed-tasks');
  assert.match(suggestion.label, /\bfailed tasks\b/);
});
