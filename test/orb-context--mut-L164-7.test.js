'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectOrbContext } = require('../lib/orb-context');

test('review passes alone qualify a task for the certified review greeting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-review-passes-'));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [{
      id: 'review-guide',
      title: 'Review the guide',
      status: 'review',
      review: { agent_review_pass_count: 2 },
    }],
  }));
  try {
    const result = await collectOrbContext(root, {
      now: Date.parse('2025-02-12T12:00:00Z'),
    });
    assert.strictEqual(result.greeting_facts.certifiedReviewCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
