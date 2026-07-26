const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { deniedLaneForShip } = require('../commands/worktree');

function repoWithProjection(tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-lane-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: root });
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.projection.json'), JSON.stringify({ tasks }));
  return root;
}

test('a branch carrying a denied-lane task is blocked at ship', () => {
  const root = repoWithProjection([
    { display_id: 'CLI-1196', tag: 'billing', metadata: {} },
  ]);
  const hit = deniedLaneForShip(root, 'codex/claude-fleet-cli-1196-20260726', 'gift re-land (CLI-1196, built by claude)');
  assert.ok(hit, 'denied lane detected');
  assert.strictEqual(hit.taskId, 'CLI-1196');
  assert.strictEqual(hit.tag, 'billing');
});

test('a safe-lane branch ships without a block', () => {
  const root = repoWithProjection([
    { display_id: 'CLI-1200', tag: 'health', metadata: {} },
  ]);
  assert.strictEqual(deniedLaneForShip(root, 'codex/fleet-cli-1200', 'radar fix (CLI-1200)'), null);
});

test('no task reference means no block', () => {
  const root = repoWithProjection([]);
  assert.strictEqual(deniedLaneForShip(root, 'codex/manual-branch', 'hand work'), null);
});
