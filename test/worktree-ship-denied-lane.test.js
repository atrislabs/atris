const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { deniedLaneForShip } = require('../commands/worktree');

function repoWithProjection(t, tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-lane-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: root });
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.projection.json'), JSON.stringify({ tasks }));
  return root;
}

test('a branch carrying a denied-lane task is blocked at ship', (t) => {
  const root = repoWithProjection(t, [
    { display_id: 'CLI-1196', tag: 'billing', metadata: {} },
  ]);
  const hit = deniedLaneForShip(root, 'codex/claude-fleet-cli-1196-20260726', 'gift re-land (CLI-1196, built by claude)');
  assert.ok(hit, 'denied lane detected');
  assert.strictEqual(hit.taskId, 'CLI-1196');
  assert.strictEqual(hit.tag, 'billing');
});

// The fleet's staffing check reads a task's tags from its tag, its tags list, the tags `atris task tag`
// adds later (metadata.tags) and hashtags in its title. A task it holds back as protected has to be
// blocked here too, or a builder could merge what staffing treats as a person's to land.
test('a lane the task got after it was made, or in its title, is blocked at ship too', (t) => {
  const root = repoWithProjection(t, [
    { display_id: 'CLI-1201', tag: 'code', metadata: { tags: ['security'] } },
    { display_id: 'CLI-1202', tag: 'code', tags: ['deploy'], metadata: {} },
    { display_id: 'CLI-1203', tag: 'code', title: 'Rotate the keys #payments', metadata: {} },
    { display_id: 'CLI-1204', tag: 'code', title: 'Tighten security on the billing page', metadata: { tags: ['ui'] } },
  ]);
  const gate = (id) => deniedLaneForShip(root, `codex/fleet-${id.toLowerCase()}`, `fix (${id})`);
  assert.deepStrictEqual(gate('CLI-1201'), { taskId: 'CLI-1201', tag: 'security' });
  assert.deepStrictEqual(gate('CLI-1202'), { taskId: 'CLI-1202', tag: 'deploy' });
  assert.deepStrictEqual(gate('CLI-1203'), { taskId: 'CLI-1203', tag: 'payments' });
  assert.strictEqual(gate('CLI-1204'), null, 'words in a title are not a lane');
});

test('a safe-lane branch ships without a block', (t) => {
  const root = repoWithProjection(t, [
    { display_id: 'CLI-1200', tag: 'health', metadata: {} },
  ]);
  assert.strictEqual(deniedLaneForShip(root, 'codex/fleet-cli-1200', 'radar fix (CLI-1200)'), null);
});

test('no task reference means no block', (t) => {
  const root = repoWithProjection(t, []);
  assert.strictEqual(deniedLaneForShip(root, 'codex/manual-branch', 'hand work'), null);
});
