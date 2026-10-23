const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectOrbContext } = require('../lib/orb-context');

test('counts certified review task when pass count is in task metadata', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-mut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [
      {
        id: 'task-1',
        title: 'Review landing candidate',
        status: 'review',
        metadata: { agent_review_pass_count: 2 },
      },
    ],
  }));

  const result = await collectOrbContext(root, { now: 1739361600000 });
  assert.strictEqual(result.greeting_facts.certifiedReviewCount, 1);
});
