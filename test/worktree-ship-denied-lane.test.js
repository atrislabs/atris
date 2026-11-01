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

// A flight builds on a branch named for the job's row id, lowercased, and not for the display id a
// person reads (flightTaskName in lib/fleet.js), so the ship gate finds the job by its row id too.
// It is the last door against landing a protected-lane job without a person, so a branch that
// names the job only by its row id, with a commit message that does not say its display id, is
// blocked all the same.
const ROW_ID = '01K8Z3Q7M2X9V4B6N1C5D0EFGH';
const OTHER_ROW_ID = '01K8X3M2Q4ABCDEFGHJKMNPQRS';
const flightBranch = (id) => `codex/codex-dispatch-${id.toLowerCase()}-20261030-171500`;

test('a branch named for a denied-lane job\'s row id is blocked at ship, with no display id in the branch or the message', (t) => {
  const root = repoWithProjection(t, [
    { id: ROW_ID, display_id: 'BCK-1934', tag: 'feedback', metadata: {} },
  ]);
  const hit = deniedLaneForShip(root, flightBranch(ROW_ID), 'Fix the form');
  assert.ok(hit, 'denied lane detected');
  assert.deepStrictEqual([hit.taskId, hit.tag], ['BCK-1934', 'feedback']);
});

test('a row id on a branch finds only that job: another job\'s id, part of an id, or an id with more on it blocks nothing', (t) => {
  const root = repoWithProjection(t, [
    { id: ROW_ID, display_id: 'BCK-1934', tag: 'feedback', metadata: {} },
    { id: OTHER_ROW_ID, display_id: 'BCK-1935', tag: 'health', metadata: {} },
  ]);
  assert.strictEqual(deniedLaneForShip(root, flightBranch(OTHER_ROW_ID), 'Fix the page'), null, 'the safe job\'s own id names the safe job');
  assert.strictEqual(deniedLaneForShip(root, `codex/codex-dispatch-${ROW_ID.toLowerCase().slice(0, 20)}-20261030-171500`, 'Fix the page'), null);
  assert.strictEqual(deniedLaneForShip(root, `codex/codex-dispatch-${ROW_ID.toLowerCase()}x-20261030-171500`, 'Fix the page'), null);
  assert.strictEqual(deniedLaneForShip(root, `codex/codex-dispatch-x${ROW_ID.toLowerCase()}-20261030-171500`, 'Fix the page'), null);
});

test('a job that has a row id is still found by its display id, in the message or in an older branch name', (t) => {
  const root = repoWithProjection(t, [
    { id: ROW_ID, display_id: 'BCK-1934', tag: 'feedback', metadata: {} },
  ]);
  assert.strictEqual(deniedLaneForShip(root, 'codex/manual-branch', 'Fix the form (BCK-1934, built by codex)').tag, 'feedback');
  assert.strictEqual(deniedLaneForShip(root, 'codex/codex-dispatch-bck-1934-20261030-171500', 'Fix the form').tag, 'feedback');
});

test('a short or odd id in the list never matches words in a branch name', (t) => {
  const root = repoWithProjection(t, [
    { id: 'codex', display_id: 'BCK-1934', tag: 'feedback', metadata: {} },
    { id: 'no-such-row', display_id: 'BCK-1935', tag: 'feedback', metadata: {} },
  ]);
  assert.strictEqual(deniedLaneForShip(root, 'codex/codex-dispatch-20261030-171500', 'Fix the page'), null);
  assert.strictEqual(deniedLaneForShip(root, 'codex/no-such-row-20261030-171500', 'Fix the page'), null);
});

test('a denied-lane job in the list with a row id and no display id is found by its row id and named by it', (t) => {
  const root = repoWithProjection(t, [
    { id: ROW_ID, tag: 'feedback', metadata: {} },
  ]);
  assert.deepStrictEqual(deniedLaneForShip(root, flightBranch(ROW_ID), 'Fix the form'), { taskId: ROW_ID, tag: 'feedback' });
});
