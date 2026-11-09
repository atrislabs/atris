'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agentCaller, planningNeeds, recommendAgentWork, buildAgentNext } = require('../lib/agent-next');

const readyPlan = {
  assigned_to: 'builder', stage: 'plan', task_goal: 'Make saved notes readable',
  exit_condition: 'The saved note can be read', first_move: 'Inspect the reader',
  verify: 'node --test test/notes.test.js',
};
function task(id, metadata = {}, values = {}) {
  return { id, display_id: 'CLI-' + id, title: 'Read saved notes', status: 'open', created_at: Number(id) || 1, metadata, ...values };
}
const choose = (tasks, options = {}) => recommendAgentWork({ tasks, member: 'builder', ...options });

test('agent identity uses explicit member, known worker markers and a functional default', () => {
  assert.equal(agentCaller([], {}), null);
  assert.equal(agentCaller(['--human'], { CODEX_SANDBOX: '1' }), null);
  assert.equal(agentCaller([], { CODEX_THREAD_ID: 'thread', ATRIS_AGENT_PROOF_ONLY: '0' }), null);
  assert.equal(agentCaller([], { CODEX_THREAD_ID: 'thread' }).member, 'builder');
  assert.equal(agentCaller(['--agent', 'validator'], {}).member, 'validator');
  assert.equal(agentCaller(['--agent', '--as', 'builder'], {}).member, 'builder');
  assert.equal(agentCaller(['--agent', 'builder', '--as', 'validator'], {}).error, 'conflicting_owner');
  assert.equal(agentCaller(['--agent', 'bad member'], {}).error, 'invalid_owner');
});

test('a certified review remains pending while the assigned unchecked follow-up gets planning', () => {
  const review = task('1', { agent_certified: true, agent_review_pass_count: 2 }, { status: 'review', claimed_by: 'builder' });
  const work = task('2', { assigned_to: 'builder' });
  const result = choose([review, work]);
  assert.equal(result.task.id, work.id);
  assert.equal(result.action, 'plan');
  assert.ok(result.needs.includes('runnable_check'));
  assert.equal(result.human_pending[0].task_id, review.id);
  assert.equal(result.human_pending[0].human_only, true);
});

test('a complete plan permits a claim and an own claim permits continuation', () => {
  const work = task('1', { ...readyPlan });
  assert.deepEqual(planningNeeds(work), []);
  assert.equal(choose([work]).action, 'claim');
  work.status = 'claimed';
  work.claimed_by = 'builder';
  assert.equal(choose([work]).action, 'continue');
});

test('a check alone is not a complete plan and malformed checks lead to planning', () => {
  const work = task('1', { assigned_to: 'builder', verify: 'node --test test/notes.test.js' });
  assert.equal(choose([work]).action, 'plan');
  for (const verify of ['', 'please test this', 'node --test test/notes.test.js; echo unsafe', 'x'.repeat(601)]) {
    const result = choose([task('2', { ...readyPlan, verify })]);
    assert.equal(result.action, 'plan');
    assert.ok(result.needs.includes('runnable_check'));
  }
});

test('ownership and human or protected holds outrank a runnable check', () => {
  const safe = task('9', { ...readyPlan });
  const rows = [
    task('1', { ...readyPlan, assigned_to: 'other' }),
    task('2', { ...readyPlan }, { status: 'claimed', claimed_by: 'other' }),
    task('3', { ...readyPlan, tags: ['needs-human'] }),
    task('4', { ...readyPlan }, { tag: 'billing' }),
    task('5', { ...readyPlan }, { title: 'Run a production deploy' }),
    task('6', { ...readyPlan }, { status: 'done' }),
    task('7', { ...readyPlan }, { status: 'failed' }),
    safe,
  ];
  assert.equal(choose(rows).task.id, safe.id);
});

test('own claims precede assigned open work, which precedes matching unassigned work', () => {
  const generic = task('1', { ...readyPlan, assigned_to: null });
  const assigned = task('2', { ...readyPlan });
  const claimed = task('3', { ...readyPlan }, { status: 'claimed', claimed_by: 'builder' });
  assert.equal(choose([generic, assigned, claimed]).task.id, claimed.id);
  assert.equal(choose([generic, assigned]).task.id, assigned.id);
});

test('projection and mixed evidence never permit a claim or continuation', () => {
  for (const taskSource of ['projection', 'mixed', 'none']) {
    const result = choose([task('1', { ...readyPlan })], { taskSource });
    assert.equal(result.action, 'discover');
    assert.ok(result.needs.includes('authoritative_task_state'));
    const review = task('2', { agent_certified: true }, { status: 'review' });
    const bound = choose([review], { taskSource, taskId: review.id });
    assert.equal(bound.action, 'discover');
    assert.deepEqual(bound.human_pending, []);
  }
});

test('a requested binding never falls through to other work', () => {
  const held = task('1', { ...readyPlan, assigned_to: 'other' });
  const safe = task('2', { ...readyPlan });
  const done = task('3', { ...readyPlan }, { status: 'done' });
  assert.equal(choose([held, safe], { taskId: held.id }).action, 'blocked');
  assert.equal(choose([done, safe], { taskId: done.id }).action, 'blocked');
  assert.equal(choose([safe], { taskId: 'missing' }).task, null);
});

test('only an independent review role can receive an unfinished review', () => {
  const review = task('1', { ...readyPlan, built_by: ['builder'] }, { status: 'review', claimed_by: 'builder' });
  assert.equal(choose([review]).action, 'discover');
  assert.equal(choose([review], { member: 'validator', job: 'review' }).action, 'review');
  assert.equal(choose([review], { member: 'builder', job: 'review' }).action, 'discover');
  review.metadata.agent_certified = true;
  assert.equal(choose([review], { member: 'validator', job: 'review' }).action, 'discover');
});

test('an empty or finished queue asks for discovery and never manufactures work', () => {
  for (const rows of [[], [task('1', {}, { status: 'done' })]]) {
    const result = choose(rows);
    assert.equal(result.action, 'discover');
    assert.equal(result.task, null);
    assert.ok(result.needs.includes('eligible_task'));
  }
});

test('malformed snapshot identities and invalid caller names stay bounded and cannot emit commands', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-next-bounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const huge = 'x'.repeat(50000);
  const rows = [task(huge, { ...readyPlan }), task('2', { agent_certified: true }, { status: 'review' })];
  const projected = buildAgentNext({ root, args: ['--agent', 'builder'], snapshot: { source: 'projection', tasks: rows } });
  assert.equal(projected.action, 'discover');
  assert.equal(projected.task_id, null);
  assert.equal(projected.command, null);
  assert.deepEqual(projected.human_pending, []);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 16000);
  const invalid = buildAgentNext({ root, args: ['--agent', huge], snapshot: { source: 'none', tasks: [] } });
  assert.equal(invalid.action, 'blocked');
  assert.equal(invalid.actor.member, null);
  assert.equal(invalid.command, null);
  assert.ok(Buffer.byteLength(JSON.stringify(invalid)) < 16000);
});

test('normalized and historical contributors cannot be offered an independent review', () => {
  const alias = task('1', { built_by: 'Codex_Review' }, { status: 'review', claimed_by: 'builder' });
  assert.notEqual(choose([alias], { member: 'codex-review', job: 'review' }).action, 'review');
  for (const event of [
    { event_type: 'claimed', actor: 'Codex_Review', payload: { claimed_by: 'Codex_Review' } },
    { event_type: 'proof_ready', actor: 'builder', payload: { handed_in_by: 'builder', built_with: ['Codex_Review'] } },
  ]) {
    const history = task('2', { built_by: 'builder' }, { status: 'review', claimed_by: 'builder', events: [event] });
    assert.notEqual(choose([history], { member: 'codex-review', job: 'review' }).action, 'review');
  }
});

test('bound untrusted owner and status fields cannot escape the outer packet budget', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-next-owner-bounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const huge = 'x'.repeat(50000);
  const row = task('1', { ...readyPlan, assigned_to: huge }, { claimed_by: huge, status: huge });
  const value = buildAgentNext({ root, args: ['--agent', 'builder', '--task', row.id], snapshot: { source: 'projection', tasks: [row] } });
  assert.ok(value.task.claimed_by === null, 'oversized claimant is withheld');
  assert.ok(value.task.assigned_to === null, 'oversized assignee is withheld');
  assert.ok(value.task.status === null, 'unknown status is withheld');
  assert.equal(value.action, 'discover');
  assert.equal(value.command, null);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...value, next_action: value.command }, null, 2) + '\n') <= 16000);
});

test('oversized preloaded evidence fails closed within the final formatted packet budget', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-next-evidence-bounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = { task_source: 'x'.repeat(50000), next_step: { kind: 'discover' }, goal: { text: 'x'.repeat(50000) }, parts: [], candidates: [], recent_outcomes: [], gaps: [] };
  const value = buildAgentNext({ root, args: ['--agent', 'builder'], snapshot: { source: 'projection', tasks: [] }, evidence });
  assert.equal(value.action, 'discover');
  assert.equal(value.command, null);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...value, next_action: value.command }, null, 2) + '\n') <= 16000);
});
