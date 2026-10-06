'use strict';

// Idle waiting work resolves itself on the hourly tick: landable work is left
// for the landing pass, work that can never land on its own is closed with a
// plain reason after the grace period, and protected lanes (money, deploys,
// security, customer, outward) always stay with the human.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { idleDecision, lastActivityAt, sweepIdleReviews } = require('../lib/idle-review-sweep');
const taskStore = require('../lib/task-db');
const { DAY_MS, keepTaskList } = require('../lib/task-list-keeper');

const NOW = Date.UTC(2026, 9, 6, 12);
const policy = { accept_all: true, strict_verify: true };

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idle-sweep-')));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'test-ok.mjs'), 'process.exit(0);\n');
  return root;
}

function reviewRow(overrides = {}) {
  const created = overrides.created_at ?? NOW - 10 * DAY_MS;
  return {
    id: overrides.id || 'idle-1',
    display_id: overrides.display_id || 'OBL-IDLE',
    title: overrides.title || 'Polish the inbox list',
    status: 'review',
    tag: overrides.tag ?? 'ui',
    created_at: created,
    updated_at: overrides.updated_at ?? created,
    metadata: {
      approval_status: 'pending',
      built_by: 'builder',
      verify: overrides.verify ?? 'curl https://example.com',
      latest_agent_proof: 'checked by hand',
      agent_reviewed_at: overrides.agent_reviewed_at,
    },
    review: { approval_status: 'pending', proof: 'checked by hand' },
  };
}

test('an idle row whose check can never run from main closes with a plain reason', () => {
  const root = workspace();
  const decision = idleDecision(reviewRow(), { root, policy, now: NOW });
  assert.equal(decision.action, 'close');
  assert.equal(decision.reason, 'verify_command_not_allowed');
  const swept = sweepIdleReviews(root, { tasks: [reviewRow()], policy, now: NOW, dryRun: true });
  assert.equal(swept.closed.length, 1);
  assert.match(swept.closed[0].text, /^Closed after 10 days waiting, because its check is a kind this machine may not run on its own/);
  assert.doesNotMatch(swept.closed[0].text, /[a-z]+_[a-z]+_[a-z]+/);
});

test('protected lanes stay with the human however long they sit', () => {
  const root = workspace();
  for (const row of [
    reviewRow({ tag: 'billing' }),
    reviewRow({ tag: 'deploys' }),
    reviewRow({ tag: 'security' }),
    reviewRow({ tag: '', title: 'Wire the Stripe checkout url into the paywall' }),
    reviewRow({ title: 'PROTECTED LANE: session minting, never self-land' }),
  ]) {
    const decision = idleDecision(row, { root, policy, now: NOW + 365 * DAY_MS });
    assert.equal(decision.action, 'human', row.title + ' / ' + row.tag);
  }
  const swept = sweepIdleReviews(root, { tasks: [reviewRow({ tag: 'customer' })], policy, now: NOW + 365 * DAY_MS, dryRun: true });
  assert.equal(swept.closed.length, 0);
  assert.equal(swept.human_waiting.length, 1);
});

test('work inside the grace period, or touched recently by a person, waits', () => {
  const root = workspace();
  assert.equal(idleDecision(reviewRow({ created_at: NOW - 2 * DAY_MS }), { root, policy, now: NOW }).action, 'wait');
  const reviewedYesterday = reviewRow({ agent_reviewed_at: new Date(NOW - DAY_MS).toISOString() });
  assert.equal(idleDecision(reviewedYesterday, { root, policy, now: NOW }).action, 'wait');
  assert.equal(idleDecision(reviewRow(), { root, policy: { ...policy, idle_close_days: 30 }, now: NOW }).action, 'wait');
});

test('a machine re-check bumping updated_at does not keep dead work fresh', () => {
  const row = reviewRow({ updated_at: NOW - 60 * 1000 });
  assert.equal(lastActivityAt(row, NOW), row.created_at);
  assert.equal(idleDecision(row, { root: workspace(), policy, now: NOW }).action, 'close');
});

test('landable idle work is left for the landing pass, not closed', () => {
  const root = workspace();
  const row = reviewRow({ verify: 'node scripts/test-ok.mjs' });
  row.metadata.latest_agent_proof = '`node scripts/test-ok.mjs` passed (exit 0)';
  row.review.proof = row.metadata.latest_agent_proof;
  row.events = [{ event_type: 'proof_ready', actor: 'builder' }, { event_type: 'reviewed', actor: 'land-keeper' }];
  assert.equal(idleDecision(row, { root, policy, now: NOW }).action, 'land');
});

test('a live verdict from this tick (fails on main) closes it after the grace period', () => {
  const root = workspace();
  const row = reviewRow({ verify: 'node scripts/test-ok.mjs' });
  const decision = idleDecision(row, { root, policy, now: NOW, liveReasons: new Map([['OBL-IDLE', 'verify_failed_on_main']]) });
  assert.equal(decision.action, 'close');
  assert.equal(decision.reason, 'verify_failed_on_main');
});

function hasNodeSqlite() {
  return spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], { encoding: 'utf8' }).status === 0;
}

test('the idle keeper never puts away protected-lane work', () => {
  if (!hasNodeSqlite()) return;
  const root = workspace();
  const now = Date.now();
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const plain = taskStore.addTask(db, { title: 'Old ui review', workspaceRoot: root, status: 'review', claimedBy: 'worker', tag: 'ui' }).id;
    const money = taskStore.addTask(db, { title: 'Old pricing review', workspaceRoot: root, status: 'review', claimedBy: 'worker', tag: 'billing' }).id;
    const deploy = taskStore.addTask(db, { title: 'Render deploy of the new worker', workspaceRoot: root, status: 'open' }).id;
    for (const id of [plain, money, deploy]) {
      db.prepare('UPDATE tasks SET updated_at = ?, created_at = ? WHERE id = ?').run(now - 60 * DAY_MS, now - 60 * DAY_MS, id);
    }
    const result = keepTaskList(db, { workspaceRoot: root, actor: 'tester', now, missions: [] });
    const gone = new Set(result.put_away.map((row) => row.id));
    assert.equal(gone.has(plain), true);
    assert.equal(gone.has(money), false);
    assert.equal(gone.has(deploy), false);
    assert.equal(taskStore.getTask(db, money).status, 'review');
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hourly tick leaves finished rows on the list for the digest', () => {
  if (!hasNodeSqlite()) return;
  const root = workspace();
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const finished = taskStore.addTask(db, { title: 'Just landed', workspaceRoot: root }).id;
    taskStore.doneTask(db, { id: finished, status: 'done', actor: 'tester', proof: 'done' });
    keepTaskList(db, { workspaceRoot: root, actor: 'autoland', now: Date.now(), missions: [], includeDone: false });
    assert.equal(taskStore.getTask(db, finished).status, 'done');
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
