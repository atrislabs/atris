// Part 5 of 8 of the commands suite, split so node --test runs them in parallel.
// Shared imports and fixture helpers live in test/helpers/commands-fixtures.js.
const test = require('node:test');
const {
  assert,
  fs,
  path,
  http,
  acceptedInLastDay,
  writePolicy,
  taskStore,
  makeTempDir,
  cleanupTempDir,
  runCli,
  hasNodeSqlite,
} = require('./helpers/commands-fixtures');

test('task current returns read-only selected page and queue lanes', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewAdd = runCli(['task', 'add', 'Verify this task before more work', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(reviewAdd.status, 0, reviewAdd.stderr);
    const reviewTask = JSON.parse(reviewAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', reviewTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', reviewTask.display_id,
	      '--as', 'codex',
	      '--proof', 'node --check test/commands.test.js passed for current selector review',
	      '--next', 'Create a continuation only after agent certification',
	    ], { cwd: dir, env }).status, 0);

    const planAdd = runCli(['task', 'add', 'Plan ready fallback task', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(planAdd.status, 0, planAdd.stderr);
    const planTask = JSON.parse(planAdd.stdout).task;

    const scopedPlanAdd = runCli([
      'task', 'add', 'Scoped OBL-928 fallback task',
      '--tag', 'agent',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedPlanAdd.status, 0, scopedPlanAdd.stderr);
    const scopedPlanTask = JSON.parse(scopedPlanAdd.stdout).task;
    const scopedParallelAdd = runCli([
      'task', 'add', 'Scoped OBL-928 validator task should wait',
      '--tag', 'agent',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedParallelAdd.status, 0, scopedParallelAdd.stderr);
    const scopedParallelTask = JSON.parse(scopedParallelAdd.stdout).task;

    const backlogAdd = runCli(['task', 'add', 'Raw inbox idea', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(backlogAdd.status, 0, backlogAdd.stderr);
    const backlogTask = JSON.parse(backlogAdd.stdout).task;

    const current = runCli(['task', 'current', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const payload = JSON.parse(current.stdout);
    assert.equal(payload.action, 'current');
    assert.equal(payload.current.schema, 'atris.task_current.v1');
    assert.equal(payload.current.safety.read_only, true);
    assert.equal(payload.current.safety.claims_work, false);
    assert.equal(payload.current.safety.human_accept, false);
	    assert.equal(payload.current.selected_reason, 'review_needs_agent_verification');
	    assert.equal(payload.current.selected_task_id, reviewTask.id);
	    assert.equal(payload.current.selected_ref, reviewTask.display_id);
	    assert.equal(payload.current.selected_next_key, 'review_chat');
	    assert.equal(payload.selected_task_id, reviewTask.id);
	    assert.equal(payload.selected_ref, reviewTask.display_id);
	    assert.equal(payload.selected_next_key, 'review_chat');
	    assert.equal(payload.page.stage.current, 'review');
	    assert.equal(payload.current.next.key, 'review_chat');
	    assert.match(payload.current.next.command, new RegExp(`atris task review-chat ${reviewTask.display_id}`));
	    assert.match(payload.current.next.step_command, new RegExp(`atris task step ${reviewTask.display_id} --json`));
	    assert.equal(payload.selected.continue_work_command, undefined);
	    assert.equal(payload.selected.commands.continue_work, undefined);
	    assert.equal(payload.queue.schema, 'atris.task_queue.v1');
	    assert.deepEqual(payload.current.capabilities, payload.queue.capabilities);
	    assert.equal(payload.queue.capabilities.schema, 'atris.task_capabilities.v1');
	    assert.equal(payload.queue.capabilities.surfaces.capabilities.read_only, true);
	    assert.equal(payload.queue.capabilities.commands.capabilities, 'atris task capabilities --json');
	    assert.equal(payload.queue.capabilities.surfaces.current.read_only, true);
	    assert.equal(payload.queue.capabilities.surfaces.queue.read_only, true);
	    assert.deepEqual(payload.queue.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
	    assert.deepEqual(payload.queue.capabilities.filters.review_state.aliases['human-accept-waiting'], ['human-accept', 'accept-waiting', 'waiting-accept', 'no-next-task']);
	    assert.equal(payload.queue.capabilities.current_step.safety.read_only, false);
	    assert.equal(payload.queue.capabilities.current_step.safety.claims_work, 'conditional');
	    assert.deepEqual(payload.queue.capabilities.current_step.safety.claiming_stages, ['plan']);
	    assert.equal(payload.queue.capabilities.current_step.stage_safety.plan.claims_work, true);
	    assert.equal(payload.queue.capabilities.current_step.stage_safety.review.claims_work, false);
	    assert.equal(payload.queue.capabilities.current_step.safety.human_accept, false);
	    assert.equal(payload.queue.capabilities.current_step.safety.xp_after_human_accept, true);
	    assert.equal(payload.queue.capabilities.current_step.lanes['needs-agent'].step_action, 'review_chat');
	    assert.equal(payload.queue.capabilities.current_step.lanes['needs-agent'].claims_work, false);
	    assert.equal(payload.queue.capabilities.current_step.lanes['continue-work'].creates_or_reuses_follow_up, true);
	    assert.equal(payload.queue.capabilities.current_step.lanes['continue-work'].claims_work, false);
	    assert.equal(payload.queue.capabilities.current_step.lanes['human-accept-waiting'].reason, 'agent_certified_waiting_human');
	    assert.equal(payload.queue.capabilities.current_step.lanes['human-accept-waiting'].claims_work, false);
	    assert.equal(payload.queue.capabilities.current_step.lanes.certified.claims_work, false);
	    const capabilitiesCli = runCli(['task', 'capabilities', '--json'], { cwd: dir, env });
	    assert.equal(capabilitiesCli.status, 0, capabilitiesCli.stderr);
	    const capabilitiesPayload = JSON.parse(capabilitiesCli.stdout);
	    assert.deepEqual(capabilitiesPayload.capabilities, payload.queue.capabilities);
	    assert.equal(capabilitiesPayload.safety.read_only, true);
	    assert.equal(capabilitiesPayload.safety.claims_work, false);
	    assert.equal(payload.queue.counts.review, 1);
	    assert.equal(payload.queue.counts.plan, 3);
	    assert.equal(payload.queue.counts.backlog, 1);
	    assert.equal(payload.current.review_state_counts.total, 1);
	    assert.equal(payload.current.review_state_counts.needs_agent, 1);
	    assert.equal(payload.current.review_state_counts.continue_work, 0);
	    assert.equal(payload.current.review_state_counts.human_accept_waiting, 0);
	    assert.equal(payload.current.review_state_counts.certified, 0);
	    assert.deepEqual(payload.current.review_state_counts, payload.queue.review_state_counts);
	    assert.deepEqual(payload.current.review_state_actions, payload.queue.review_state_actions);
	    assert.equal(payload.current.review_state_actions.schema, 'atris.task_review_state_actions.v1');
	    assert.equal(payload.current.review_state_actions.active_filter, null);
	    assert.equal(payload.current.review_state_actions.scope.review_state, null);
	    assert.equal(payload.current.review_state_actions.needs_agent.id, reviewTask.id);
	    assert.equal(payload.current.review_state_actions.needs_agent.next_action, 'review_chat');
	    assert.match(payload.current.review_state_actions.needs_agent.command, new RegExp(`atris task review-chat ${reviewTask.display_id}`));
	    assert.deepEqual(payload.current.review_state_actions.needs_agent.api, { method: 'POST', path: `/api/tasks/${reviewTask.id}/review-chat` });
	    assert.equal(payload.current.review_state_actions.needs_agent.continue_work_command, undefined);
	    assert.equal(payload.current.review_state_actions.needs_agent.human_accept.human_only, true);
	    assert.match(payload.current.review_state_actions.needs_agent.human_accept.command, new RegExp(`atris task accept ${reviewTask.display_id}`));
	    assert.equal(payload.current.review_state_actions.continue_work, null);
	    assert.equal(payload.current.review_state_actions.human_accept_waiting, null);
	    const reviewQueueItem = payload.queue.columns.find(column => column.key === 'review').items[0];
	    assert.equal(reviewQueueItem.id, reviewTask.id);
	    assert.equal(reviewQueueItem.ref, reviewTask.display_id);
	    assert.equal(reviewQueueItem.display_id, reviewTask.display_id);
	    assert.ok(reviewQueueItem.legacy_ref);
	    assert.equal(reviewQueueItem.continue_work_command, undefined);

	    const needsAgentCurrent = runCli(['task', 'current', '--as', 'codex', '--review-state', 'needs-agent', '--json'], { cwd: dir, env });
	    assert.equal(needsAgentCurrent.status, 0, needsAgentCurrent.stderr);
	    const needsAgentPayload = JSON.parse(needsAgentCurrent.stdout);
	    assert.equal(needsAgentPayload.current.scope.review_state, 'needs-agent');
	    assert.equal(needsAgentPayload.current.selected_task_id, reviewTask.id);
	    assert.equal(needsAgentPayload.current.next.key, 'review_chat');
	    assert.equal(needsAgentPayload.selected.continue_work_command, undefined);
	    assert.equal(needsAgentPayload.current.review_state_counts.active_filter, 'needs-agent');
	    assert.equal(needsAgentPayload.current.review_state_counts.scope.review_state, null);
	    assert.equal(needsAgentPayload.current.review_state_counts.total, 1);
	    assert.equal(needsAgentPayload.current.review_state_counts.needs_agent, 1);
	    assert.equal(needsAgentPayload.current.review_state_actions.active_filter, 'needs-agent');
	    assert.equal(needsAgentPayload.current.review_state_actions.scope.review_state, null);
	    assert.equal(needsAgentPayload.current.review_state_actions.needs_agent.id, reviewTask.id);
	    assert.equal(needsAgentPayload.current.review_state_actions.needs_agent.next_action, 'review_chat');
	    assert.equal(needsAgentPayload.current.review_state_actions.continue_work, null);
	    assert.equal(needsAgentPayload.current.review_state_actions.human_accept_waiting, null);
	    assert.deepEqual(needsAgentPayload.current.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
	    assert.equal(needsAgentPayload.current.capabilities.current_step.lanes['needs-agent'].safe_for_agent, true);

    const scopedCurrent = runCli(['task', 'current', '--as', 'codex', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(scopedCurrent.status, 0, scopedCurrent.stderr);
    const scopedPayload = JSON.parse(scopedCurrent.stdout);
    assert.equal(scopedPayload.current.scope.goal_id, 'OBL-928');
    assert.equal(scopedPayload.current.selected_reason, 'plan_ready');
    assert.equal(scopedPayload.current.selected_task_id, scopedPlanTask.id);
    assert.equal(scopedPayload.current.selected_ref, scopedPlanTask.display_id);
    assert.equal(scopedPayload.page.task.ref, scopedPlanTask.display_id);
    assert.equal(scopedPayload.queue.scope.goal_id, 'OBL-928');
    assert.equal(scopedPayload.queue.counts.total, 2);
    assert.equal(scopedPayload.queue.counts.review, 0);
    assert.equal(scopedPayload.queue.counts.plan, 2);

    const scopedQueue = runCli(['task', 'queue', '--as', 'codex', '--goal-id', 'OBL-928', '--limit', '1', '--json'], { cwd: dir, env });
    assert.equal(scopedQueue.status, 0, scopedQueue.stderr);
    const scopedQueuePayload = JSON.parse(scopedQueue.stdout);
    assert.equal(scopedQueuePayload.queue.scope.goal_id, 'OBL-928');
    assert.equal(scopedQueuePayload.queue.counts.total, 2);
    assert.equal(scopedQueuePayload.queue.columns.find(column => column.key === 'plan').items[0].id, scopedParallelTask.id);

    const tagQueue = runCli(['task', 'queue', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(tagQueue.status, 0, tagQueue.stderr);
    const tagQueuePayload = JSON.parse(tagQueue.stdout);
    assert.equal(tagQueuePayload.queue.scope.tag, 'capture');
    assert.equal(tagQueuePayload.queue.counts.total, 1);
    assert.equal(tagQueuePayload.queue.columns.find(column => column.key === 'backlog').items[0].id, backlogTask.id);

    const statusCurrent = runCli(['task', 'current', '--status', 'review', '--json'], { cwd: dir, env });
    assert.equal(statusCurrent.status, 0, statusCurrent.stderr);
    const statusPayload = JSON.parse(statusCurrent.stdout);
    assert.equal(statusPayload.current.scope.status, 'review');
    assert.equal(statusPayload.current.selected_task_id, reviewTask.id);
    assert.equal(statusPayload.current.selected_ref, reviewTask.display_id);
    assert.equal(statusPayload.queue.counts.total, 1);

    const planShow = runCli(['task', 'show', planTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(planShow.status, 0, planShow.stderr);
    assert.equal(JSON.parse(planShow.stdout).status, 'open');
    const reviewShow = runCli(['task', 'show', reviewTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(reviewShow.status, 0, reviewShow.stderr);
    const reviewDetail = JSON.parse(reviewShow.stdout);
    assert.equal(reviewDetail.status, 'review');
    assert.equal(reviewDetail.review.approval_status, 'pending');
    assert.equal(reviewDetail.messages.some(message => message.content.includes('TASK_REVIEW_CHAT')), false);

    assert.equal(runCli(['task', 'claim', planTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const claimedCurrent = runCli(['task', 'current', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimedCurrent.status, 0, claimedCurrent.stderr);
    const claimedPayload = JSON.parse(claimedCurrent.stdout);
    assert.equal(claimedPayload.current.selected_reason, 'claimed_by_owner');
    assert.equal(claimedPayload.current.selected_task_id, planTask.id);
    assert.equal(claimedPayload.current.selected_ref, planTask.display_id);
    assert.equal(claimedPayload.page.stage.current, 'do');
    assert.match(claimedPayload.current.next.command, new RegExp(`atris task ready ${planTask.display_id}`));

    const queue = runCli(['task', 'queue', '--as', 'codex', '--limit', '1', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const queuePayload = JSON.parse(queue.stdout);
    assert.equal(queuePayload.action, 'queue');
    assert.equal(queuePayload.selected_task_id, planTask.id);
    assert.equal(queuePayload.selected_ref, planTask.display_id);
    assert.equal(queuePayload.selected_next_key, 'ready');
    assert.equal(queuePayload.current.selected_next_key, 'ready');
    assert.equal(queuePayload.queue.columns.find(column => column.key === 'do').items.length, 1);
    assert.equal(queuePayload.queue.columns.find(column => column.key === 'backlog').items[0].id, backlogTask.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task backlog and clear-plan demote only planned open tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const workspaceRoot = fs.realpathSync(dir);

    const raw = runCli(['task', 'add', 'Raw capture stays backlog', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(raw.status, 0, raw.stderr);
    const rawRef = JSON.parse(raw.stdout).task.display_id;

    const single = runCli(['task', 'add', 'Single planned row moves back', '--tag', 'plan', '--json'], { cwd: dir, env });
    assert.equal(single.status, 0, single.stderr);
    const singleRef = JSON.parse(single.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'plan', singleRef,
      '--as', 'codex',
      '--goal', 'Single row has a plan',
      '--exit', 'single row can be demoted',
      '--proof-needed', 'node --test task backlog coverage passes',
      '--json',
    ], { cwd: dir, env }).status, 0);

    const singleBacklog = runCli(['task', 'backlog', singleRef, '--as', 'codex', '--reason', 'operator moved it', '--tag', 'feature', '--json'], { cwd: dir, env });
    assert.equal(singleBacklog.status, 0, singleBacklog.stderr);
    const singleBacklogPayload = JSON.parse(singleBacklog.stdout);
    assert.equal(singleBacklogPayload.action, 'backlogged');
    assert.equal(singleBacklogPayload.task.tag, 'capture');
    const singleBacklogMetadata = singleBacklogPayload.task.metadata || {};
    assert.equal(singleBacklogMetadata.stage, undefined);
    assert.equal(singleBacklogMetadata.goal_objective, undefined);
    assert.equal(singleBacklogMetadata.objective, undefined);
    assert.equal(singleBacklogMetadata.task_goal, 'Single row has a plan');
    assert.equal(singleBacklogMetadata.verify, undefined);
    assert.equal(singleBacklogPayload.task.latest_event_type, 'task_backlogged');

    const singleShow = runCli(['task', 'show', singleRef, '--json'], { cwd: dir, env });
    assert.equal(singleShow.status, 0, singleShow.stderr);
    const singleShowTask = JSON.parse(singleShow.stdout);
    assert.equal(singleShowTask.metadata.backlogged_by, 'codex');
    assert.equal(singleShowTask.metadata.goal_objective, undefined);
    assert.equal(singleShowTask.metadata.objective, undefined);
    assert.equal(singleShowTask.metadata.task_goal, 'Single row has a plan');
    assert.ok(singleShowTask.messages.some(message => message.content.includes('TASK_BACKLOG_UPDATE')));

    const doAfterBacklog = runCli(['task', 'do', singleRef, '--as', 'codex', '--first-move', 'start after demotion', '--json'], { cwd: dir, env });
    assert.equal(doAfterBacklog.status, 1);
    assert.equal(JSON.parse(doAfterBacklog.stdout).reason, 'goal_required');

    const planAfterBacklogWithoutGoal = runCli([
      'task', 'plan', singleRef,
      '--as', 'codex',
      '--exit', 'new exit still needs a fresh goal',
      '--proof-needed', 'new proof still needs a fresh goal',
      '--json',
    ], { cwd: dir, env });
    assert.equal(planAfterBacklogWithoutGoal.status, 0, planAfterBacklogWithoutGoal.stderr);
    assert.match(JSON.parse(planAfterBacklogWithoutGoal.stdout).stage_packet, /goal: Single row has a plan/);
    const singleBacklogAgain = runCli(['task', 'backlog', singleRef, '--as', 'codex', '--reason', 'operator moved it again', '--json'], { cwd: dir, env });
    assert.equal(singleBacklogAgain.status, 0, singleBacklogAgain.stderr);

    const db = taskDb.open(dbPath);
    const signalTask = taskDb.addTask(db, {
      title: 'Metadata signal planned row moves back',
      tag: 'capture',
      workspaceRoot,
      metadata: {
        goal: 'legacy goal signal',
        loop: 'legacy loop signal',
        cron: '0 * * * *',
        next_run_at: '2099-01-01T00:00:00.000Z',
      },
    });
    const signalBacklog = runCli(['task', 'backlog', signalTask.id, '--as', 'codex', '--reason', 'operator cleared legacy plan signals', '--tag', 'feature', '--json'], { cwd: dir, env });
    assert.equal(signalBacklog.status, 0, signalBacklog.stderr);
    const signalBacklogPayload = JSON.parse(signalBacklog.stdout);
    assert.equal(signalBacklogPayload.task.tag, 'capture');
    for (const key of ['goal', 'loop', 'cron', 'next_run_at']) {
      assert.ok(signalBacklogPayload.cleared_keys.includes(key), `${key} should be cleared`);
    }
    const signalShow = runCli(['task', 'show', signalTask.id, '--json'], { cwd: dir, env });
    assert.equal(signalShow.status, 0, signalShow.stderr);
    const signalShowTask = JSON.parse(signalShow.stdout);
    assert.equal(signalShowTask.metadata.goal, undefined);
    assert.equal(signalShowTask.metadata.loop, undefined);
    assert.equal(signalShowTask.metadata.cron, undefined);
    assert.equal(signalShowTask.metadata.next_run_at, undefined);
    const signalBacklogAgain = runCli(['task', 'backlog', signalTask.id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(signalBacklogAgain.status, 1);
    assert.equal(JSON.parse(signalBacklogAgain.stdout).reason, 'not_planned');

    const goalOnlyTask = taskDb.addTask(db, {
      title: 'Goal-only stale plan row moves back',
      tag: 'capture',
      workspaceRoot,
      metadata: {
        goal_objective: 'stale goal only',
        objective: 'stale objective only',
      },
    });
    const goalOnlyBacklog = runCli(['task', 'backlog', goalOnlyTask.id, '--as', 'codex', '--reason', 'operator cleared stale goal-only plan', '--json'], { cwd: dir, env });
    assert.equal(goalOnlyBacklog.status, 1);
    assert.equal(JSON.parse(goalOnlyBacklog.stdout).reason, 'not_planned');
    const goalOnlyPlanWithoutGoal = runCli([
      'task', 'plan', goalOnlyTask.id,
      '--as', 'codex',
      '--exit', 'new exit still needs a fresh goal',
      '--proof-needed', 'new proof still needs a fresh goal',
      '--json',
    ], { cwd: dir, env });
    assert.equal(goalOnlyPlanWithoutGoal.status, 0, goalOnlyPlanWithoutGoal.stderr);
    assert.match(JSON.parse(goalOnlyPlanWithoutGoal.stdout).stage_packet, /goal: stale goal only/);
    const goalOnlyBacklogAfterPlan = runCli(['task', 'backlog', goalOnlyTask.id, '--as', 'codex', '--reason', 'operator cleared real plan', '--json'], { cwd: dir, env });
    assert.equal(goalOnlyBacklogAfterPlan.status, 0, goalOnlyBacklogAfterPlan.stderr);

    const delegated = runCli(['task', 'delegate', 'Delegated planned row keeps owner', '--to', 'alice', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const delegatedRef = JSON.parse(delegated.stdout).task.display_id;
    const delegatedPlan = runCli([
      'task', 'plan', delegatedRef,
      '--as', 'alice',
      '--owner', 'alice',
      '--goal', 'Delegated owner has a plan',
      '--exit', 'owner survives demotion',
      '--proof-needed', 'owner preservation regression passes',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegatedPlan.status, 0, delegatedPlan.stderr);
    const delegatedBacklog = runCli(['task', 'backlog', delegatedRef, '--as', 'alice', '--reason', 'operator cleared delegated plan', '--json'], { cwd: dir, env });
    assert.equal(delegatedBacklog.status, 0, delegatedBacklog.stderr);
    const delegatedShow = runCli(['task', 'show', delegatedRef, '--json'], { cwd: dir, env });
    assert.equal(delegatedShow.status, 0, delegatedShow.stderr);
    const delegatedTask = JSON.parse(delegatedShow.stdout);
    assert.equal(delegatedTask.metadata.assigned_to, 'alice');
    assert.equal(delegatedTask.metadata.delegate_via, 'local');
    assert.equal(delegatedTask.metadata.stage_owner, undefined);

    const bulkA = runCli(['task', 'add', 'Bulk planned A', '--tag', 'feature', '--json'], { cwd: dir, env });
    const bulkB = runCli(['task', 'add', 'Bulk planned B', '--tag', 'capture', '--json'], { cwd: dir, env });
    const claimed = runCli(['task', 'add', 'Claimed Do row stays active', '--tag', 'plan', '--json'], { cwd: dir, env });
    assert.equal(bulkA.status, 0, bulkA.stderr);
    assert.equal(bulkB.status, 0, bulkB.stderr);
    assert.equal(claimed.status, 0, claimed.stderr);
    const bulkARef = JSON.parse(bulkA.stdout).task.display_id;
    const bulkBRef = JSON.parse(bulkB.stdout).task.display_id;
    const claimedRef = JSON.parse(claimed.stdout).task.display_id;
    for (const ref of [bulkARef, bulkBRef, claimedRef]) {
      const planned = runCli([
        'task', 'plan', ref,
        '--as', 'codex',
        '--owner', 'codex',
        '--goal', `Goal ${ref}`,
        '--exit', `Exit ${ref}`,
        '--proof-needed', `Proof ${ref}`,
        '--json',
      ], { cwd: dir, env });
      assert.equal(planned.status, 0, planned.stderr);
    }
    const claimedDo = runCli(['task', 'do', claimedRef, '--as', 'codex', '--first-move', 'keep doing this row', '--json'], { cwd: dir, env });
    assert.equal(claimedDo.status, 0, claimedDo.stderr);

    const missingConfirm = runCli(['task', 'clear-plan', '--json'], { cwd: dir, env });
    assert.equal(missingConfirm.status, 2);
    assert.equal(JSON.parse(missingConfirm.stdout).reason, 'confirm_required');

    const cleared = runCli(['task', 'clear-plan', '--as', 'codex', '--reason', 'bulk cleanup', '--yes', '--json'], { cwd: dir, env });
    assert.equal(cleared.status, 0, cleared.stderr);
    const clearedPayload = JSON.parse(cleared.stdout);
    assert.equal(clearedPayload.action, 'clear_plan');
    assert.equal(clearedPayload.cleared_count, 2);
    assert.deepEqual(clearedPayload.tasks.map(task => task.display_id).sort(), [bulkARef, bulkBRef].sort());
    assert.ok(clearedPayload.tasks.every(task => task.tag === 'capture'));

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const counts = JSON.parse(status.stdout).status.counts;
    assert.equal(counts.plan, 0);
    assert.equal(counts.do, 1);
    assert.equal(counts.backlog, 7);

    const claimedShow = runCli(['task', 'show', claimedRef, '--json'], { cwd: dir, env });
    assert.equal(claimedShow.status, 0, claimedShow.stderr);
    assert.equal(JSON.parse(claimedShow.stdout).status, 'claimed');

    const rawShow = runCli(['task', 'show', rawRef, '--json'], { cwd: dir, env });
    assert.equal(rawShow.status, 0, rawShow.stderr);
    assert.equal(JSON.parse(rawShow.stdout).latest_event_type, 'created');
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task review does not mint AgentXP before the task is done', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Do not pay XP before accept', '--tag', 'agent-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const review = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--proof', 'premature validation passed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    const reviewPayload = JSON.parse(review.stdout);
    assert.equal(reviewPayload.task.status, 'open');
    assert.equal(reviewPayload.task.metadata?.approval_status, undefined);
    assert.equal(reviewPayload.episode.career_xp.eligible, false);
    assert.equal(reviewPayload.episode.rl.label, 'accepted');

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.total_xp, 0);
    assert.equal(payload.collected_receipts, 0);

    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 2);
    assert.match(accept.stderr, /fresh proof_ready proof/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready holds work in review until human accept', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    writePolicy(dir, { enabled: false, enabled_by: 'keshavrao' });

    const add = runCli([
      'task', 'add', 'Approve autonomous work before XP',
      '--tag', 'agent',
      '--goal-id', 'goal-agent-xp',
      '--goal-objective', 'Make AgentXP recruitable',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const created = JSON.parse(add.stdout);
    const ref = created.task.display_id;
    assert.equal(created.task.metadata.goal_id, 'goal-agent-xp');
    assert.equal(created.task.metadata.goal_objective, 'Make AgentXP recruitable');
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'typecheck passed and diff reviewed',
      '--happened', 'Operators can now hold autonomous work for human approval before XP is awarded, preventing unapproved rewards.',
      '--checked', 'I checked the task stayed in Review and did not mint XP.',
      '--tested', 'I ran the typecheck proof and inspected the diff.',
      '--decision', 'Accept if XP should land; rework if proof is missing.',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.action, 'ready');
    assert.equal(readyPayload.approval_status, 'pending');
    assert.equal(readyPayload.review_pass_count, 1);
    assert.equal(readyPayload.agent_certified, false);
    assert.equal(readyPayload.handoff.native_goal_status, 'needs_second_agent_review');
    assert.equal(readyPayload.handoff.career_xp_status, 'pending_human_accept');
    assert.equal(readyPayload.handoff.next_action, 'agent_review_again');
    assert.equal(readyPayload.handoff.review_chat_command, `atris task review-chat ${ref} --as codex-review`);
    assert.equal(readyPayload.handoff.rule, 'proof is ready; one more agent check before human approval. XP waits for the human.');
    assert.match(readyPayload.handoff.codex_prompt, new RegExp(`/codex review ${ref}`));
    assert.match(readyPayload.handoff.codex_prompt, /Approve autonomous work before XP/);
    assert.match(readyPayload.handoff.codex_prompt, /Proof: typecheck passed and diff reviewed/);
    assert.equal(readyPayload.task.status, 'review');
    assert.equal(readyPayload.task.review.summary, 'approve autonomous work before XP: proof is ready for human approval; approve only if the evidence is real.');
    assert.deepEqual(readyPayload.task.review.landing, {
      happened: 'Operators can now hold autonomous work for human approval before XP is awarded.',
      reason: 'it prevents unapproved rewards.',
      checked: 'I checked the task stayed in Review and did not mint XP.',
      tested: 'I ran the typecheck proof and inspected the diff.',
      decision: 'Accept if XP should land; rework if proof is missing.',
    });
    assert.deepEqual(readyPayload.task.review.result, {
      changed: 'Operators can now hold autonomous work for human approval before XP is awarded.',
      reason: 'it prevents unapproved rewards.',
      checked: 'I checked the task stayed in Review and did not mint XP.',
      saved: `Completed result saved for review as ${ref}.`,
      accept: 'Accept if XP should land; rework if proof is missing.',
    });
    assert.equal(readyPayload.task.review.proof, 'typecheck passed and diff reviewed');
    assert.equal(readyPayload.task.review.reward, null);
    assert.equal(readyPayload.task.review.approval_status, 'pending');
    assert.equal(readyPayload.task.review.agent_certified, undefined);
    assert.equal(readyPayload.task.review.verification_chat.command, `atris task review-chat ${ref} --as codex-review`);
    assert.match(readyPayload.task.review.verification_chat.codex_prompt, /\/codex review/);

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /Result:/);
    assert.match(readyShow.stdout, /What happened: Operators can now hold autonomous work for human approval before XP is awarded\./);
    assert.match(readyShow.stdout, /Why it matters: it prevents unapproved rewards\./);
    assert.match(readyShow.stdout, /How I checked: I checked the task stayed in Review and did not mint XP\./);
    assert.match(readyShow.stdout, /What I tested: I ran the typecheck proof and inspected the diff\./);
    assert.match(readyShow.stdout, new RegExp(`Saved: Completed result saved for review as ${ref}\\.`));
    assert.match(readyShow.stdout, /Decision: Accept if XP should land; rework if proof is missing\./);
    assert.match(readyShow.stdout, /Short version: approve autonomous work before XP: proof is ready for human approval; approve only if the evidence is real\./);
    assert.match(readyShow.stdout, /Details: typecheck passed and diff reviewed/);
    assert.match(readyShow.stdout, /Landing: waiting on human/);
    assert.match(readyShow.stdout, new RegExp(`Check command: atris task review-chat ${ref} --as codex-review`));
    assert.doesNotMatch(readyShow.stdout, /Agent certified: yes/);

    const reviewChat = runCli(['task', 'review-chat', ref, '--as', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(reviewChat.status, 0, reviewChat.stderr);
    const reviewChatPayload = JSON.parse(reviewChat.stdout);
    assert.equal(reviewChatPayload.action, 'review_chat');
    assert.equal(reviewChatPayload.appended, true);
    assert.equal(reviewChatPayload.contract.schema, 'atris.task_review_chat.v1');
    assert.equal(reviewChatPayload.contract.task.ref, ref);
    assert.match(reviewChatPayload.contract.codex_prompt, /\/codex review/);
    assert.equal(reviewChatPayload.contract.verification_focus.proof_claim, 'typecheck passed and diff reviewed');
    assert.match(reviewChatPayload.contract.required_checks.join('\n'), /Find the concrete verifier command/);
    assert.match(reviewChatPayload.contract.required_checks.join('\n'), /Do not run task accept/);
    assert.equal(reviewChatPayload.contract.pass_command, `atris task review ${ref} --reward 0 --as codex-review --proof "<specific verifier commands passed and diff/proof inspected>" --verify "<safe verifier command>"`);
    assert.equal(reviewChatPayload.contract.revise_command, `atris task revise ${ref} --as codex-review --note "<specific missing proof or required change>"`);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /TASK_REVIEW_CHAT/);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /proof_claim: typecheck passed and diff reviewed/);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /commands_to_verify:/);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /files_to_inspect:/);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /human_accept_xp: atris task accept/);

    fs.writeFileSync(path.join(dir, 'review-verify.js'), 'const ok = true;\n', 'utf8');
    const prooflessReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--verify', 'node --check review-verify.js',
      '--json',
    ], { cwd: dir, env });
    assert.equal(prooflessReview.status, 0, prooflessReview.stderr);
    assert.equal(JSON.parse(prooflessReview.stdout).task.review.proof, 'typecheck passed and diff reviewed');
    assert.equal(JSON.parse(prooflessReview.stdout).task.review.agent_review_pass_count, 2);
    assert.equal(JSON.parse(prooflessReview.stdout).task.review.agent_certified, true);
    assert.equal(JSON.parse(prooflessReview.stdout).task.metadata.agent_certified, true);
    assert.equal(JSON.parse(prooflessReview.stdout).task.metadata.verify, 'node --check review-verify.js');

    const nextAfterReviewCertification = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(nextAfterReviewCertification.status, 0, nextAfterReviewCertification.stderr);
    const firstNextPayload = JSON.parse(nextAfterReviewCertification.stdout);
    assert.equal(firstNextPayload.action, 'accept');
    assert.equal(firstNextPayload.command, `atris task accept ${ref}`);
    assert.equal(firstNextPayload.task_id, readyPayload.task.id);

    const certified = runCli([
      'task', 'ready', ref,
      '--proof', 'typecheck passed and diff reviewed again',
      '--lesson', 'Double-check proof before awarding XP',
      '--next', 'Queue the next proof loop',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certified.status, 0, certified.stderr);
    const certifiedPayload = JSON.parse(certified.stdout);
    assert.equal(certifiedPayload.review_pass_count, 3);
    assert.equal(certifiedPayload.agent_certified, true);
    assert.equal(certifiedPayload.handoff.native_goal_status, 'agent_certified');
    assert.equal(certifiedPayload.handoff.career_xp_status, 'pending_human_accept');
    assert.equal(certifiedPayload.handoff.next_action, 'continue_work');
    assert.equal(certifiedPayload.handoff.review_chat_command, undefined);
    assert.equal(certifiedPayload.handoff.codex_prompt, undefined);
    assert.equal(certifiedPayload.handoff.verification_focus, undefined);
    assert.equal(certifiedPayload.handoff.rule, 'double-check complete; ready to keep moving. XP is awarded only after the human approves the task.');
    assert.equal(certifiedPayload.task.status, 'review');
    assert.equal(certifiedPayload.task.review.approval_status, 'pending');
    assert.equal(certifiedPayload.task.review.agent_review_pass_count, 3);
    assert.equal(certifiedPayload.task.review.agent_certified, true);
    assert.equal(certifiedPayload.task.review.verification_chat, undefined);
    assert.equal(certifiedPayload.task.metadata.agent_certified, true);

    const prematureDone = runCli(['task', 'done', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(prematureDone.status, 1);
    assert.equal(prematureDone.stderr, '');
    const prematureDonePayload = JSON.parse(prematureDone.stdout);
    assert.equal(prematureDonePayload.reason, 'not_open_or_claimed');
    assert.match(prematureDonePayload.detail, /not in open\|claimed/);
    const stillReview = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(stillReview.status, 0, stillReview.stderr);
    assert.equal(JSON.parse(stillReview.stdout).status, 'review');

    const certifiedShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(certifiedShow.status, 0, certifiedShow.stderr);
	    assert.match(certifiedShow.stdout, /Details: typecheck passed and diff reviewed again/);
	    assert.match(certifiedShow.stdout, /Landing: waiting on human/);
	    assert.match(certifiedShow.stdout, /Checked: yes \(3 agent checks\)/);

	    for (let i = 0; i < 10; i += 1) {
	      const note = runCli(['task', 'note', ref, `post-ready context ${i}`, '--as', 'codex'], { cwd: dir, env });
	      assert.equal(note.status, 0, note.stderr);
	    }

    const statusAfterCertification = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(statusAfterCertification.status, 0, statusAfterCertification.stderr);
    const statusPayload = JSON.parse(statusAfterCertification.stdout);
    assert.equal(statusPayload.status.current, null);
    assert.equal(statusPayload.status.counts.active, 0);
    assert.equal(statusPayload.status.counts.review, 1);
    assert.equal(statusPayload.status.counts.review_blocking, 0);
    assert.equal(statusPayload.status.counts.review_certified, 1);
    assert.equal(statusPayload.status.needs_review[0].review.proof, 'typecheck passed and diff reviewed again');
    assert.equal(statusPayload.status.needs_review[0].review.lesson, 'Double-check proof before awarding XP');
    assert.equal(statusPayload.status.needs_review[0].review.next_task, 'Queue the next proof loop');
	    assert.equal(statusPayload.status.needs_review[0].review.handoff.next_action, 'continue_work');
    assert.equal(statusPayload.status.needs_review[0].review.handoff.career_xp_status, 'pending_human_accept');

    const omittedGuidanceReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--json',
    ], { cwd: dir, env });
    assert.equal(omittedGuidanceReview.status, 0, omittedGuidanceReview.stderr);
    const omittedGuidancePayload = JSON.parse(omittedGuidanceReview.stdout);
    assert.equal(omittedGuidancePayload.task.review.proof, 'typecheck passed and diff reviewed again');
    assert.equal(omittedGuidancePayload.task.review.lesson, 'Double-check proof before awarding XP');
    assert.equal(omittedGuidancePayload.task.review.next_task, 'Queue the next proof loop');

    const nextAfterCertification = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(nextAfterCertification.status, 0, nextAfterCertification.stderr);
    const nextPayload = JSON.parse(nextAfterCertification.stdout);
    assert.equal(nextPayload.action, 'accept');
    assert.equal(nextPayload.command, `atris task accept ${ref}`);
    assert.equal(nextPayload.task_id, certifiedPayload.task.id);

    const textAdd = runCli(['task', 'add', 'Render native goal handoff copy', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(textAdd.status, 0, textAdd.stderr);
    const textRef = JSON.parse(textAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', textRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const readyText = runCli([
      'task', 'ready', textRef,
      '--proof', 'second validation pass',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(readyText.status, 0, readyText.stderr);
    assert.match(readyText.stdout, /proof is ready; one more agent check before human approval\. XP waits for the human\./);

    const accept = runCli([
      'task', 'accept', ref,
      '--as', 'keshavrao',
      '--json',
    ], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    const acceptPayload = JSON.parse(accept.stdout);
    assert.equal(acceptPayload.action, 'accepted');
    assert.equal(acceptPayload.task.status, 'done');
    assert.equal(acceptPayload.task.review.reward, 1);
    assert.equal(acceptPayload.task.review.summary, 'Completed AgentXP result for approve autonomous work before XP.');
    assert.equal(acceptPayload.task.review.result.saved, `Result accepted as ${ref}.`);
    assert.equal(acceptPayload.task.review.proof, 'typecheck passed and diff reviewed again');
    assert.equal(acceptPayload.task.review.lesson, 'Double-check proof before awarding XP');
    assert.equal(acceptPayload.task.review.next_task, 'Queue the next proof loop');
    assert.equal(acceptPayload.task.metadata.approval_status, 'accepted');
    assert.equal(acceptPayload.episode.action.actor, 'keshavrao');
    assert.deepEqual(acceptPayload.episode.goal, {
      goal_id: 'goal-agent-xp',
      objective: 'Make AgentXP recruitable',
    });
    assert.equal(acceptPayload.episode.career_xp.eligible, true);
    assert.equal(acceptPayload.episode.rl.label, 'accepted');
    assert.equal(acceptPayload.xp_projection.schema, 'atris.career_xp_projection.v1');
    assert.equal(acceptPayload.xp_projection.collected_receipts, 1);
    assert.equal(acceptPayload.xp_projection.total_xp, 1);
    assert.equal(acceptPayload.xp_projection.latest_accepted_proof.source_task_id, acceptPayload.task_id);

    const clearCli = runCli(['task', 'add', 'Clear stale CLI review guidance', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(clearCli.status, 0, clearCli.stderr);
    const clearCliRef = JSON.parse(clearCli.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', clearCliRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const clearCliReady = runCli([
      'task', 'ready', clearCliRef,
      '--proof', 'cli clear validation passed',
      '--lesson', 'stale CLI lesson',
      '--next', 'stale CLI next',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(clearCliReady.status, 0, clearCliReady.stderr);
    const clearCliAccept = runCli([
      'task', 'accept', clearCliRef,
      '--as', 'keshavrao',
      '--lesson', '',
      '--next', '',
      '--json',
    ], { cwd: dir, env });
    assert.equal(clearCliAccept.status, 0, clearCliAccept.stderr);
    const clearCliPayload = JSON.parse(clearCliAccept.stdout);
    assert.equal(clearCliPayload.episode.proof, 'cli clear validation passed');
    assert.equal(clearCliPayload.episode.lesson, '');
    assert.equal(clearCliPayload.episode.next_task_suggestion, null);
    assert.equal(clearCliPayload.task.review.proof, 'cli clear validation passed');
    assert.equal(Object.prototype.hasOwnProperty.call(clearCliPayload.task.review, 'lesson'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(clearCliPayload.task.review, 'next_task'), false);

	    const events = runCli(['task', 'events', ref, '--json'], { cwd: dir, env });
	    assert.equal(events.status, 0, events.stderr);
	    const eventTypes = JSON.parse(events.stdout).events.map(event => event.event_type);
	    assert.deepEqual(eventTypes.slice(0, 6), ['created', 'claimed', 'proof_ready', 'message', 'reviewed', 'proof_ready']);
	    assert.deepEqual(eventTypes.slice(-2), ['completed', 'reviewed']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready uses autoland-aware handoff copy when policy is on', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    // Fresh tick receipt so ready copy may promise the next pass.
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'autoland-tick-live.json'), '{}\n');
    writePolicy(dir, { enabled: true, enabled_by: 'keshavrao' });

    const add = runCli([
      'task', 'add', 'Autoland ready messaging',
      '--tag', 'agent',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'typecheck passed and diff reviewed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(
      readyPayload.handoff.rule,
      'proof is ready; autoland runs the second check and accepts it on the next tick; it lands once committed and merged.',
    );
    assert.notEqual(
      readyPayload.handoff.rule,
      'proof is ready; one more agent check before human approval. XP waits for the human.',
    );

    const textAdd = runCli(['task', 'add', 'Autoland ready text copy', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(textAdd.status, 0, textAdd.stderr);
    const textRef = JSON.parse(textAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', textRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const readyText = runCli([
      'task', 'ready', textRef,
      '--proof', 'second validation pass',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(readyText.status, 0, readyText.stderr);
    assert.match(readyText.stdout, /proof is ready; autoland runs the second check and accepts it on the next tick; it lands once committed and merged\./);
    assert.doesNotMatch(readyText.stdout, /one more agent check before human approval/);

    const externalAdd = runCli(['task', 'add', 'Autoland external verifier copy', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(externalAdd.status, 0, externalAdd.stderr);
    const externalRef = JSON.parse(externalAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', externalRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const externalReady = runCli([
      'task', 'ready', externalRef,
      '--verify', 'ls atris',
      '--result', 'Teammates can trust the handoff faster because the finished proof is checked before review.',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(externalReady.status, 0, externalReady.stderr);
    assert.match(externalReady.stdout, /proof is ready; this verifier needs a second agent review because autoland cannot rerun it\./);
    assert.match(externalReady.stdout, /outside the auto-certify allowlist/);
    assert.doesNotMatch(externalReady.stdout, /autoland runs the second check and accepts it on the next tick; it lands once committed and merged\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready uses honest landing copy when autoland heartbeat is stale', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    writePolicy(dir, { enabled: true, enabled_by: 'keshavrao' });
    // Tick older than two hours: ready must not promise "next tick".
    const stalePath = path.join(dir, 'atris', 'runs', 'autoland-tick-stale.json');
    fs.writeFileSync(stalePath, '{}\n');
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
    fs.utimesSync(stalePath, threeHoursAgo / 1000, threeHoursAgo / 1000);

    const add = runCli([
      'task', 'add', 'Stale heartbeat ready wording',
      '--tag', 'agent',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'typecheck passed and diff reviewed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(
      readyPayload.handoff.rule,
      'proof is ready; autoland runs the second check and accepts it once the hourly heartbeat runs (start one with atris autoland tick); it lands once committed and merged.',
    );
    assert.doesNotMatch(ready.stdout, /on the next tick/);

    const textAdd = runCli(['task', 'add', 'Stale heartbeat text copy', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(textAdd.status, 0, textAdd.stderr);
    const textRef = JSON.parse(textAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', textRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const readyText = runCli([
      'task', 'ready', textRef,
      '--proof', 'second validation pass',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(readyText.status, 0, readyText.stderr);
    assert.match(
      readyText.stdout,
      /proof is ready; autoland runs the second check and accepts it once the hourly heartbeat runs \(start one with atris autoland tick\); it lands once committed and merged\./,
    );
    assert.doesNotMatch(readyText.stdout, /on the next tick/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review accepts clean dry-run verifier', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Review with clean dry-run proof',
      '--tag', 'maintenance',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', ref,
      '--proof', 'node bin/atris.js clean --dry-run --json passed before verifier review',
      '--as', 'codex',
    ], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node bin/atris.js clean --dry-run --json reported no map repairs',
      '--verify', 'node bin/atris.js clean --dry-run --json',
      '--json',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.equal(JSON.parse(review.stdout).task.metadata.verify, 'node bin/atris.js clean --dry-run --json');

    const mutatingReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'git diff --check passed before unsafe clean command rejection',
      '--verify', 'node bin/atris.js clean --json',
      '--json',
    ], { cwd: dir, env });
    assert.equal(mutatingReview.status, 2);
    assert.equal(JSON.parse(mutatingReview.stdout).reason, 'verify_command_not_allowed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-chat emits proof-specific verifier packet', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Verify review chat specificity',
      '--tag', 'agent',
      '--goal-objective', 'Make Review chat tell Codex exactly what to verify',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const tooEarly = runCli(['task', 'review-chat', ref, '--json'], { cwd: dir, env });
    assert.equal(tooEarly.status, 1);
    assert.equal(JSON.parse(tooEarly.stdout).reason, 'not_reviewable_open');

    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const proofContext = `${'context '.repeat(180)}Long proofs can carry setup notes before the verification commands.`;
    const proof = [
      proofContext,
      'Rechecked node --check commands/task.js lib/task-db.js passed, node --check test/commands.test.js passed, git status --porcelain -- commands/task.js lib/task-db.js test/commands.test.js clean, live ATRIS_SKIP_UPDATE_CHECK=1 atris task reviews --limit 3 --json from project-obelisk showed rows. tail-marker-full-proof-must-survive',
    ].join(' ');
    const ready = runCli([
      'task', 'ready', ref,
      '--proof', proof,
      '--lesson', 'Review packets need concrete proof targets',
      '--next', 'Wire the task page to launch this verifier',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.ok(readyPayload.handoff.verification_focus.commands_to_verify.some(command => command.includes('node --check commands/task.js')));
    assert.ok(readyPayload.handoff.verification_focus.commands_to_verify.some(command => command.includes('node --check test/commands.test.js')));
    assert.ok(readyPayload.handoff.verification_focus.files_to_inspect.includes('commands/task.js'));
    assert.match(readyPayload.handoff.codex_prompt, /Commands: command 1: node --check commands\/task\.js/);

    const reviewChat = runCli(['task', 'review-chat', ref, '--as', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(reviewChat.status, 0, reviewChat.stderr);
    const payload = JSON.parse(reviewChat.stdout);
    assert.equal(payload.action, 'review_chat');
    assert.equal(payload.contract.task.ref, ref);
    assert.equal(payload.contract.verification_focus.objective, 'Make Review chat tell Codex exactly what to verify');
    assert.equal(payload.contract.verification_focus.proof_claim, proof);
    assert.deepEqual(payload.contract.verification_focus.commands_to_verify.slice(0, 4), [
      'node --check commands/task.js lib/task-db.js',
      'node --check test/commands.test.js',
      'git status --porcelain -- commands/task.js lib/task-db.js test/commands.test.js',
      'ATRIS_SKIP_UPDATE_CHECK=1 atris task reviews --limit 3 --json',
    ]);
    assert.ok(payload.contract.verification_focus.commands_to_verify.some(command => command.includes('node --check commands/task.js')));
    assert.ok(payload.contract.verification_focus.commands_to_verify.some(command => command.includes('node --check test/commands.test.js')));
    assert.ok(payload.contract.verification_focus.commands_to_verify.some(command => command.includes('git status --porcelain')));
    assert.ok(payload.contract.verification_focus.files_to_inspect.includes('commands/task.js'));
    assert.ok(payload.contract.verification_focus.files_to_inspect.includes('lib/task-db.js'));
    assert.ok(payload.contract.verification_focus.files_to_inspect.includes('test/commands.test.js'));
    assert.ok(!payload.contract.verification_focus.commands_to_verify.some(command => command.includes('atris-cli/commands')));
    assert.ok(!payload.contract.verification_focus.files_to_inspect.some(file => file.includes('commands_to_verify/files_to_inspect')));
    assert.match(payload.contract.codex_prompt, /Verify review chat specificity/);
    assert.match(payload.contract.codex_prompt, /Commands: command 1: node --check commands\/task\.js/);
    assert.match(payload.contract.codex_prompt, /Files\/artifacts: commands\/task\.js, lib\/task-db\.js, test\/commands\.test\.js/);
    assert.match(payload.contract.required_checks.join('\n'), /Re-run or inspect these proof commands/);
    assert.match(payload.contract.required_checks.join('\n'), /Inspect these named files\/artifacts/);
    assert.match(payload.task.messages.at(-1).content, /TASK_REVIEW_CHAT/);
    assert.match(payload.task.messages.at(-1).content, /proof_claim: context context/);
    assert.match(payload.task.messages.at(-1).content, /tail-marker-full-proof-must-survive/);
    assert.match(payload.task.messages.at(-1).content, /commands_to_verify:\n- node --check commands\/task\.js/);
    assert.match(payload.task.messages.at(-1).content, /files_to_inspect:\n- commands\/task\.js/);
    assert.ok(Array.isArray(payload.contract.verification_focus.recent_thread));
    assert.match(payload.task.messages.at(-1).content, /pass: atris task review/);
    assert.match(payload.task.messages.at(-1).content, /human_accept_xp: atris task accept/);
    assert.match(payload.task.messages.at(-1).content.slice(0, 500), /human_accept_xp: atris task accept/);

    const reviewProof = [
      `${'context '.repeat(180)}Long verifier review proof before commands`,
      'node --check test/commands.test.js passed',
      'git status --porcelain -- commands/task.js test/commands.test.js clean',
    ].join('; ');
    const proofReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', reviewProof,
      '--json',
    ], { cwd: dir, env });
    assert.equal(proofReview.status, 0, proofReview.stderr);

    const statusAfterProofReview = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(statusAfterProofReview.status, 0, statusAfterProofReview.stderr);
    const statusReview = JSON.parse(statusAfterProofReview.stdout).status.needs_review[0].review;
    assert.match(statusReview.proof, /context context/);
    assert.equal(statusReview.agent_certified, true);
    assert.equal(statusReview.verification_chat, undefined);

    const showAfterProofReview = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(showAfterProofReview.status, 0, showAfterProofReview.stderr);
    const showReview = JSON.parse(showAfterProofReview.stdout).review;
    assert.equal(showReview.proof, reviewProof);
    assert.equal(showReview.agent_certified, true);
    assert.equal(showReview.verification_chat, undefined);

    const certifiedReviewProof = [
      `${'context '.repeat(180)}Certified rows can still receive newer verifier proof`,
      'node --check test/commands.test.js passed after certification',
      'git status --porcelain -- commands/task.js lib/task-db.js test/commands.test.js clean',
    ].join('; ');
    const certifiedProofReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', certifiedReviewProof,
      '--json',
    ], { cwd: dir, env });
    assert.equal(certifiedProofReview.status, 0, certifiedProofReview.stderr);

    const certifiedStatus = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(certifiedStatus.status, 0, certifiedStatus.stderr);
    const certifiedStatusReview = JSON.parse(certifiedStatus.stdout).status.needs_review[0].review;
    assert.match(certifiedStatusReview.proof, /context context/);
    assert.equal(certifiedStatusReview.verification_chat, undefined);

    const certifiedShow = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(certifiedShow.status, 0, certifiedShow.stderr);
    const certifiedShowReview = JSON.parse(certifiedShow.stdout).review;
    assert.equal(certifiedShowReview.proof, certifiedReviewProof);
    assert.equal(certifiedShowReview.verification_chat, undefined);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-chat extracts only proof-derived verifier commands', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const semicolonTask = runCli(['task', 'new', 'Semicolon proof commands', '--json'], { cwd: dir, env });
    assert.equal(semicolonTask.status, 0, semicolonTask.stderr);
    const semicolonRef = JSON.parse(semicolonTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', semicolonRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const semicolonReady = runCli([
      'task', 'ready', semicolonRef,
      '--as', 'codex',
      '--proof', '`node --check commands/task.js` passed; `node --check test/commands.test.js` passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(semicolonReady.status, 0, semicolonReady.stderr);
    const semicolonChat = runCli(['task', 'review-chat', semicolonRef, '--json'], { cwd: dir, env });
    assert.equal(semicolonChat.status, 0, semicolonChat.stderr);
    assert.deepEqual(JSON.parse(semicolonChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check test/commands.test.js',
    ]);

    const commaTask = runCli(['task', 'new', 'Comma proof commands', '--json'], { cwd: dir, env });
    assert.equal(commaTask.status, 0, commaTask.stderr);
    const commaRef = JSON.parse(commaTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', commaRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const commaReady = runCli([
      'task', 'ready', commaRef,
      '--as', 'codex',
      '--proof', 'Installed Atris review-chat command extraction changed. Verification passed: node --check commands/task.js, verified node --check test/commands.test.js 295/295, scoped git status --porcelain -- commands/task.js test/commands.test.js clean, live ATRIS_SKIP_UPDATE_CHECK=1 atris task status --json returned ok',
      '--json',
    ], { cwd: dir, env });
    assert.equal(commaReady.status, 0, commaReady.stderr);
    const commaChat = runCli(['task', 'review-chat', commaRef, '--json'], { cwd: dir, env });
    assert.equal(commaChat.status, 0, commaChat.stderr);
    assert.deepEqual(JSON.parse(commaChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check test/commands.test.js',
      'git status --porcelain -- commands/task.js test/commands.test.js',
      'ATRIS_SKIP_UPDATE_CHECK=1 atris task status --json',
    ]);

    const narratedTask = runCli(['task', 'new', 'Narrated CLI proof commands', '--json'], { cwd: dir, env });
    assert.equal(narratedTask.status, 0, narratedTask.stderr);
    const narratedRef = JSON.parse(narratedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', narratedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const narratedReady = runCli([
      'task', 'ready', narratedRef,
      '--as', 'codex',
      '--proof', 'Validation passed: node /Users/owner/arena/atris-cli/bin/atris.js business check printed Ready: yes; node /Users/owner/arena/atris-cli/bin/atris.js business share --write wrote atris/reports/share.md; node /Users/owner/arena/atris-cli/bin/atris.js app list reported agentgrads-match-room runtime=local',
      '--json',
    ], { cwd: dir, env });
    assert.equal(narratedReady.status, 0, narratedReady.stderr);
    const narratedChat = runCli(['task', 'review-chat', narratedRef, '--json'], { cwd: dir, env });
    assert.equal(narratedChat.status, 0, narratedChat.stderr);
    assert.deepEqual(JSON.parse(narratedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node /Users/owner/arena/atris-cli/bin/atris.js business check',
      'node /Users/owner/arena/atris-cli/bin/atris.js business share --write',
      'node /Users/owner/arena/atris-cli/bin/atris.js app list',
    ]);

    const pathPassedTask = runCli(['task', 'new', 'Path then passed proof commands', '--json'], { cwd: dir, env });
    assert.equal(pathPassedTask.status, 0, pathPassedTask.stderr);
    const pathPassedRef = JSON.parse(pathPassedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pathPassedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pathPassedReady = runCli([
      'task', 'ready', pathPassedRef,
      '--as', 'codex',
      '--proof', 'Inspected commands/workflow.js, bin/atris.js, and atris/MAP.md. Passed: node --check commands/workflow.js; node --check test/apps.test.js (11/11); git status --porcelain -- commands/workflow.js bin/atris.js atris/MAP.md clean',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pathPassedReady.status, 0, pathPassedReady.stderr);
    const pathPassedChat = runCli(['task', 'review-chat', pathPassedRef, '--json'], { cwd: dir, env });
    assert.equal(pathPassedChat.status, 0, pathPassedChat.stderr);
    assert.deepEqual(JSON.parse(pathPassedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/workflow.js',
      'node --check test/apps.test.js',
      'git status --porcelain -- commands/workflow.js bin/atris.js atris/MAP.md',
    ]);

    const chainedTask = runCli(['task', 'new', 'Chained proof commands', '--json'], { cwd: dir, env });
    assert.equal(chainedTask.status, 0, chainedTask.stderr);
    const chainedRef = JSON.parse(chainedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', chainedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const chainedReady = runCli([
      'task', 'ready', chainedRef,
      '--as', 'codex',
      '--proof', 'Verified node --check commands/task.js && node --check lib/task-db.js; node --check test/auto-accept-certified.test.js 6/6; typecheck passed; installed Atris review-chat command extraction changed; installed atris temp review-chat smoke confirmed specificity; installed atris smoke confirmed review-chat specificity',
      '--json',
    ], { cwd: dir, env });
    assert.equal(chainedReady.status, 0, chainedReady.stderr);
    const chainedChat = runCli(['task', 'review-chat', chainedRef, '--json'], { cwd: dir, env });
    assert.equal(chainedChat.status, 0, chainedChat.stderr);
    assert.deepEqual(JSON.parse(chainedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check lib/task-db.js',
      'node --check test/auto-accept-certified.test.js',
    ]);

    const fencedTask = runCli(['task', 'new', 'Fenced proof commands', '--json'], { cwd: dir, env });
    assert.equal(fencedTask.status, 0, fencedTask.stderr);
    const fencedRef = JSON.parse(fencedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', fencedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const fencedReady = runCli([
      'task', 'ready', fencedRef,
      '--as', 'codex',
      '--proof', '```bash\nnode --check commands/task.js\nnode --check test/json-output.test.js passed\n```',
      '--json',
    ], { cwd: dir, env });
    assert.equal(fencedReady.status, 0, fencedReady.stderr);
    const fencedChat = runCli(['task', 'review-chat', fencedRef, '--json'], { cwd: dir, env });
    assert.equal(fencedChat.status, 0, fencedChat.stderr);
    assert.deepEqual(JSON.parse(fencedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check test/json-output.test.js',
    ]);

    const titleOnlyTask = runCli(['task', 'new', 'Fix git diff display', '--json'], { cwd: dir, env });
    assert.equal(titleOnlyTask.status, 0, titleOnlyTask.stderr);
    const titleOnlyRef = JSON.parse(titleOnlyTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', titleOnlyRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const titleOnlyReady = runCli([
      'task', 'ready', titleOnlyRef,
      '--as', 'codex',
      '--proof', 'manual browser validation passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(titleOnlyReady.status, 0, titleOnlyReady.stderr);
    const titleOnlyChat = runCli(['task', 'review-chat', titleOnlyRef, '--json'], { cwd: dir, env });
    assert.equal(titleOnlyChat.status, 0, titleOnlyChat.stderr);
    const titleOnlyPayload = JSON.parse(titleOnlyChat.stdout);
    assert.deepEqual(titleOnlyPayload.contract.verification_focus.commands_to_verify, []);
    assert.match(titleOnlyPayload.contract.required_checks.join('\n'), /Find the concrete verifier command/);

    const pathOnlyTask = runCli(['task', 'new', 'Inspect artifact path', '--json'], { cwd: dir, env });
    assert.equal(pathOnlyTask.status, 0, pathOnlyTask.stderr);
    const pathOnlyRef = JSON.parse(pathOnlyTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pathOnlyRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pathOnlyReady = runCli([
      'task', 'ready', pathOnlyRef,
      '--as', 'codex',
      '--proof', 'inspected commands/git-diff.js passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pathOnlyReady.status, 0, pathOnlyReady.stderr);
    const pathOnlyChat = runCli(['task', 'review-chat', pathOnlyRef, '--json'], { cwd: dir, env });
    assert.equal(pathOnlyChat.status, 0, pathOnlyChat.stderr);
    const pathOnlyPayload = JSON.parse(pathOnlyChat.stdout);
    assert.deepEqual(pathOnlyPayload.contract.verification_focus.commands_to_verify, []);
    assert.ok(pathOnlyPayload.contract.verification_focus.files_to_inspect.includes('commands/git-diff.js'));

    const detailTask = runCli(['task', 'new', 'Trim status details', '--json'], { cwd: dir, env });
    assert.equal(detailTask.status, 0, detailTask.stderr);
    const detailRef = JSON.parse(detailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', detailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const detailReady = runCli([
      'task', 'ready', detailRef,
      '--as', 'codex',
      '--proof', 'Full `node --check test/commands.test.js` passed: 299 tests, 0 failures.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(detailReady.status, 0, detailReady.stderr);
    const detailChat = runCli(['task', 'review-chat', detailRef, '--json'], { cwd: dir, env });
    assert.equal(detailChat.status, 0, detailChat.stderr);
    assert.deepEqual(JSON.parse(detailChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/commands.test.js',
    ]);

    const punctuationTask = runCli(['task', 'new', 'Trim status punctuation', '--json'], { cwd: dir, env });
    assert.equal(punctuationTask.status, 0, punctuationTask.stderr);
    const punctuationRef = JSON.parse(punctuationTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', punctuationRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const punctuationReady = runCli([
      'task', 'ready', punctuationRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(punctuationReady.status, 0, punctuationReady.stderr);
    const punctuationChat = runCli(['task', 'review-chat', punctuationRef, '--json'], { cwd: dir, env });
    assert.equal(punctuationChat.status, 0, punctuationChat.stderr);
    assert.deepEqual(JSON.parse(punctuationChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/commands.test.js',
    ]);

    const bracketTask = runCli(['task', 'new', 'Bracket proof list', '--json'], { cwd: dir, env });
    assert.equal(bracketTask.status, 0, bracketTask.stderr);
    const bracketRef = JSON.parse(bracketTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', bracketRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const bracketProof = 'live review-chat dry-run emitted [node --check commands/task.js, node --check test/commands.test.js, git diff --check]';
    const bracketRow = JSON.parse(runCli(['task', 'show', bracketRef, '--json'], { cwd: dir, env }).stdout);
    const bracketDb = taskStore.open(dbPath);
    try {
      const seeded = taskStore.readyTask(bracketDb, { id: bracketRow.id, actor: 'codex', proof: bracketProof });
      assert.equal(seeded.ready, true, seeded.reason);
    } finally {
      taskStore.close();
    }
    const bracketChat = runCli(['task', 'review-chat', bracketRef, '--json'], { cwd: dir, env });
    assert.equal(bracketChat.status, 0, bracketChat.stderr);
    assert.deepEqual(JSON.parse(bracketChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check test/commands.test.js',
      'git diff --check',
    ]);

    const pseudoTask = runCli(['task', 'new', 'Reject prose pseudo command', '--json'], { cwd: dir, env });
    assert.equal(pseudoTask.status, 0, pseudoTask.stderr);
    const pseudoRef = JSON.parse(pseudoTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pseudoRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pseudoReady = runCli([
      'task', 'ready', pseudoRef,
      '--as', 'codex',
      '--proof', 'validation passed: node command tests passed; run_id=123456789',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pseudoReady.status, 0, pseudoReady.stderr);
    const pseudoChat = runCli(['task', 'review-chat', pseudoRef, '--json'], { cwd: dir, env });
    assert.equal(pseudoChat.status, 0, pseudoChat.stderr);
    assert.deepEqual(JSON.parse(pseudoChat.stdout).contract.verification_focus.commands_to_verify, []);

    const npmPseudoTask = runCli(['task', 'new', 'Reject npm prose pseudo command', '--json'], { cwd: dir, env });
    assert.equal(npmPseudoTask.status, 0, npmPseudoTask.stderr);
    const npmPseudoRef = JSON.parse(npmPseudoTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', npmPseudoRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const npmPseudoReady = runCli([
      'task', 'ready', npmPseudoRef,
      '--as', 'codex',
      '--proof', 'validation passed: npm command tests passed; run_id=123456789',
      '--json',
    ], { cwd: dir, env });
    assert.equal(npmPseudoReady.status, 0, npmPseudoReady.stderr);
    const npmPseudoChat = runCli(['task', 'review-chat', npmPseudoRef, '--json'], { cwd: dir, env });
    assert.equal(npmPseudoChat.status, 0, npmPseudoChat.stderr);
    assert.deepEqual(JSON.parse(npmPseudoChat.stdout).contract.verification_focus.commands_to_verify, []);

    const pluralPseudoTask = runCli(['task', 'new', 'Reject plural prose pseudo commands', '--json'], { cwd: dir, env });
    assert.equal(pluralPseudoTask.status, 0, pluralPseudoTask.stderr);
    const pluralPseudoRef = JSON.parse(pluralPseudoTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pluralPseudoRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pluralPseudoReady = runCli([
      'task', 'ready', pluralPseudoRef,
      '--as', 'codex',
      '--proof', 'validation passed: typechecks passed, git checks passed; run_id=123456789',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pluralPseudoReady.status, 0, pluralPseudoReady.stderr);
    const pluralPseudoChat = runCli(['task', 'review-chat', pluralPseudoRef, '--json'], { cwd: dir, env });
    assert.equal(pluralPseudoChat.status, 0, pluralPseudoChat.stderr);
    assert.deepEqual(JSON.parse(pluralPseudoChat.stdout).contract.verification_focus.commands_to_verify, []);

    const atrisSlugTask = runCli(['task', 'new', 'Reject Atris slug prose pseudo command', '--json'], { cwd: dir, env });
    assert.equal(atrisSlugTask.status, 0, atrisSlugTask.stderr);
    const atrisSlugRef = JSON.parse(atrisSlugTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', atrisSlugRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const atrisSlugReady = runCli([
      'task', 'ready', atrisSlugRef,
      '--as', 'codex',
      '--proof', 'Second-pass review: recruiting shortcut fallback is scoped to the built-in atris-labs shortcut, keeps generic business lookup strict, and full typecheck passed 1635/1635; run_id=123456789.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(atrisSlugReady.status, 0, atrisSlugReady.stderr);
    const atrisSlugReadyPayload = JSON.parse(atrisSlugReady.stdout);
    assert.equal(atrisSlugReadyPayload.task.review.landing.tested, 'I attached the proof below.');
    const atrisSlugChat = runCli(['task', 'review-chat', atrisSlugRef, '--json'], { cwd: dir, env });
    assert.equal(atrisSlugChat.status, 0, atrisSlugChat.stderr);
    assert.deepEqual(JSON.parse(atrisSlugChat.stdout).contract.verification_focus.commands_to_verify, []);

    const atrisWildcardTask = runCli(['task', 'new', 'Reject Atris wildcard prose pseudo command', '--json'], { cwd: dir, env });
    assert.equal(atrisWildcardTask.status, 0, atrisWildcardTask.stderr);
    const atrisWildcardRef = JSON.parse(atrisWildcardTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', atrisWildcardRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const atrisWildcardReady = runCli([
      'task', 'ready', atrisWildcardRef,
      '--as', 'codex',
      '--proof', 'Second-pass review: extractor now rejects atris-* slug prose before command token matching; live review queue shows CLI-640 Commands: typecheck only; node --check test/commands.test.js passed 381/381.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(atrisWildcardReady.status, 0, atrisWildcardReady.stderr);
    const atrisWildcardReadyPayload = JSON.parse(atrisWildcardReady.stdout);
    assert.equal(atrisWildcardReadyPayload.task.review.landing.tested, 'I ran the listed check for this result.');
    assert.doesNotMatch(atrisWildcardReadyPayload.task.review.landing.tested, /atris-\*/);
    assert.doesNotMatch(atrisWildcardReadyPayload.task.review.landing.tested, /npm test only/);
    const atrisWildcardChat = runCli(['task', 'review-chat', atrisWildcardRef, '--json'], { cwd: dir, env });
    assert.equal(atrisWildcardChat.status, 0, atrisWildcardChat.stderr);
    assert.deepEqual(JSON.parse(atrisWildcardChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/commands.test.js',
    ]);

    const proseSegmentTask = runCli(['task', 'new', 'Semicolon prose segment', '--json'], { cwd: dir, env });
    assert.equal(proseSegmentTask.status, 0, proseSegmentTask.stderr);
    const proseSegmentRef = JSON.parse(proseSegmentTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', proseSegmentRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const proseSegmentReady = runCli([
      'task', 'ready', proseSegmentRef,
      '--as', 'codex',
      '--proof', 'Receipt saved at atris/runs/proof.json. node --check commands/task.js; focused three-test command; git status --porcelain -- commands/task.js test/commands.test.js',
      '--json',
    ], { cwd: dir, env });
    assert.equal(proseSegmentReady.status, 0, proseSegmentReady.stderr);
    const proseSegmentChat = runCli(['task', 'review-chat', proseSegmentRef, '--json'], { cwd: dir, env });
    assert.equal(proseSegmentChat.status, 0, proseSegmentChat.stderr);
    assert.deepEqual(JSON.parse(proseSegmentChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'git status --porcelain -- commands/task.js test/commands.test.js',
    ]);

    const thenJoinedTask = runCli(['task', 'new', 'Then joined commands', '--json'], { cwd: dir, env });
    assert.equal(thenJoinedTask.status, 0, thenJoinedTask.stderr);
    const thenJoinedRef = JSON.parse(thenJoinedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', thenJoinedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const thenJoinedReady = runCli([
      'task', 'ready', thenJoinedRef,
      '--as', 'codex',
      '--proof', 'node --check commands/task.js then node --check test/commands.test.js passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(thenJoinedReady.status, 0, thenJoinedReady.stderr);
    const thenJoinedChat = runCli(['task', 'review-chat', thenJoinedRef, '--json'], { cwd: dir, env });
    assert.equal(thenJoinedChat.status, 0, thenJoinedChat.stderr);
    assert.deepEqual(JSON.parse(thenJoinedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check test/commands.test.js',
    ]);

    const pipelineTask = runCli(['task', 'new', 'Preserve pipeline command', '--json'], { cwd: dir, env });
    assert.equal(pipelineTask.status, 0, pipelineTask.stderr);
    const pipelineRef = JSON.parse(pipelineTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pipelineRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pipelineReady = runCli([
      'task', 'ready', pipelineRef,
      '--as', 'codex',
      '--proof', 'curl -fsS http://127.0.0.1:8000/api/health | rg ok passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pipelineReady.status, 0, pipelineReady.stderr);
    const pipelineChat = runCli(['task', 'review-chat', pipelineRef, '--json'], { cwd: dir, env });
    assert.equal(pipelineChat.status, 0, pipelineChat.stderr);
    assert.deepEqual(JSON.parse(pipelineChat.stdout).contract.verification_focus.commands_to_verify, [
      'curl -fsS http://127.0.0.1:8000/api/health | rg ok',
    ]);

    const parenStatusTask = runCli(['task', 'new', 'Trim parenthesized status', '--json'], { cwd: dir, env });
    assert.equal(parenStatusTask.status, 0, parenStatusTask.stderr);
    const parenStatusRef = JSON.parse(parenStatusTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', parenStatusRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const parenStatusReady = runCli([
      'task', 'ready', parenStatusRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js (passed)',
      '--json',
    ], { cwd: dir, env });
    assert.equal(parenStatusReady.status, 0, parenStatusReady.stderr);
    const parenStatusChat = runCli(['task', 'review-chat', parenStatusRef, '--json'], { cwd: dir, env });
    assert.equal(parenStatusChat.status, 0, parenStatusChat.stderr);
    assert.deepEqual(JSON.parse(parenStatusChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/commands.test.js',
    ]);

    const exitStatusTask = runCli(['task', 'new', 'Trim exit status annotation', '--json'], { cwd: dir, env });
    assert.equal(exitStatusTask.status, 0, exitStatusTask.stderr);
    const exitStatusRef = JSON.parse(exitStatusTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', exitStatusRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const exitStatusReady = runCli([
      'task', 'ready', exitStatusRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed (exit 0)',
      '--json',
    ], { cwd: dir, env });
    assert.equal(exitStatusReady.status, 0, exitStatusReady.stderr);
    const exitStatusChat = runCli(['task', 'review-chat', exitStatusRef, '--json'], { cwd: dir, env });
    assert.equal(exitStatusChat.status, 0, exitStatusChat.stderr);
    assert.deepEqual(JSON.parse(exitStatusChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/commands.test.js',
    ]);

    const statusSentenceTask = runCli(['task', 'new', 'Trim status sentence', '--json'], { cwd: dir, env });
    assert.equal(statusSentenceTask.status, 0, statusSentenceTask.stderr);
    const statusSentenceRef = JSON.parse(statusSentenceTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', statusSentenceRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const statusSentenceReady = runCli([
      'task', 'ready', statusSentenceRef,
      '--as', 'codex',
      '--proof', 'validation passed: node --check commands/task.js passed. Output clean.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(statusSentenceReady.status, 0, statusSentenceReady.stderr);
    const statusSentenceChat = runCli(['task', 'review-chat', statusSentenceRef, '--json'], { cwd: dir, env });
    assert.equal(statusSentenceChat.status, 0, statusSentenceChat.stderr);
    assert.deepEqual(JSON.parse(statusSentenceChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
    ]);

    const passCountTask = runCli(['task', 'new', 'Trim pass count suffix', '--json'], { cwd: dir, env });
    assert.equal(passCountTask.status, 0, passCountTask.stderr);
    const passCountRef = JSON.parse(passCountTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', passCountRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const passCountReady = runCli([
      'task', 'ready', passCountRef,
      '--as', 'codex',
      '--proof', 'full node --check test/commands.test.js passed 299/299',
      '--json',
    ], { cwd: dir, env });
    assert.equal(passCountReady.status, 0, passCountReady.stderr);
    const passCountChat = runCli(['task', 'review-chat', passCountRef, '--json'], { cwd: dir, env });
    assert.equal(passCountChat.status, 0, passCountChat.stderr);
    assert.deepEqual(JSON.parse(passCountChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/commands.test.js',
    ]);

    const passExplanationTask = runCli(['task', 'new', 'Trim pass count explanation', '--json'], { cwd: dir, env });
    assert.equal(passExplanationTask.status, 0, passExplanationTask.stderr);
    const passExplanationRef = JSON.parse(passExplanationTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', passExplanationRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const passExplanationReady = runCli([
      'task', 'ready', passExplanationRef,
      '--as', 'codex',
      '--proof', "node --check test/mission-status.test.js passed 51/51, including the new regression 'mission tick keeps task-backed always-on caller-session missions runnable without verifier'. Live proof: atris mission tick mission-abc.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(passExplanationReady.status, 0, passExplanationReady.stderr);
    const passExplanationChat = runCli(['task', 'review-chat', passExplanationRef, '--json'], { cwd: dir, env });
    assert.equal(passExplanationChat.status, 0, passExplanationChat.stderr);
    assert.deepEqual(JSON.parse(passExplanationChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/mission-status.test.js',
    ]);

    const changedFilesTailTask = runCli(['task', 'new', 'Trim changed files tail', '--json'], { cwd: dir, env });
    assert.equal(changedFilesTailTask.status, 0, changedFilesTailTask.stderr);
    const changedFilesTailRef = JSON.parse(changedFilesTailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', changedFilesTailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const changedFilesTailReady = runCli([
      'task', 'ready', changedFilesTailRef,
      '--as', 'codex',
      '--proof', 'node --check test/mission-status.test.js passed 46/46. Changed files: lib/mission-room.js adds business-move naming.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(changedFilesTailReady.status, 0, changedFilesTailReady.stderr);
    const changedFilesTailChat = runCli(['task', 'review-chat', changedFilesTailRef, '--json'], { cwd: dir, env });
    assert.equal(changedFilesTailChat.status, 0, changedFilesTailChat.stderr);
    assert.deepEqual(JSON.parse(changedFilesTailChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/mission-status.test.js',
    ]);

    const passedWithTailTask = runCli(['task', 'new', 'Trim passed with tail', '--json'], { cwd: dir, env });
    assert.equal(passedWithTailTask.status, 0, passedWithTailTask.stderr);
    const passedWithTailRef = JSON.parse(passedWithTailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', passedWithTailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const passedWithTailReady = runCli([
      'task', 'ready', passedWithTailRef,
      '--as', 'codex',
      '--proof', 'node scripts/verify-mission-room.js passed with member=mission-lead. node --check test/mission-status.test.js passed.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(passedWithTailReady.status, 0, passedWithTailReady.stderr);
    const passedWithTailChat = runCli(['task', 'review-chat', passedWithTailRef, '--json'], { cwd: dir, env });
    assert.equal(passedWithTailChat.status, 0, passedWithTailChat.stderr);
    assert.deepEqual(JSON.parse(passedWithTailChat.stdout).contract.verification_focus.commands_to_verify, [
      'node scripts/verify-mission-room.js',
      'node --check test/mission-status.test.js',
    ]);

    const exampleCommandTask = runCli(['task', 'new', 'Ignore example command subject', '--json'], { cwd: dir, env });
    assert.equal(exampleCommandTask.status, 0, exampleCommandTask.stderr);
    const exampleCommandRef = JSON.parse(exampleCommandTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', exampleCommandRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const exampleCommandReady = runCli([
      'task', 'ready', exampleCommandRef,
      '--as', 'codex',
      '--proof', 'Product proof: review packets no longer ask humans to rerun result text like node scripts/verify-mission-room.js passed with member=mission-lead. Checks: node -c commands/task.js; git status --porcelain.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(exampleCommandReady.status, 0, exampleCommandReady.stderr);
    const exampleCommandChat = runCli(['task', 'review-chat', exampleCommandRef, '--json'], { cwd: dir, env });
    assert.equal(exampleCommandChat.status, 0, exampleCommandChat.stderr);
    assert.deepEqual(JSON.parse(exampleCommandChat.stdout).contract.verification_focus.commands_to_verify, [
      'node -c commands/task.js',
      'git status --porcelain',
    ]);

    const commaResultTask = runCli(['task', 'new', 'Trim comma result prose', '--json'], { cwd: dir, env });
    assert.equal(commaResultTask.status, 0, commaResultTask.stderr);
    const commaResultRef = JSON.parse(commaResultTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', commaResultRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const commaResultReady = runCli([
      'task', 'ready', commaResultRef,
      '--as', 'codex',
      '--proof', 'Receipt saved at atris/runs/proof.json. node --check commands/mission.js passed, live run proved stderr_empty=true. Checks: git status --porcelain.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(commaResultReady.status, 0, commaResultReady.stderr);
    const commaResultChat = runCli(['task', 'review-chat', commaResultRef, '--json'], { cwd: dir, env });
    assert.equal(commaResultChat.status, 0, commaResultChat.stderr);
    assert.deepEqual(JSON.parse(commaResultChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/mission.js',
      'git status --porcelain',
    ]);

    const focusedSuiteTask = runCli(['task', 'new', 'Split focused suite verifier', '--json'], { cwd: dir, env });
    assert.equal(focusedSuiteTask.status, 0, focusedSuiteTask.stderr);
    const focusedSuiteRef = JSON.parse(focusedSuiteTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', focusedSuiteRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const focusedSuiteReady = runCli([
      'task', 'ready', focusedSuiteRef,
      '--as', 'codex',
      '--proof', 'node scripts/verify-mission-room.js. Focused suite also passed separately: node --check test/mission-status.test.js.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(focusedSuiteReady.status, 0, focusedSuiteReady.stderr);
    const focusedSuiteChat = runCli(['task', 'review-chat', focusedSuiteRef, '--json'], { cwd: dir, env });
    assert.equal(focusedSuiteChat.status, 0, focusedSuiteChat.stderr);
    assert.deepEqual(JSON.parse(focusedSuiteChat.stdout).contract.verification_focus.commands_to_verify, [
      'node scripts/verify-mission-room.js',
      'node --check test/mission-status.test.js',
    ]);

    const commaProseTask = runCli(['task', 'new', 'Trim comma prose command list', '--json'], { cwd: dir, env });
    assert.equal(commaProseTask.status, 0, commaProseTask.stderr);
    const commaProseRef = JSON.parse(commaProseTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', commaProseRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const commaProseReady = runCli([
      'task', 'ready', commaProseRef,
      '--as', 'codex',
      '--proof', 'Verified commands/task.js with node -c commands/task.js passed, command suite, clean dry-run, brain compile.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(commaProseReady.status, 0, commaProseReady.stderr);
    const commaProseChat = runCli(['task', 'review-chat', commaProseRef, '--json'], { cwd: dir, env });
    assert.equal(commaProseChat.status, 0, commaProseChat.stderr);
    assert.deepEqual(JSON.parse(commaProseChat.stdout).contract.verification_focus.commands_to_verify, [
      'node -c commands/task.js',
    ]);

    const describedCommandTask = runCli(['task', 'new', 'Ignore described command subject', '--json'], { cwd: dir, env });
    assert.equal(describedCommandTask.status, 0, describedCommandTask.stderr);
    const describedCommandRef = JSON.parse(describedCommandTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', describedCommandRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const describedCommandReady = runCli([
      'task', 'ready', describedCommandRef,
      '--as', 'codex',
      '--proof', 'Receipt saved at atris/runs/proof.json. Product proof: parser extracts only node --check test/mission-status.test.js. Checks: node -c commands/task.js; git status --porcelain.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(describedCommandReady.status, 0, describedCommandReady.stderr);
    const describedCommandChat = runCli(['task', 'review-chat', describedCommandRef, '--json'], { cwd: dir, env });
    assert.equal(describedCommandChat.status, 0, describedCommandChat.stderr);
    assert.deepEqual(JSON.parse(describedCommandChat.stdout).contract.verification_focus.commands_to_verify, [
      'node -c commands/task.js',
      'git status --porcelain',
    ]);

    const productProofTask = runCli(['task', 'new', 'Product proof command extraction', '--json'], { cwd: dir, env });
    assert.equal(productProofTask.status, 0, productProofTask.stderr);
    const productProofRef = JSON.parse(productProofTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', productProofRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const productProofReady = runCli([
      'task', 'ready', productProofRef,
      '--as', 'codex',
      '--proof', "Product proof: live mission goal now says next_command=atris mission run mission-2026-06-30-work-overnight-and-see-where-1858e505, so the overnight loop continues instead of asking for task review. Checks: node -c commands/mission.js; node --check test/mission-status.test.js --test-name-pattern 'always-on|mission goal' (57 pass); node bin/atris.js mission goal --json; node bin/atris.js clean --dry-run --json; git status --porcelain; node bin/atris.js brain compile --root . --verify.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(productProofReady.status, 0, productProofReady.stderr);
    const productProofReadyPayload = JSON.parse(productProofReady.stdout);
    assert.equal(productProofReadyPayload.task.review.landing.tested, 'I ran the listed checks for this result.');
    assert.doesNotMatch(productProofReadyPayload.task.review.landing.tested, /node -c commands\/mission\.js \| node --check/);
    const productProofChat = runCli(['task', 'review-chat', productProofRef, '--json'], { cwd: dir, env });
    assert.equal(productProofChat.status, 0, productProofChat.stderr);
    const productProofPayload = JSON.parse(productProofChat.stdout);
    assert.deepEqual(productProofPayload.contract.verification_focus.commands_to_verify, [
      'node -c commands/mission.js',
      "node --check test/mission-status.test.js --test-name-pattern 'always-on|mission goal'",
      'node bin/atris.js mission goal --json',
      'node bin/atris.js clean --dry-run --json',
      'git status --porcelain',
      'node bin/atris.js brain compile --root . --verify',
    ]);
    assert.match(productProofPayload.contract.codex_prompt, /command 1: node -c commands\/mission\.js/);
    assert.doesNotMatch(productProofPayload.contract.codex_prompt, /node -c commands\/mission\.js \| node --check/);

    const quotedPipeTask = runCli(['task', 'new', 'Quoted pipe proof command', '--json'], { cwd: dir, env });
    assert.equal(quotedPipeTask.status, 0, quotedPipeTask.stderr);
    const quotedPipeRef = JSON.parse(quotedPipeTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', quotedPipeRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const quotedPipeReady = runCli([
      'task', 'ready', quotedPipeRef,
      '--as', 'codex',
      '--proof', "Checks passed: node --check test/commands.test.js --test-name-pattern 'always-on mission run keeps ticking|clean dry-run shows MAP refs|clean --dry-run --json reports machine-readable health' (380 pass); git status --porcelain.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(quotedPipeReady.status, 0, quotedPipeReady.stderr);
    const quotedPipeReadyPayload = JSON.parse(quotedPipeReady.stdout);
    assert.equal(quotedPipeReadyPayload.task.review.landing.tested, 'I ran the listed checks for this result.');
    assert.doesNotMatch(quotedPipeReadyPayload.task.review.landing.tested, /health' \| git status --porcelain/);
    const quotedPipeChat = runCli(['task', 'review-chat', quotedPipeRef, '--json'], { cwd: dir, env });
    assert.equal(quotedPipeChat.status, 0, quotedPipeChat.stderr);
    const quotedPipePayload = JSON.parse(quotedPipeChat.stdout);
    assert.deepEqual(quotedPipePayload.contract.verification_focus.commands_to_verify, [
      "node --check test/commands.test.js --test-name-pattern 'always-on mission run keeps ticking|clean dry-run shows MAP refs|clean --dry-run --json reports machine-readable health'",
      'git status --porcelain',
    ]);
    assert.match(quotedPipePayload.contract.codex_prompt, /command 1: node --check test\/commands\.test\.js/);
    assert.match(quotedPipePayload.contract.required_checks.join('\n'), /command 2: git status --porcelain/);
    assert.doesNotMatch(quotedPipePayload.contract.codex_prompt, /health' \| git status --porcelain/);
    assert.doesNotMatch(quotedPipePayload.contract.required_checks.join('\n'), /health' \| git status --porcelain/);

    const quotedListTask = runCli(['task', 'new', 'Quoted command-list examples', '--json'], { cwd: dir, env });
    assert.equal(quotedListTask.status, 0, quotedListTask.stderr);
    const quotedListRef = JSON.parse(quotedListTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', quotedListRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const quotedListReady = runCli([
      'task', 'ready', quotedListRef,
      '--as', 'codex',
      '--proof', "Product proof says 'Commands: command 1: <pipe-containing test command>; command 2: git status --porcelain'. Checks passed: node -c commands/task.js; git status --porcelain.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(quotedListReady.status, 0, quotedListReady.stderr);
    const quotedListPayload = JSON.parse(quotedListReady.stdout);
    assert.deepEqual(quotedListPayload.handoff.verification_focus.commands_to_verify, [
      'node -c commands/task.js',
      'git status --porcelain',
    ]);
    assert.equal(quotedListPayload.task.review.landing.tested, 'I ran the listed checks for this result.');

    const quotedProductTask = runCli(['task', 'new', 'Quoted product command example', '--json'], { cwd: dir, env });
    assert.equal(quotedProductTask.status, 0, quotedProductTask.stderr);
    const quotedProductRef = JSON.parse(quotedProductTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', quotedProductRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const quotedProductReady = runCli([
      'task', 'ready', quotedProductRef,
      '--as', 'codex',
      '--proof', "Product proof: live Mission Report plain text now ends with 'Next: atris mission run mission-2026-06-30-work-overnight-and-see-where-1858e505' instead of 'Next: next move: run ...'. JSON still keeps operator_next raw for machines. Checks: node -c commands/mission.js; node --check test/mission-status.test.js --test-name-pattern 'mission report' (60 pass); git status --porcelain.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(quotedProductReady.status, 0, quotedProductReady.stderr);
    const quotedProductChat = runCli(['task', 'review-chat', quotedProductRef, '--json'], { cwd: dir, env });
    assert.equal(quotedProductChat.status, 0, quotedProductChat.stderr);
    assert.deepEqual(JSON.parse(quotedProductChat.stdout).contract.verification_focus.commands_to_verify, [
      'node -c commands/mission.js',
      "node --check test/mission-status.test.js --test-name-pattern 'mission report'",
      'git status --porcelain',
    ]);

    const optionBeforeFileTask = runCli(['task', 'new', 'Quoted option-before-file verifier', '--json'], { cwd: dir, env });
    assert.equal(optionBeforeFileTask.status, 0, optionBeforeFileTask.stderr);
    const optionBeforeFileRef = JSON.parse(optionBeforeFileTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', optionBeforeFileRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const optionBeforeFileReady = runCli([
      'task', 'ready', optionBeforeFileRef,
      '--as', 'codex',
      '--proof', "Receipt saved at atris/runs/proof.json. Product proof: the review handoff preserves the full verifier command, including node --check --test-name-pattern with quoted test names containing 'and'. Checks: node --check test/mission-xp.test.js; node --check --test-name-pattern 'mission run blocks Codex-goal work until native goal ack|mission goal-loop attaches task spine before due mission work|mission goal-loop runs due mission work once and refreshes final state' test/mission-status.test.js; git status --porcelain; atris clean --dry-run --json; atris brain compile --root . --verify.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(optionBeforeFileReady.status, 0, optionBeforeFileReady.stderr);
    const optionBeforeFilePayload = JSON.parse(optionBeforeFileReady.stdout);
    assert.deepEqual(optionBeforeFilePayload.handoff.verification_focus.commands_to_verify, [
      'node --check test/mission-xp.test.js',
      "node --check --test-name-pattern 'mission run blocks Codex-goal work until native goal ack|mission goal-loop attaches task spine before due mission work|mission goal-loop runs due mission work once and refreshes final state' test/mission-status.test.js",
      'git status --porcelain',
      'atris clean --dry-run --json',
      'atris brain compile --root . --verify',
    ]);

    const noteTailTask = runCli(['task', 'new', 'Trim note tail from verifier command', '--json'], { cwd: dir, env });
    assert.equal(noteTailTask.status, 0, noteTailTask.stderr);
    const noteTailRef = JSON.parse(noteTailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', noteTailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const noteTailReady = runCli([
      'task', 'ready', noteTailRef,
      '--as', 'codex',
      '--proof', 'Receipt saved at atris/runs/proof.json. Checks: atris brain compile --root . --verify. Note: full typecheck still has unrelated failures queued for later work.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(noteTailReady.status, 0, noteTailReady.stderr);
    assert.deepEqual(JSON.parse(noteTailReady.stdout).handoff.verification_focus.commands_to_verify, [
      'atris brain compile --root . --verify',
    ]);

    const withPassingTask = runCli(['task', 'new', 'Trim with passing test tail', '--json'], { cwd: dir, env });
    assert.equal(withPassingTask.status, 0, withPassingTask.stderr);
    const withPassingRef = JSON.parse(withPassingTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', withPassingRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const withPassingReady = runCli([
      'task', 'ready', withPassingRef,
      '--as', 'codex',
      '--proof', "Checks passed: node --check test/commands.test.js --test-name-pattern 'task review-chat extracts only proof-derived verifier commands' with 380 passing tests; git status --porcelain.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(withPassingReady.status, 0, withPassingReady.stderr);
    const withPassingPayload = JSON.parse(withPassingReady.stdout);
    assert.doesNotMatch(withPassingPayload.task.review.landing.tested, /with 380 passing tests/);
    assert.equal(withPassingPayload.task.review.landing.checked, 'I ran the verifier named in the proof.');
    const withPassingChat = runCli(['task', 'review-chat', withPassingRef, '--json'], { cwd: dir, env });
    assert.equal(withPassingChat.status, 0, withPassingChat.stderr);
    assert.deepEqual(JSON.parse(withPassingChat.stdout).contract.verification_focus.commands_to_verify, [
      "node --check test/commands.test.js --test-name-pattern 'task review-chat extracts only proof-derived verifier commands'",
      'git status --porcelain',
    ]);

    const receiptCheckedTask = runCli(['task', 'new', 'Receipt-specific checked landing', '--json'], { cwd: dir, env });
    assert.equal(receiptCheckedTask.status, 0, receiptCheckedTask.stderr);
    const receiptCheckedRef = JSON.parse(receiptCheckedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', receiptCheckedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const receiptCheckedReady = runCli([
      'task', 'ready', receiptCheckedRef,
      '--as', 'codex',
      '--proof', 'Second-pass review: receipt atris/runs/mission-example-2026-06-30T00-00-00-000Z.json verifier_result.passed=true.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(receiptCheckedReady.status, 0, receiptCheckedReady.stderr);
    const receiptCheckedPayload = JSON.parse(receiptCheckedReady.stdout);
    assert.equal(receiptCheckedPayload.task.review.landing.checked, 'I inspected the passing receipt named in the proof.');

    const outputCheckedTask = runCli(['task', 'new', 'Verifier output checked landing', '--json'], { cwd: dir, env });
    assert.equal(outputCheckedTask.status, 0, outputCheckedTask.stderr);
    const outputCheckedRef = JSON.parse(outputCheckedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', outputCheckedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const outputCheckedReady = runCli([
      'task', 'ready', outputCheckedRef,
      '--as', 'codex',
      '--proof', 'node scripts/verify-mission-product-wedge.js printed MISSION PRODUCT WEDGE VERIFIED.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(outputCheckedReady.status, 0, outputCheckedReady.stderr);
    assert.equal(JSON.parse(outputCheckedReady.stdout).task.review.landing.checked, 'I checked the verifier output named in the proof.');

    const passesCheckedTask = runCli(['task', 'new', 'Passes checked landing', '--json'], { cwd: dir, env });
    assert.equal(passesCheckedTask.status, 0, passesCheckedTask.stderr);
    const passesCheckedRef = JSON.parse(passesCheckedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', passesCheckedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const passesCheckedReady = runCli([
      'task', 'ready', passesCheckedRef,
      '--as', 'codex',
      '--proof', 'node scripts/verify-mission-artifact-timeline.js passes.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(passesCheckedReady.status, 0, passesCheckedReady.stderr);
    assert.equal(JSON.parse(passesCheckedReady.stdout).task.review.landing.checked, 'I ran the verifier named in the proof.');

    const proseCheckedTask = runCli(['task', 'new', 'Prose-only proof landing', '--json'], { cwd: dir, env });
    assert.equal(proseCheckedTask.status, 0, proseCheckedTask.stderr);
    const proseCheckedRef = JSON.parse(proseCheckedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', proseCheckedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const proseCheckedReady = runCli([
      'task', 'ready', proseCheckedRef,
      '--as', 'codex',
      '--proof', 'Agent review: help output renders, clean dry-run dropped stale pages, the help-focused test slice passed 379/379, and diff cleanliness passed.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(proseCheckedReady.status, 0, proseCheckedReady.stderr);
    assert.equal(JSON.parse(proseCheckedReady.stdout).task.review.landing.tested, 'I checked: help output, clean dry-run, passing tests, and 1 more check.');

    const rewardTailTask = runCli(['task', 'new', 'Trim human gate tail', '--json'], { cwd: dir, env });
    assert.equal(rewardTailTask.status, 0, rewardTailTask.stderr);
    const rewardTailRef = JSON.parse(rewardTailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', rewardTailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const rewardTailReady = runCli([
      'task', 'ready', rewardTailRef,
      '--as', 'codex',
      '--proof', 'Receipt saved at atris/runs/proof.json. node --check test/commands.test.js. Reward remains 0; no human accept or XP.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(rewardTailReady.status, 0, rewardTailReady.stderr);
    const rewardTailChat = runCli(['task', 'review-chat', rewardTailRef, '--json'], { cwd: dir, env });
    assert.equal(rewardTailChat.status, 0, rewardTailChat.stderr);
    assert.deepEqual(JSON.parse(rewardTailChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/commands.test.js',
    ]);

    const humanAcceptTask = runCli(['task', 'new', 'Reject human accept proof prose', '--json'], { cwd: dir, env });
    assert.equal(humanAcceptTask.status, 0, humanAcceptTask.stderr);
    const humanAcceptRef = JSON.parse(humanAcceptTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', humanAcceptRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const humanAcceptReady = runCli([
      'task', 'ready', humanAcceptRef,
      '--as', 'codex',
      '--proof', 'node --check commands/task.js passed. Do not run atris task accept OBL-1; no human accept or XP.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanAcceptReady.status, 0, humanAcceptReady.stderr);
    const humanAcceptChat = runCli(['task', 'review-chat', humanAcceptRef, '--json'], { cwd: dir, env });
    assert.equal(humanAcceptChat.status, 0, humanAcceptChat.stderr);
    assert.deepEqual(JSON.parse(humanAcceptChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
    ]);

    const longFiles = Array.from({ length: 10 }, (_, index) => `test/long-${index}.test.js`).join(' ');
    const longCommand = `node --check ${longFiles}`;
    assert.ok(longCommand.length > 180);
    const longCommandTask = runCli(['task', 'new', 'Preserve long verifier command', '--json'], { cwd: dir, env });
    assert.equal(longCommandTask.status, 0, longCommandTask.stderr);
    const longCommandRef = JSON.parse(longCommandTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', longCommandRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const longCommandReady = runCli([
      'task', 'ready', longCommandRef,
      '--as', 'codex',
      '--proof', `${longCommand} passed`,
      '--json',
    ], { cwd: dir, env });
    assert.equal(longCommandReady.status, 0, longCommandReady.stderr);
    const longCommandChat = runCli(['task', 'review-chat', longCommandRef, '--json'], { cwd: dir, env });
    assert.equal(longCommandChat.status, 0, longCommandChat.stderr);
    assert.deepEqual(JSON.parse(longCommandChat.stdout).contract.verification_focus.commands_to_verify, [
      longCommand,
    ]);

    const jsonFileTask = runCli(['task', 'new', 'JSON named verifier file', '--json'], { cwd: dir, env });
    assert.equal(jsonFileTask.status, 0, jsonFileTask.stderr);
    const jsonFileRef = JSON.parse(jsonFileTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', jsonFileRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const jsonFileReady = runCli([
      'task', 'ready', jsonFileRef,
      '--as', 'codex',
      '--proof', '`node --check test/json-output.test.js` passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(jsonFileReady.status, 0, jsonFileReady.stderr);
    const jsonFileChat = runCli(['task', 'review-chat', jsonFileRef, '--json'], { cwd: dir, env });
    assert.equal(jsonFileChat.status, 0, jsonFileChat.stderr);
    assert.deepEqual(JSON.parse(jsonFileChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check test/json-output.test.js',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next names accept for uncertified review and leaves open work unclaimed', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewAdd = runCli(['task', 'add', 'Needs second review before continuing', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(reviewAdd.status, 0, reviewAdd.stderr);
    const reviewRef = JSON.parse(reviewAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', reviewRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', reviewRef, '--proof', 'first pass validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const openAdd = runCli(['task', 'add', 'Open work must wait', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(openAdd.status, 0, openAdd.stderr);
    const openPayload = JSON.parse(openAdd.stdout);

    const next = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'accept');
    assert.equal(payload.command, `atris task accept ${reviewRef}`);
    assert.equal(payload.task_id, JSON.parse(reviewAdd.stdout).task.id);

    const openShow = runCli(['task', 'show', openPayload.task.display_id, '--json'], { cwd: dir, env });
    assert.equal(openShow.status, 0, openShow.stderr);
    assert.equal(JSON.parse(openShow.stdout).status, 'open');

    const reviewShow = runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env });
    assert.equal(reviewShow.status, 0, reviewShow.stderr);
    assert.equal(JSON.parse(reviewShow.stdout).status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next surfaces review debt when no open work exists', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewAdd = runCli(['task', 'add', 'Needs second review before continuing', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(reviewAdd.status, 0, reviewAdd.stderr);
    const reviewRef = JSON.parse(reviewAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', reviewRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', reviewRef, '--proof', 'first pass validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const next = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'accept');
    assert.equal(payload.command, `atris task accept ${reviewRef}`);
    assert.equal(payload.task_id, JSON.parse(reviewAdd.stdout).task.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next surfaces Endgame fallback for human-only certified review', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex-executor' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only, not overnight outages',
      '',
      '## Backlog',
      '',
      '(empty)',
      '',
    ].join('\n'), 'utf8');

    const created = runCli(['task', 'new', 'Certified checkpoint', '--tag', 'runner', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'node --check test/commands.test.js passed', '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during certification',
    ], { cwd: dir, env }).status, 0);

    const next = runCli(['task', 'next', '--as', 'codex-executor', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'accept');
    assert.equal(payload.command, `atris task accept ${ref}`);
    assert.equal(payload.task.display_id, ref);
    assert.doesNotMatch(JSON.stringify(payload), /create_bounded_endgame_task|task_seed/);

    const text = runCli(['task', 'next', '--as', 'codex-executor'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`^next: atris task accept ${ref}$`, 'm'));
    assert.doesNotMatch(text.stdout, /Create the next bounded task|Create: atris task new|Claim: atris task claim/);
    assert.doesNotMatch(text.stdout, /atris task step /);

    const createNext = runCli(['task', 'next', '--as', 'codex-executor', '--create-next', '--json'], { cwd: dir, env });
    assert.equal(createNext.status, 0, createNext.stderr);
    const createdPayload = JSON.parse(createNext.stdout);
    assert.equal(createdPayload.action, 'created_next');
    assert.equal(createdPayload.task.status, 'claimed');
    assert.equal(createdPayload.task.claimed_by, 'codex-executor');
    assert.equal(createdPayload.task.tag, 'runner');
    assert.match(createdPayload.task.title, /runner-agnostic heartbeat gap/);
    assert.equal(createdPayload.review_task.display_id, ref);

    const after = runCli(['task', 'next', '--as', 'codex-executor', '--json'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.action, 'accept');
    assert.equal(afterPayload.command, `atris task accept ${ref}`);
    assert.equal(afterPayload.task.display_id, ref);

    const show = runCli(['task', 'show', createdPayload.task.display_id, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    assert.match(shown.messages[0].content, /Goal: Find and close one remaining runner-agnostic heartbeat gap/);
    assert.match(shown.messages[0].content, /Check: node --test test\/autopilot-runner-model\.test\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next scoped by tag does not surface unrelated Endgame fallback', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'onboarding' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only, not overnight outages',
      '',
      '## Backlog',
      '',
      '(empty)',
      '',
    ].join('\n'), 'utf8');

    const created = runCli(['task', 'new', 'Golden path certified checkpoint', '--tag', 'golden-path', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'onboarding'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'node --check test/commands.test.js passed', '--as', 'onboarding'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during certification',
    ], { cwd: dir, env }).status, 0);

    const scopedNext = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(scopedNext.status, 0, scopedNext.stderr);
    const payload = JSON.parse(scopedNext.stdout);
    assert.equal(payload.action, 'accept');
    assert.equal(payload.command, `atris task accept ${ref}`);
    assert.equal(payload.scope.tag, 'golden-path');
    assert.equal(payload.task.display_id, ref);
    assert.equal(payload.task.tag, 'golden-path');

    const scopedText = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding'], { cwd: dir, env });
    assert.equal(scopedText.status, 0, scopedText.stderr);
    assert.match(scopedText.stdout, new RegExp(`^next: atris task accept ${ref}$`, 'm'));
    assert.doesNotMatch(scopedText.stdout, /No open tasks for tag=golden-path/);
    assert.doesNotMatch(scopedText.stdout, /Create the next bounded task/);
    assert.doesNotMatch(scopedText.stdout, /runner swaps should be config-only/);
    assert.doesNotMatch(scopedText.stdout, /Create: atris task new/);

    const scopedCreate = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding', '--create-next', '--json'], { cwd: dir, env });
    assert.notEqual(scopedCreate.status, 0);
    const createPayload = JSON.parse(scopedCreate.stdout);
    assert.equal(createPayload.reason, 'no_create_next_seed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next does not repeat an Endgame seed that already exists', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex-executor' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only, not overnight outages',
      '',
      '## Backlog',
      '',
      '(empty)',
      '',
    ].join('\n'), 'utf8');

    const existing = runCli([
      'task', 'new', 'Audit and close next runner-agnostic heartbeat gap',
      '--tag', 'runner',
      '--json',
    ], { cwd: dir, env });
    assert.equal(existing.status, 0, existing.stderr);
    const existingTask = JSON.parse(existing.stdout).task;
    assert.equal(runCli(['task', 'claim', existingTask.display_id, '--as', 'auto-improver'], { cwd: dir, env }).status, 0);

    const created = runCli(['task', 'new', 'Certified checkpoint', '--tag', 'runner', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'node --check test/commands.test.js passed', '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during certification',
    ], { cwd: dir, env }).status, 0);

    const next = runCli(['task', 'next', '--as', 'codex-executor', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'accept');
    assert.equal(payload.command, `atris task accept ${ref}`);
    assert.equal(payload.task.display_id, ref);

    const text = runCli(['task', 'next', '--as', 'codex-executor'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`^next: atris task accept ${ref}$`, 'm'));
    assert.doesNotMatch(text.stdout, /Create the next bounded task/);
    assert.doesNotMatch(text.stdout, /Create: atris task new/);

    const duplicate = runCli(['task', 'next', '--as', 'codex-executor', '--create-next', '--json'], { cwd: dir, env });
    assert.notEqual(duplicate.status, 0);
    const duplicatePayload = JSON.parse(duplicate.stdout);
    assert.equal(duplicatePayload.reason, 'no_create_next_seed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review summary does not treat incidental XP wording as AgentXP work', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Clean stale claimed task queue after XP review',
      '--tag', 'hygiene',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'closed stale duplicate scheduler claims; validation passed reward 0',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.review.summary, 'clean stale claimed task queue after XP review: review the completed result, then approve or ask for rework.');
    assert.deepEqual(readyPayload.task.review.landing, {
      happened: 'Operators can now understand completed test work faster.',
      reason: 'the result is named.',
      checked: 'I ran the validation check.',
      tested: 'I attached the proof below.',
      decision: 'Needs one more check; ask for rework if the receipt misses the point.',
    });
    assert.equal(readyPayload.task.review.result.changed, 'Operators can now understand completed test work faster.');
    assert.equal(readyPayload.task.review.result.checked, 'I ran the validation check.');
    assert.equal(readyPayload.task.review.proof, 'closed stale duplicate scheduler claims; validation passed reward 0');

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /Result:/);
    assert.match(readyShow.stdout, /What happened: Operators can now understand completed test work faster\./);
    assert.match(readyShow.stdout, /How I checked: I ran the validation check\./);
    assert.match(readyShow.stdout, /What I tested: I attached the proof below\./);
    assert.match(readyShow.stdout, /Why it matters: the result is named\./);
    assert.match(readyShow.stdout, /Decision: Needs one more check; ask for rework if the receipt misses the point\./);
    assert.match(readyShow.stdout, /Short version: clean stale claimed task queue after XP review: review the completed result, then approve or ask for rework\./);
    assert.match(readyShow.stdout, /Details: closed stale duplicate scheduler claims; validation passed reward 0/);
    assert.doesNotMatch(readyShow.stdout, /AgentXP a real local scoreboard/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready default landing describes completed work for unmapped titles', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Explore review landing output',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'node --check test/commands.test.js passed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.review.landing.happened, 'Operators can now understand completed test work faster.');
    assert.equal(readyPayload.task.review.landing.reason, 'the result is named.');
    assert.equal(readyPayload.task.review.result.changed, 'Operators can now understand completed test work faster.');

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /What happened: Operators can now understand completed test work faster\./);
    assert.match(readyShow.stdout, /Why it matters: the result is named\./);
    assert.doesNotMatch(readyShow.stdout, /Explore review landing output is ready to review/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready and finish accept landing capability sentences', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const readyAdd = runCli([
      'task', 'add', 'Add digest landing sentence',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(readyAdd.status, 0, readyAdd.stderr);
    const readyRef = JSON.parse(readyAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', readyRef, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const readySentence = 'Users can now trust the review queue to explain the result without opening the task.';
    const ready = runCli([
      'task', 'ready', readyRef,
      '--proof', 'node --check test/autoland.test.js passed',
      '--landing', readySentence,
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stderr, '');
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.landing_advisory, null);
    assert.equal(readyPayload.task.review.landing.happened, readySentence);

    const missingAdd = runCli([
      'task', 'add', 'Warn when landing is missing',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(missingAdd.status, 0, missingAdd.stderr);
    const missingRef = JSON.parse(missingAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', missingRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const missingReady = runCli([
      'task', 'ready', missingRef,
      '--proof', 'node --check test/autoland.test.js passed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(missingReady.status, 0, missingReady.stderr);
    assert.match(missingReady.stderr, /new teammate would get/);
    assert.match(JSON.parse(missingReady.stdout).landing_advisory, /new teammate would get/);

    const finishAdd = runCli([
      'task', 'add', 'Finish digest landing sentence',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finishAdd.status, 0, finishAdd.stderr);
    const finishRef = JSON.parse(finishAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', finishRef, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const finishSentence = 'Users can now trust the landed digest to explain the capability without opening the task.';
    const finish = runCli([
      'task', 'finish', finishRef,
      '--proof', 'node --test test/autoland.test.js passed',
      '--landing', finishSentence,
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finish.status, 0, finish.stderr);
    assert.equal(finish.stderr, '');
    const finishPayload = JSON.parse(finish.stdout);
    assert.equal(finishPayload.landing_advisory, null);
    assert.equal(finishPayload.task.review.landing.happened, finishSentence);

    const finishProjection = JSON.parse(fs.readFileSync(finishPayload.projection_path, 'utf8'));
    const projectedFinishTask = finishProjection.tasks.find(task => task.id === finishPayload.task_id);
    const accepted = acceptedInLastDay([projectedFinishTask], Date.now());
    assert.equal(accepted.human.length, 1);
    assert.equal(accepted.human[0].happened, finishSentence);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready rejects an explicit landing sentence a day-one PM cannot act on before review', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const added = runCli([
      'task', 'add', 'Make the team stream actionable for a new operator',
      '--tag', 'language',
      '--json',
    ], { cwd: dir, env });
    assert.equal(added.status, 0, added.stderr);
    const ref = JSON.parse(added.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const brokenGrammar = runCli([
      'task', 'ready', ref,
      '--proof', 'node --check test/commands.test.js passed',
      '--result', 'Reviewers can now inspect saved artifact proof without opening machine logs, preventing slow approval checks.',
      '--landing', 'Read the artifact check as exists and not empty, preventing shell syntax from obscuring the proof.',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(brokenGrammar.status, 2, brokenGrammar.stderr || brokenGrammar.stdout);
    assert.match(brokenGrammar.stderr, /landing needs one plain sentence saying what someone can do now and why it matters/);

    const weak = runCli([
      'task', 'ready', ref,
      '--proof', 'node --check test/commands.test.js passed',
      '--result', 'Operators can now see one worker without searching the whole team stream, saving time during handoffs.',
      '--landing', 'Run atris stream with an agent filter for one worker.',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(weak.status, 2, weak.stderr || weak.stdout);
    assert.match(weak.stderr, /landing needs one plain sentence saying what someone can do now and why it matters/);

    const after = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).status, 'claimed', 'weak landing must not move the task to review');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept automatically projects accepted proof into durable local XP ledger', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Ship local AgentXP projection',
      '--tag', 'agent-xp',
      '--goal-id', 'goal-agent-xp',
      '--goal-objective', 'Make XP collectible anywhere',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'xp projection test passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '2', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    const accepted = JSON.parse(accept.stdout);
    const projection = accepted.xp_projection;
    assert.equal(projection.schema, 'atris.career_xp_projection.v1');
    assert.equal(projection.collected_receipts, 1);
    assert.equal(projection.total_xp, 2);
    assert.equal(projection.today_xp, 2);
    assert.equal(projection.level, 1);
    assert.equal(projection.next_level_progress.current_xp, 2);
    assert.equal(projection.next_level_progress.required_xp, 1000);
    assert.equal(projection.next_level_progress.remaining_xp, 998);
    assert.equal(projection.receipts_count, 1);
    assert.equal(projection.latest_accepted_proof.source_task_id, accepted.task_id);
    assert.equal(projection.latest_accepted_proof.proof, 'xp projection test passed');
    assert.equal(projection.latest_accepted_proof.xp, 2);
    assert.equal(projection.latest_accepted_proof.goal.goal_id, 'goal-agent-xp');
    assert.equal(projection.integrity.status, 'verified');
    assert.equal(projection.integrity.local_trust, 'tamper_evident_not_attested');
    assert.equal(projection.leaderboard_eligible, false);
    assert.ok(projection.integrity.head_hash);
    assert.ok(projection.integrity.cursor.bytes_read > 0);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const projectionPath = path.join(dir, '.atris', 'state', 'career_xp.projection.json');
    const cursorPath = path.join(dir, '.atris', 'state', 'career_xp.cursor.json');
    assert.ok(fs.existsSync(receiptsPath));
    assert.ok(fs.existsSync(projectionPath));
    assert.ok(fs.existsSync(cursorPath));
    const receipts = fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].receipt_id, `task_review:${accepted.episode.episode_id}`);
    assert.equal(receipts[0].chain_version, 'atris.career_xp_receipt_chain.v1');
    assert.ok(receipts[0].source_episode_hash);
    assert.ok(receipts[0].receipt_hash);

    const collect = runCli(['xp', 'collect', '--json'], { cwd: dir, env });
    assert.equal(collect.status, 0, collect.stderr);
    assert.equal(JSON.parse(collect.stdout).collected_receipts, 0);
    assert.equal(fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).length, 1);

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).latest_accepted_proof.proof, 'xp projection test passed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept rejects non-positive rewards before marking done', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Reject zero reward accept', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accept validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const accept = runCli(['task', 'accept', ref, '--reward', '0', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 2);
    assert.match(accept.stderr, /reward must be a positive number/);

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    assert.equal(task.status, 'review');
    assert.equal(task.metadata.approval_status, 'pending');
  } finally {
    cleanupTempDir(dir);
  }
});
