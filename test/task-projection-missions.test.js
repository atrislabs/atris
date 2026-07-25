const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectionMissions, projectionWishes } = require('../commands/task');

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'projection-test-'));
}

test('empty or missing stores yield empty arrays, never a throw', () => {
  const root = tempWorkspace();
  assert.deepStrictEqual(projectionMissions(root), []);
  assert.deepStrictEqual(projectionWishes(root), []);
});

test('an active mission reaches the projection with dashboard fields', () => {
  const root = tempWorkspace();
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'missions.jsonl'), JSON.stringify({
    schema: 'atris.mission.v1',
    id: 'mission-test-abc',
    objective: 'prove the dashboard sees live work',
    status: 'ready',
    owner: 'task-planner',
    runner: 'claude',
    cadence: 'manual',
    lane: 'workspace',
    next_action: 'first tick',
    last_tick_at: null,
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  }) + '\n');
  const missions = projectionMissions(root);
  assert.strictEqual(missions.length, 1);
  const m = missions[0];
  assert.strictEqual(m.id, 'mission-test-abc');
  assert.strictEqual(m.status, 'ready');
  assert.strictEqual(m.owner, 'task-planner');
  assert.strictEqual(m.runner, 'claude');
  assert.strictEqual(m.next_action, 'first tick');
});

test('stale completed missions are excluded, open wishes included and closed ones dropped', () => {
  const root = tempWorkspace();
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'missions.jsonl'), JSON.stringify({
    schema: 'atris.mission.v1', id: 'mission-old-done', objective: 'ancient history',
    status: 'complete', updated_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
  }) + '\n');
  assert.deepStrictEqual(projectionMissions(root), []);

  const events = [
    { id: 'wish-open-1', n: 1, ts: '2026-07-25T00:00:00.000Z', text: 'an open wish', status: 'captured' },
    { id: 'wish-closed-1', n: 2, ts: '2026-07-25T00:00:00.000Z', text: 'a closed wish', status: 'captured' },
    { id: 'wish-closed-1', n: 2, ts: '2026-07-25T01:00:00.000Z', text: 'a closed wish', status: 'closed' },
  ];
  fs.writeFileSync(path.join(dir, 'wishes.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const wishes = projectionWishes(root);
  const ids = wishes.map(w => w.id);
  assert.ok(ids.includes('wish-open-1'), 'open wish present');
  assert.ok(!ids.includes('wish-closed-1'), 'closed wish dropped');
});
