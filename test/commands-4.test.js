// Part 4 of 8 of the commands suite, split so node --test runs them in parallel.
// Shared imports and fixture helpers live in test/helpers/commands-fixtures.js.
const test = require('node:test');
const {
  assert,
  fs,
  path,
  taskStore,
  FIXTURE_RESULT_SENTENCE,
  makeTempDir,
  cleanupTempDir,
  runCli,
  hasNodeSqlite,
} = require('./helpers/commands-fixtures');

test('task capabilities-check reports contract drift without mutating task truth', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'add', 'Check capability conformance without mutating tasks', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    const before = runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(before.status, 0, before.stderr);
    const beforePayload = JSON.parse(before.stdout);

    const report = runCli(['task', 'capabilities-check', '--json'], { cwd: dir, env });
    assert.equal(report.status, 0, report.stderr);
    const payload = JSON.parse(report.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'capabilities_check');
    assert.equal(payload.schema, 'atris.task_capabilities_check.v1');
    assert.equal(payload.capabilities.schema, 'atris.task_capabilities.v1');
    assert.equal(payload.summary.failed, 0);
    assert.equal(payload.summary.passed, payload.summary.total);
    assert.ok(payload.checks.some(check => check.name === 'current_capabilities_match_standalone' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'queue_capabilities_match_standalone' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'current_step_never_human_accepts' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'current_step_declares_identity_output_fields' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'current_and_queue_declare_identity_output_fields' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'review_lane_drain_declares_identity_output_fields' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'review_lane_act_declares_identity_output_fields' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'capabilities_check_surface_declared' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'review_lane_drain_surface_declared' && check.ok));
    const drainBehaviorCheck = payload.checks.find(check => check.name === 'review_lane_drain_behavior_conforms');
    assert.equal(drainBehaviorCheck.ok, true);
    assert.equal(drainBehaviorCheck.detail.prefers_review_chat, true);
    assert.equal(drainBehaviorCheck.detail.uses_continue_work_from_review_state_actions, true);
    assert.equal(drainBehaviorCheck.detail.selected_human_accept_waiting_is_non_executable, true);
    assert.equal(drainBehaviorCheck.detail.capability_drift_blocks_execution, true);
    assert.equal(drainBehaviorCheck.detail.skips_continue_work_with_existing_follow_up_child, true);
    assert.ok(payload.checks.some(check => check.name === 'review_lane_act_surface_declared' && check.ok));
    const actBehaviorCheck = payload.checks.find(check => check.name === 'review_lane_act_behavior_conforms');
    assert.equal(actBehaviorCheck.ok, true);
    assert.equal(actBehaviorCheck.detail.allows_review_chat, true);
    assert.equal(actBehaviorCheck.detail.allows_continue_work, true);
    assert.equal(actBehaviorCheck.detail.blocks_human_accept_waiting_even_if_marked_safe, true);
    assert.equal(actBehaviorCheck.detail.blocks_capability_drift, true);
    assert.ok(payload.checks.some(check => check.name === 'review_lane_loop_surface_declared' && check.ok));
    const loopBehaviorCheck = payload.checks.find(check => check.name === 'review_lane_loop_behavior_conforms');
    assert.equal(loopBehaviorCheck.ok, true);
    assert.equal(loopBehaviorCheck.detail.dry_run_stops_without_mutation, true);
    assert.equal(loopBehaviorCheck.detail.human_accept_waiting_stops_without_execution, true);
    assert.equal(loopBehaviorCheck.detail.pending_review_chat_stops_without_execution, true);
    assert.equal(loopBehaviorCheck.detail.no_action_stops_without_execution, true);
    assert.equal(loopBehaviorCheck.detail.repeat_selection_stops_before_duplicate_execution, true);
    assert.equal(loopBehaviorCheck.detail.capability_drift_blocks_loop, true);
    assert.equal(loopBehaviorCheck.detail.max_steps_are_bounded, true);
    assert.ok(payload.checks.some(check => check.name === 'review_lane_run_surface_declared' && check.ok));
    const runBehaviorCheck = payload.checks.find(check => check.name === 'review_lane_run_behavior_conforms');
    assert.equal(runBehaviorCheck.ok, true);
    assert.equal(runBehaviorCheck.detail.dry_run_stops_without_receipt, true);
    assert.equal(runBehaviorCheck.detail.human_accept_waiting_stops_without_execution, true);
    assert.equal(runBehaviorCheck.detail.pending_review_chat_stops_without_execution, true);
    assert.equal(runBehaviorCheck.detail.no_action_stops_without_execution, true);
    assert.equal(runBehaviorCheck.detail.repeat_selection_stops_before_duplicate_execution, true);
    assert.equal(runBehaviorCheck.detail.capability_drift_blocks_run, true);
    assert.equal(runBehaviorCheck.detail.max_runs_are_bounded, true);
    assert.equal(payload.safety.mutates_task_db, false);
    assert.equal(payload.safety.writes_projection, true);
    assert.equal(payload.safety.human_accept, false);
    assert.ok(payload.projection_path.endsWith(path.join('.atris', 'state', 'tasks.projection.json')));

    const after = runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.current_version, beforePayload.current_version);
    assert.equal(afterPayload.latest_event_type, beforePayload.latest_event_type);
    assert.equal(afterPayload.status, beforePayload.status);

    const textReport = runCli(['task', 'caps-check'], { cwd: dir, env });
    assert.equal(textReport.status, 0, textReport.stderr);
    assert.match(textReport.stdout, /TASK CAPABILITIES CHECK ok/);
    assert.match(textReport.stdout, /ok current_capabilities_match_standalone/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-drain picks safe agent action without mutating human accept rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const continueCreated = runCli([
      'task', 'new', 'Certified drain task with executable continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review lane drain continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review lane drain continuation',
      '--next', 'Add the next safe review drain follow-up',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Certified drain task waiting for human accept',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingTask = JSON.parse(waitingCreated.stdout).task;
    const waitingRef = waitingTask.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review lane drain human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review lane drain human gate',
    ], { cwd: dir, env }).status, 0);
    const beforeWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);

    const drain = runCli(['task', 'review-lane-drain', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(drain.status, 0, drain.stderr);
    const payload = JSON.parse(drain.stdout);
    const continueCommand = `atris task continue-work ${continueRef} --as codex --json`;
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'review_lane_drain');
    assert.equal(payload.schema, 'atris.task_review_lane_drain.v1');
    assert.equal(payload.selected_task_id, continueTask.id);
    assert.equal(payload.selected_ref, continueRef);
    assert.equal(payload.selected_next_key, 'continue_work');
    assert.equal(payload.capabilities_check.ok, true);
    assert.equal(payload.capabilities_check.summary.failed, 0);
    assert.ok(payload.capabilities_check.checks.some(check => check.name === 'review_lane_drain_surface_declared' && check.ok));
    assert.ok(payload.capabilities_check.checks.some(check => check.name === 'review_lane_drain_behavior_conforms' && check.ok));
    assert.equal(payload.review_state_counts.continue_work, 1);
    assert.equal(payload.review_state_counts.human_accept_waiting, 1);
    assert.equal(payload.review_state_actions.continue_work.command, continueCommand);
    assert.equal(payload.review_state_actions.human_accept_waiting.command, null);
    assert.equal(payload.review_state_actions.human_accept_waiting.api, null);
    assert.equal(payload.drain.next_action, 'continue_work');
    assert.equal(payload.drain.review_state, 'continue-work');
    assert.equal(payload.drain.safe_for_agent, true);
    assert.equal(payload.drain.command, continueCommand);
    assert.deepEqual(payload.drain.api, { method: 'POST', path: `/api/tasks/${continueTask.id}/continue-work` });
    assert.equal(payload.drain.human_accept_waiting.command, null);
    assert.equal(payload.drain.human_accept_waiting.api, null);
    assert.equal(payload.safety.mutates_task_db, false);
    assert.equal(payload.safety.writes_projection, true);
    assert.equal(payload.safety.human_accept, false);
    assert.equal(payload.safety.safe_to_execute_next_action, true);

    const afterWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterWaiting.current_version, beforeWaiting.current_version);
    assert.equal(afterWaiting.latest_event_type, beforeWaiting.latest_event_type);
    assert.equal(afterWaiting.status, beforeWaiting.status);

    const humanOnlyCreated = runCli([
      'task', 'new', 'Only human can accept this certified task',
      '--tag', 'task',
      '--goal-id', 'OBL-929',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before human-only review lane drain',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during human-only review lane drain',
    ], { cwd: dir, env }).status, 0);
    const humanOnlyDrain = runCli(['task', 'review-lane-drain', '--goal-id', 'OBL-929', '--json'], { cwd: dir, env });
    assert.equal(humanOnlyDrain.status, 0, humanOnlyDrain.stderr);
    const humanOnlyPayload = JSON.parse(humanOnlyDrain.stdout);
    assert.equal(humanOnlyPayload.drain.next_action, 'human_accept_waiting');
    assert.equal(humanOnlyPayload.drain.safe_for_agent, false);
    assert.equal(humanOnlyPayload.drain.command, null);
    assert.equal(humanOnlyPayload.drain.api, null);
    assert.equal(humanOnlyPayload.drain.reason, 'human_accept_waiting_is_human_only');
    assert.equal(humanOnlyPayload.safety.safe_to_execute_next_action, false);

    const textDrain = runCli(['task', 'review-drain', '--goal-id', 'OBL-928'], { cwd: dir, env });
    assert.equal(textDrain.status, 0, textDrain.stderr);
    assert.match(textDrain.stdout, /TASK REVIEW LANE DRAIN ok/);
    assert.match(textDrain.stdout, /next: continue_work/);
    assert.match(textDrain.stdout, new RegExp(`command: atris task continue-work ${continueRef} --as codex --json`));
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-act executes safe drain actions and refuses human accept rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewCreated = runCli([
      'task', 'new', 'Review lane act starts verification chat',
      '--tag', 'task',
      '--goal-id', 'OBL-931',
      '--json',
    ], { cwd: dir, env });
    assert.equal(reviewCreated.status, 0, reviewCreated.stderr);
    const reviewTask = JSON.parse(reviewCreated.stdout).task;
    const reviewRef = reviewTask.display_id;
    assert.equal(runCli([
      'task', 'ready', reviewRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act review chat',
    ], { cwd: dir, env }).status, 0);
    const beforeReviewChat = JSON.parse(runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env }).stdout);
    const reviewAct = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-931', '--json'], { cwd: dir, env });
    assert.equal(reviewAct.status, 0, reviewAct.stderr);
    const reviewPayload = JSON.parse(reviewAct.stdout);
    assert.equal(reviewPayload.ok, true);
    assert.equal(reviewPayload.action, 'review_lane_act');
    assert.equal(reviewPayload.selected_action, 'review_chat');
    assert.equal(reviewPayload.acted, true);
    assert.equal(reviewPayload.drain.next_action, 'review_chat');
    assert.equal(reviewPayload.decision.step_action, 'review_chat');
    assert.equal(reviewPayload.result.action, 'review_chat');
    assert.equal(reviewPayload.result.appended, true);
    assert.equal(reviewPayload.safety.human_accept, false);
    const afterReviewChat = JSON.parse(runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterReviewChat.current_version, beforeReviewChat.current_version + 1);
    assert.ok(afterReviewChat.messages.some(message => message.content.includes('TASK_REVIEW_CHAT')));

    const continueCreated = runCli([
      'task', 'new', 'Review lane act continues certified work',
      '--tag', 'task',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act continuation',
      '--next', 'Add the review lane act follow-up task',
    ], { cwd: dir, env }).status, 0);
    const beforeDryRun = JSON.parse(runCli(['task', 'show', continueRef, '--json'], { cwd: dir, env }).stdout);
    const dryRun = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-932', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.dry_run, true);
    assert.equal(dryPayload.acted, false);
    assert.equal(dryPayload.selected_task_id, continueTask.id);
    assert.equal(dryPayload.selected_ref, continueRef);
    assert.equal(dryPayload.selected_next_key, 'continue_work');
    assert.equal(dryPayload.decision.step_action, 'continue_work');
    assert.equal(dryPayload.safety.mutates_task_db, false);
    const afterDryRun = JSON.parse(runCli(['task', 'show', continueRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterDryRun.current_version, beforeDryRun.current_version);
    assert.deepEqual(afterDryRun.lineage.child_task_ids || [], beforeDryRun.lineage.child_task_ids || []);

    const continueAct = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-932', '--json'], { cwd: dir, env });
    assert.equal(continueAct.status, 0, continueAct.stderr);
    const continuePayload = JSON.parse(continueAct.stdout);
    assert.equal(continuePayload.ok, true);
    assert.equal(continuePayload.selected_action, 'continue_work');
    assert.equal(continuePayload.acted, true);
    assert.equal(continuePayload.drain.next_action, 'continue_work');
    assert.equal(continuePayload.result.action, 'continue_work');
    assert.equal(continuePayload.result.created, true);
    assert.ok(continuePayload.result.next_task_id);
    assert.equal(continuePayload.result.safety.human_accept, false);

    const humanOnlyCreated = runCli([
      'task', 'new', 'Review lane act must not accept human-only row',
      '--tag', 'task',
      '--goal-id', 'OBL-933',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act human gate',
    ], { cwd: dir, env }).status, 0);
    const blocked = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-933', '--json'], { cwd: dir, env });
    assert.notEqual(blocked.status, 0);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.acted, false);
    assert.equal(blockedPayload.reason, 'human_accept_waiting_is_human_only');
    assert.equal(blockedPayload.selected_ref, humanOnlyRef);
    assert.equal(blockedPayload.selected_next_key, 'human_accept_waiting');
    assert.equal(blockedPayload.drain.next_action, 'human_accept_waiting');
    assert.equal(blockedPayload.drain.command, null);
    assert.equal(blockedPayload.drain.api, null);
    assert.equal(blockedPayload.safety.human_accept, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-act executes only safe drain actions and supports dry-run', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const needsCreated = runCli([
      'task', 'new', 'Review lane act should start verification chat',
      '--tag', 'task',
      '--goal-id', 'OBL-940',
      '--json',
    ], { cwd: dir, env });
    assert.equal(needsCreated.status, 0, needsCreated.stderr);
    const needsTask = JSON.parse(needsCreated.stdout).task;
    const needsRef = needsTask.display_id;
    assert.equal(runCli([
      'task', 'ready', needsRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act chat',
    ], { cwd: dir, env }).status, 0);
    const beforeNeeds = JSON.parse(runCli(['task', 'show', needsRef, '--json'], { cwd: dir, env }).stdout);

    const dryReviewChat = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-940', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryReviewChat.status, 0, dryReviewChat.stderr);
    const dryReviewChatPayload = JSON.parse(dryReviewChat.stdout);
    assert.equal(dryReviewChatPayload.ok, true);
    assert.equal(dryReviewChatPayload.acted, false);
    assert.equal(dryReviewChatPayload.dry_run, true);
    assert.equal(dryReviewChatPayload.decision.step_action, 'review_chat');
    assert.equal(dryReviewChatPayload.safety.read_only, true);
    assert.equal(dryReviewChatPayload.safety.human_accept, false);
    const afterDryNeeds = JSON.parse(runCli(['task', 'show', needsRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterDryNeeds.current_version, beforeNeeds.current_version);

    const liveReviewChat = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-940', '--json'], { cwd: dir, env });
    assert.equal(liveReviewChat.status, 0, liveReviewChat.stderr);
    const liveReviewChatPayload = JSON.parse(liveReviewChat.stdout);
    assert.equal(liveReviewChatPayload.ok, true);
    assert.equal(liveReviewChatPayload.acted, true);
    assert.equal(liveReviewChatPayload.selected_action, 'review_chat');
    assert.equal(liveReviewChatPayload.result.action, 'review_chat');
    assert.equal(liveReviewChatPayload.result.appended, true);
    assert.equal(liveReviewChatPayload.safety.human_accept, false);
    const afterLiveNeeds = JSON.parse(runCli(['task', 'show', needsRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterLiveNeeds.current_version, beforeNeeds.current_version + 1);
    assert.equal(afterLiveNeeds.latest_event_type, 'message');

    const continueCreated = runCli([
      'task', 'new', 'Review lane act should continue certified task',
      '--tag', 'task',
      '--goal-id', 'OBL-941',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act continuation',
      '--next', 'Add a follow-up created by review lane act',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Review lane act should leave human accept alone',
      '--tag', 'task',
      '--goal-id', 'OBL-941',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingRef = JSON.parse(waitingCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act human gate',
    ], { cwd: dir, env }).status, 0);
    const beforeWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    const beforeContinue = JSON.parse(runCli(['task', 'show', continueRef, '--json'], { cwd: dir, env }).stdout);

    const dryContinue = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-941', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryContinue.status, 0, dryContinue.stderr);
    const dryContinuePayload = JSON.parse(dryContinue.stdout);
    assert.equal(dryContinuePayload.ok, true);
    assert.equal(dryContinuePayload.acted, false);
    assert.equal(dryContinuePayload.decision.step_action, 'continue_work');
    assert.equal(dryContinuePayload.safety.read_only, true);
    const afterDryContinue = JSON.parse(runCli(['task', 'show', continueRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterDryContinue.current_version, beforeContinue.current_version);

    const liveContinue = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-941', '--json'], { cwd: dir, env });
    assert.equal(liveContinue.status, 0, liveContinue.stderr);
    const liveContinuePayload = JSON.parse(liveContinue.stdout);
    assert.equal(liveContinuePayload.ok, true);
    assert.equal(liveContinuePayload.acted, true);
    assert.equal(liveContinuePayload.selected_action, 'continue_work');
    assert.equal(liveContinuePayload.result.action, 'continue_work');
    assert.equal(liveContinuePayload.result.parent_task_id, continueTask.id);
    assert.equal(liveContinuePayload.result.next_task.title, 'Add a follow-up created by review lane act');
    assert.equal(liveContinuePayload.safety.human_accept, false);
    const afterWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterWaiting.current_version, beforeWaiting.current_version);
    assert.equal(afterWaiting.latest_event_type, beforeWaiting.latest_event_type);

    const humanOnlyCreated = runCli([
      'task', 'new', 'Review lane act must not human accept',
      '--tag', 'task',
      '--goal-id', 'OBL-942',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act human only',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act human only',
    ], { cwd: dir, env }).status, 0);
    const beforeHumanOnly = JSON.parse(runCli(['task', 'show', humanOnlyRef, '--json'], { cwd: dir, env }).stdout);
    const blockedHumanOnly = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-942', '--json'], { cwd: dir, env });
    assert.equal(blockedHumanOnly.status, 1);
    const blockedPayload = JSON.parse(blockedHumanOnly.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.acted, false);
    assert.equal(blockedPayload.reason, 'human_accept_waiting_is_human_only');
    assert.equal(blockedPayload.safety.human_accept, false);
    assert.equal(blockedPayload.drain.command, null);
    assert.equal(blockedPayload.drain.api, null);
    const afterHumanOnly = JSON.parse(runCli(['task', 'show', humanOnlyRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterHumanOnly.current_version, beforeHumanOnly.current_version);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-loop runs bounded safe actions and stops before human accept', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewCreated = runCli([
      'task', 'new', 'Loop should start one review chat and stop on repeat',
      '--tag', 'task',
      '--goal-id', 'OBL-950',
      '--json',
    ], { cwd: dir, env });
    assert.equal(reviewCreated.status, 0, reviewCreated.stderr);
    const reviewTask = JSON.parse(reviewCreated.stdout).task;
    const reviewRef = reviewTask.display_id;
    assert.equal(runCli([
      'task', 'ready', reviewRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-loop chat',
    ], { cwd: dir, env }).status, 0);

    const dryLoop = runCli(['task', 'review-lane-loop', '--goal-id', 'OBL-950', '--max-steps', '3', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryLoop.status, 0, dryLoop.stderr);
    const dryPayload = JSON.parse(dryLoop.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.dry_run, true);
    assert.equal(dryPayload.acted_count, 0);
    assert.equal(dryPayload.stopped_reason, 'dry_run_preview');
    assert.equal(dryPayload.steps.length, 1);
    assert.equal(dryPayload.steps[0].decision.step_action, 'review_chat');
    assert.equal(dryPayload.safety.read_only, true);
    assert.equal(dryPayload.safety.human_accept, false);

    const beforeReview = JSON.parse(runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env }).stdout);
    const liveReviewLoop = runCli(['task', 'review-lane-loop', '--goal-id', 'OBL-950', '--max-steps', '3', '--json'], { cwd: dir, env });
    assert.equal(liveReviewLoop.status, 0, liveReviewLoop.stderr);
    const liveReviewPayload = JSON.parse(liveReviewLoop.stdout);
    assert.equal(liveReviewPayload.ok, true);
    assert.equal(liveReviewPayload.acted_count, 1);
    assert.equal(liveReviewPayload.steps[0].selected_action, 'review_chat');
    assert.equal(liveReviewPayload.steps[0].result.appended, true);
    assert.equal(liveReviewPayload.stopped_reason, 'no_review_lane_action');
    assert.equal(liveReviewPayload.safety.repeat_selection_guard, true);
    const afterReview = JSON.parse(runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterReview.current_version, beforeReview.current_version + 1);

    const continueCreated = runCli([
      'task', 'new', 'Loop should continue one certified task and stop on repeat',
      '--tag', 'task',
      '--goal-id', 'OBL-951',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-loop continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-loop continuation',
      '--next', 'Add a follow-up created by review lane loop',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Loop should leave human accept waiting alone',
      '--tag', 'task',
      '--goal-id', 'OBL-951',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingRef = JSON.parse(waitingCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-loop human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-loop human gate',
    ], { cwd: dir, env }).status, 0);
    const beforeWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);

    const liveContinueLoop = runCli(['task', 'review-lane-loop', '--goal-id', 'OBL-951', '--max-steps', '3', '--json'], { cwd: dir, env });
    assert.equal(liveContinueLoop.status, 0, liveContinueLoop.stderr);
    const liveContinuePayload = JSON.parse(liveContinueLoop.stdout);
    assert.equal(liveContinuePayload.ok, true);
    assert.equal(liveContinuePayload.acted_count, 1);
    assert.equal(liveContinuePayload.steps[0].selected_action, 'continue_work');
    assert.ok(liveContinuePayload.steps[0].result.next_task_id);
    assert.equal(liveContinuePayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(liveContinuePayload.final_drain.next_action, 'human_accept_waiting');
    assert.equal(liveContinuePayload.final_drain.command, null);
    assert.equal(liveContinuePayload.final_drain.api, null);
    assert.equal(liveContinuePayload.safety.human_accept, false);
    const afterWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterWaiting.current_version, beforeWaiting.current_version);

    const humanOnlyCreated = runCli([
      'task', 'new', 'Loop must stop on human-only review rows',
      '--tag', 'task',
      '--goal-id', 'OBL-952',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-loop human only',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-loop human only',
    ], { cwd: dir, env }).status, 0);
    const humanOnlyLoop = runCli(['task', 'review-lane-loop', '--goal-id', 'OBL-952', '--max-steps', '3', '--json'], { cwd: dir, env });
    assert.equal(humanOnlyLoop.status, 0, humanOnlyLoop.stderr);
    const humanOnlyPayload = JSON.parse(humanOnlyLoop.stdout);
    assert.equal(humanOnlyPayload.ok, true);
    assert.equal(humanOnlyPayload.acted_count, 0);
    assert.equal(humanOnlyPayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(humanOnlyPayload.final_drain.command, null);
    assert.equal(humanOnlyPayload.final_drain.api, null);
    assert.equal(humanOnlyPayload.safety.human_accept, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-run writes bounded receipts and stops before human accept', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const continueCreated = runCli([
      'task', 'new', 'Run should continue one certified task and write a receipt',
      '--tag', 'task',
      '--goal-id', 'OBL-953',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueRef = JSON.parse(continueCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-run continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-run continuation',
      '--next', 'Add a follow-up created by review lane run',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Run should leave human accept waiting alone',
      '--tag', 'task',
      '--goal-id', 'OBL-953',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingRef = JSON.parse(waitingCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-run human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-run human gate',
    ], { cwd: dir, env }).status, 0);

    const realDir = fs.realpathSync(dir);
    const receiptPath = path.join(realDir, '.atris', 'state', 'review-lane-runs.jsonl');
    const latestPath = path.join(realDir, '.atris', 'state', 'review-lane-run.latest.json');
    const dryRun = runCli([
      'task', 'review-lane-run',
      '--goal-id', 'OBL-953',
      '--max-runs', '2',
      '--max-steps', '1',
      '--dry-run',
      '--json',
    ], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.action, 'review_lane_run');
    assert.equal(dryPayload.dry_run, true);
    assert.equal(dryPayload.run_count, 1);
    assert.equal(dryPayload.total_acted_count, 0);
    assert.equal(dryPayload.stopped_reason, 'dry_run_preview');
    assert.equal(dryPayload.receipt_written, false);
    assert.equal(dryPayload.receipt_path, null);
    assert.equal(dryPayload.would_write_receipt_path, receiptPath);
    assert.equal(dryPayload.safety.human_accept, false);
    assert.equal(dryPayload.safety.writes_receipt, false);
    assert.equal(fs.existsSync(receiptPath), false);
    assert.equal(fs.existsSync(latestPath), false);

    const beforeWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    const liveRun = runCli([
      'task', 'review-lane-run',
      '--goal-id', 'OBL-953',
      '--max-runs', '2',
      '--max-steps', '1',
      '--json',
    ], { cwd: dir, env });
    assert.equal(liveRun.status, 0, liveRun.stderr);
    const livePayload = JSON.parse(liveRun.stdout);
    assert.equal(livePayload.ok, true);
    assert.equal(livePayload.dry_run, false);
    assert.equal(livePayload.run_count, 2);
    assert.equal(livePayload.total_acted_count, 1);
    assert.equal(livePayload.runs[0].stopped_reason, 'max_steps_reached');
    assert.equal(livePayload.runs[0].steps[0].selected_action, 'continue_work');
    assert.ok(livePayload.runs[0].steps[0].result.next_task_id);
    assert.equal(livePayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(livePayload.stopped_on, 'human_accept_waiting');
    assert.equal(livePayload.receipt_written, true);
    assert.equal(livePayload.receipt_path, receiptPath);
    assert.equal(livePayload.latest_receipt_path, latestPath);
    assert.equal(livePayload.safety.human_accept, false);
    assert.equal(livePayload.safety.writes_receipt, true);
    assert.equal(fs.existsSync(receiptPath), true);
    assert.equal(fs.existsSync(latestPath), true);

    const receiptLines = fs.readFileSync(receiptPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(receiptLines.length, 1);
    assert.equal(receiptLines[0].schema, 'atris.task_review_lane_run.v1');
    assert.equal(receiptLines[0].receipt_written, true);
    assert.equal(receiptLines[0].total_acted_count, 1);
    const latestReceipt = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    assert.equal(latestReceipt.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(latestReceipt.safety.human_accept, false);

    const afterWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterWaiting.current_version, beforeWaiting.current_version);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-run does not repeat the same review_chat task across inner loops', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Run should not duplicate review chat packets',
      '--tag', 'task',
      '--goal-id', 'OBL-954',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-run duplicate guard',
    ], { cwd: dir, env }).status, 0);

    const before = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    const beforeReviewChats = (before.messages || []).filter(message => /TASK_REVIEW_CHAT/.test(message.content || '')).length;
    const liveRun = runCli([
      'task', 'review-lane-run',
      '--goal-id', 'OBL-954',
      '--max-runs', '3',
      '--max-steps', '1',
      '--json',
    ], { cwd: dir, env });
    assert.equal(liveRun.status, 0, liveRun.stderr);
    const payload = JSON.parse(liveRun.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.run_count, 2);
    assert.equal(payload.total_acted_count, 1);
    assert.equal(payload.runs[0].stopped_reason, 'max_steps_reached');
    assert.equal(payload.runs[0].steps[0].selected_action, 'review_chat');
    assert.equal(payload.runs[1].stopped_reason, 'no_review_lane_action');
    assert.equal(payload.stopped_reason, 'no_review_lane_action');

    const actedTaskIds = payload.runs
      .flatMap(run => run.steps || [])
      .filter(step => step.acted)
      .map(step => step.decision && step.decision.task_id)
      .filter(Boolean);
    assert.deepEqual(actedTaskIds, [before.id]);

    const after = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    const afterReviewChats = (after.messages || []).filter(message => /TASK_REVIEW_CHAT/.test(message.content || '')).length;
    assert.equal(after.current_version, before.current_version + 1);
    assert.equal(afterReviewChats, beforeReviewChats + 1);

    const drainAfterChat = runCli(['task', 'review-lane-drain', '--goal-id', 'OBL-954', '--json'], { cwd: dir, env });
    assert.equal(drainAfterChat.status, 0, drainAfterChat.stderr);
    const drainAfterPayload = JSON.parse(drainAfterChat.stdout);
    assert.equal(drainAfterPayload.drain.next_action, 'pending_review_chat');
    assert.equal(drainAfterPayload.drain.safe_for_agent, false);
    assert.equal(drainAfterPayload.drain.command, null);
    assert.equal(drainAfterPayload.drain.reason, 'pending_review_chat_waiting_for_agent_review');
    assert.equal(drainAfterPayload.review_state_actions.pending_review_chat_count, 1);
    assert.equal(drainAfterPayload.review_state_actions.pending_review_chat[0].ref, ref);

    const secondRun = runCli([
      'task', 'review-lane-run',
      '--goal-id', 'OBL-954',
      '--max-runs', '2',
      '--max-steps', '1',
      '--json',
    ], { cwd: dir, env });
    assert.equal(secondRun.status, 0, secondRun.stderr);
    const secondPayload = JSON.parse(secondRun.stdout);
    assert.equal(secondPayload.ok, true);
    // The pending chat is auto-review territory now: the lane attempts the
    // evidence-gated pass, refuses prose-only proof, and excludes the task
    // instead of re-selecting it. No mutation, no repeated chat packets.
    assert.equal(secondPayload.run_count, 2);
    assert.equal(secondPayload.total_acted_count, 0);
    assert.equal(secondPayload.stopped_reason, 'auto_review_no_green_evidence');
    assert.equal(secondPayload.runs[0].steps[0].reason, 'auto_review_no_green_evidence');
    const afterSecondRun = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    const afterSecondRunReviewChats = (afterSecondRun.messages || []).filter(message => /TASK_REVIEW_CHAT/.test(message.content || '')).length;
    assert.equal(afterSecondRun.current_version, after.current_version);
    assert.equal(afterSecondRunReviewChats, afterReviewChats);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-drain skips continue-work rows with existing follow-up children', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const freshCreated = runCli([
      'task', 'new', 'Drain should eventually choose this fresh continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-953',
      '--json',
    ], { cwd: dir, env });
    assert.equal(freshCreated.status, 0, freshCreated.stderr);
    const freshRef = JSON.parse(freshCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', freshRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before fresh drain continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', freshRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during fresh drain continuation',
      '--next', 'Add the fresh child selected by review lane drain',
    ], { cwd: dir, env }).status, 0);

    const followedCreated = runCli([
      'task', 'new', 'Drain should skip this already-followed continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-953',
      '--json',
    ], { cwd: dir, env });
    assert.equal(followedCreated.status, 0, followedCreated.stderr);
    const followedRef = JSON.parse(followedCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', followedRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before followed drain continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', followedRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during followed drain continuation',
      '--next', 'Add the already-created child skipped by review lane drain',
    ], { cwd: dir, env }).status, 0);
    const followedContinue = runCli(['task', 'continue-work', followedRef, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(followedContinue.status, 0, followedContinue.stderr);
    const followedContinuePayload = JSON.parse(followedContinue.stdout);
    assert.equal(followedContinuePayload.created, true);

    assert.equal(runCli([
      'task', 'review', followedRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during retitled followed drain continuation',
      '--next', 'Add a newer child title after the first follow-up already exists',
    ], { cwd: dir, env }).status, 0);
    const followedRetitledContinue = runCli(['task', 'continue-work', followedRef, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(followedRetitledContinue.status, 0, followedRetitledContinue.stderr);
    const followedRetitledPayload = JSON.parse(followedRetitledContinue.stdout);
    assert.equal(followedRetitledPayload.created, false);
    assert.equal(followedRetitledPayload.next_task_id, followedContinuePayload.next_task_id);

    const db = taskStore.open(dbPath);
    assert.equal(taskStore.doneTask(db, {
      id: followedContinuePayload.next_task_id,
      actor: 'codex',
    }).updated, true);
    const workspaceRoot = fs.realpathSync(dir);
    for (let i = 0; i < 9; i += 1) {
      const filler = taskStore.addTask(db, {
        title: `Projection filler done child ${i}`,
        workspaceRoot,
        status: 'done',
      });
      assert.equal(filler.inserted, true);
    }
    taskStore.close();

    const drain = runCli(['task', 'review-lane-drain', '--goal-id', 'OBL-953', '--json'], { cwd: dir, env });
    assert.equal(drain.status, 0, drain.stderr);
    const payload = JSON.parse(drain.stdout);
    assert.equal(payload.drain.next_action, 'continue_work');
    assert.equal(payload.drain.task.ref, freshRef);
    assert.match(payload.drain.command, new RegExp(`continue-work ${freshRef}`));
    assert.equal(payload.review_state_counts.continue_work, 1);
    assert.equal(payload.review_state_counts.human_accept_waiting, 1);
    assert.equal(payload.review_state_actions.continue_work.ref, freshRef);
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up_count, 1);
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up[0].ref, followedRef);
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up[0].next_action, 'human_accept_waiting');
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up[0].command, null);
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up[0].continue_work_command, undefined);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.status.counts.review_continue_work, 1);
    assert.equal(statusPayload.status.counts.review_human_accept_waiting, 1);
    assert.equal(statusPayload.status.review_actions.continue_work.count, 1);
    assert.equal(statusPayload.status.review_actions.continue_work.first.ref, freshRef);
    assert.match(statusPayload.status.review_actions.continue_work.first.command, new RegExp(`continue-work ${freshRef}`));
    assert.equal(statusPayload.status.review_actions.human_accept_waiting.count, 1);
    assert.equal(statusPayload.status.review_actions.human_accept_waiting.first.ref, followedRef);
    assert.equal(statusPayload.status.review_actions.human_accept_waiting.first.command, null);

    const followedCurrent = runCli([
      'task', 'current',
      '--goal-id', 'OBL-953',
      '--review-state', 'human-accept-waiting',
      '--json',
    ], { cwd: dir, env });
    assert.equal(followedCurrent.status, 0, followedCurrent.stderr);
    const followedCurrentPayload = JSON.parse(followedCurrent.stdout);
    assert.equal(followedCurrentPayload.current.review_state_actions.human_accept_waiting.ref, followedRef);
    assert.equal(followedCurrentPayload.current.review_state_actions.human_accept_waiting.command, null);
    assert.equal(followedCurrentPayload.current.review_state_actions.human_accept_waiting.continue_work_command, undefined);
  } finally {
    taskStore.close();
    cleanupTempDir(dir);
  }
});

test('task events defaults to a recent compact view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Keep the ledger behind the cockpit', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    for (let i = 0; i < 30; i += 1) {
      const note = runCli(['task', 'say', id, `status note ${i}`, '--as', 'codex'], { cwd: dir, env });
      assert.equal(note.status, 0, note.stderr);
    }

    const recent = runCli(['task', 'events'], { cwd: dir, env });
    assert.equal(recent.status, 0, recent.stderr);
    assert.match(recent.stdout, /TASK EVENTS/);
    assert.match(recent.stdout, /recent 24 events/);
    assert.match(recent.stdout, /status note 29/);
    assert.doesNotMatch(recent.stdout, /status note 0/);
    assert.doesNotMatch(recent.stdout, /"content"/);

    const recentJson = runCli(['task', 'events', '--json'], { cwd: dir, env });
    assert.equal(recentJson.status, 0, recentJson.stderr);
    const payload = JSON.parse(recentJson.stdout);
    assert.equal(payload.mode, 'recent');
    assert.equal(payload.limit, 24);
    assert.equal(payload.events.length, 24);

    const all = runCli(['task', 'events', '--all'], { cwd: dir, env });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /status note 0/);
    assert.match(all.stdout, /"content":"status note 29"/);

    const out = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const exported = runCli(['task', 'export', '--out', out], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    const projection = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(projection.surface.compact, true);
    assert.equal(projection.surface.full_task_count, 1);
    assert.equal(projection.surface.full_ledger_command, 'atris task events --all');
    assert.equal(projection.tasks[0].messages.length, 6);
    assert.equal(projection.tasks[0].events.length, 8);
    assert.equal(projection.tasks[0].history.message_count, 30);
    assert.equal(projection.tasks[0].history.event_count, 31);
    assert.equal(projection.tasks[0].history.messages_truncated, true);
    assert.equal(projection.tasks[0].history.events_truncated, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task note, show, and export expose a dialogue projection for UI surfaces', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Design task dialogue cards', '--tag', 'ui', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const addPayload = JSON.parse(add.stdout);
    const id = addPayload.task_id;
    const ref = addPayload.task.display_id;

    const note = runCli(['task', 'note', ref, 'User wants Cursor-like task chat', '--as', 'codex'], { cwd: dir, env });
    assert.equal(note.status, 0, note.stderr);
    assert.match(note.stdout, new RegExp(`noted ${ref} v2`));

    const show = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, new RegExp(`OPEN ${ref} v2 #ui`));
    assert.match(show.stdout, /Dialogue:/);
    assert.match(show.stdout, /codex: User wants Cursor-like task chat/);

    const showJson = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
    assert.equal(showJson.status, 0, showJson.stderr);
    const task = JSON.parse(showJson.stdout);
    assert.equal(task.current_version, 2);
    assert.equal(task.messages[0].content, 'User wants Cursor-like task chat');

    const largeMessage = `large json pipe proof\n${'x'.repeat(96 * 1024)}`;
    const largeNote = runCli(['task', 'note', ref, largeMessage, '--as', 'codex'], { cwd: dir, env });
    assert.equal(largeNote.status, 0, largeNote.stderr);

    const largeShowJson = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
    assert.equal(largeShowJson.status, 0, largeShowJson.stderr);
    assert.ok(largeShowJson.stdout.length > 64 * 1024, 'large task JSON must exceed a typical pipe buffer');
    const largeTask = JSON.parse(largeShowJson.stdout);
    assert.equal(largeTask.current_version, 3);
    assert.ok(largeTask.messages.at(-1).content.startsWith('large json pipe proof\nxxxxx'));

    const out = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const exported = runCli(['task', 'export', '--out', out], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /exported 1 task/);
    const projection = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(projection.schema, 'atris.task_projection.v1');
    assert.equal(projection.tasks[0].id, id);
    assert.equal(projection.tasks[0].display_id, ref);
    assert.equal(projection.tasks[0].messages[0].actor, 'codex');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task delegate creates assigned work and day view groups by owner', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'Review launch draft',
      '--to',
      'justin',
      '--tag',
      'launch',
      '--note',
      'Need clear copy before posting',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const body = JSON.parse(delegated.stdout);
    assert.equal(body.action, 'delegated');
    assert.equal(body.owner, 'justin');
    assert.equal(body.via, 'local');
    assert.equal(body.task.status, 'open');
    assert.equal(body.task.assigned_to, 'justin');
    assert.equal(body.task.metadata.delegate_via, 'local');
    assert.equal(body.task.latest_event_type, 'message');
    assert.match(body.handoff.command, /^atris task claim [A-Z0-9]{3}-1 --as justin$/);

    const day = runCli(['task', 'day', '--json'], { cwd: dir, env });
    assert.equal(day.status, 0, day.stderr);
    const dayBody = JSON.parse(day.stdout);
    assert.equal(dayBody.action, 'day');
    assert.equal(dayBody.counts.active, 1);
    assert.equal(dayBody.groups[0].owner, 'justin');
    assert.equal(dayBody.groups[0].tasks[0].id, body.task_id);

    const textDay = runCli(['task', 'day'], { cwd: dir, env });
    assert.equal(textDay.status, 0, textDay.stderr);
    assert.match(textDay.stdout, /task day/);
    assert.match(textDay.stdout, /justin/);
    assert.match(textDay.stdout, /Review launch draft/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task delegate infers a functional owner when none is supplied', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'Design 24/7 functional team member factory',
      '--tag',
      'team-members',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const body = JSON.parse(delegated.stdout);
    assert.equal(body.owner, 'architect');
    assert.equal(body.task.assigned_to, 'architect');
    assert.equal(body.task.metadata.owner_resolution, 'inferred_by_task_signal');
    assert.equal(body.executed_by, null);
    assert.match(body.handoff.command, /^atris task claim [A-Z0-9]{3}-1 --as architect$/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task delegate can prepare a Swarlo handoff without changing task truth', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'Run overnight validation',
      '--to',
      'codex',
      '--via',
      'swarlo',
      '--tag',
      'tasks',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const body = JSON.parse(delegated.stdout);
    assert.equal(body.owner, 'mission-lead');
    assert.equal(body.executed_by, 'codex');
    assert.equal(body.task.assigned_to, 'mission-lead');
    assert.equal(body.task.metadata.executed_by, 'codex');
    assert.equal(body.task.metadata.requested_owner, 'codex');
    assert.equal(body.task.metadata.owner_resolution, 'engine_owner_resolved_by_task_signal');
    assert.equal(body.task.metadata.delegate_via, 'swarlo');
    assert.equal(body.handoff.swarlo.action, 'claim');
    assert.equal(body.handoff.swarlo.channel, 'tasks');
    assert.equal(body.handoff.swarlo.task_key, body.task_id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode opens the assigned AgentXP mission for a player', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'AgentXP Mode first rep',
      '--to',
      'justin',
      '--tag',
      'agent-xp',
      '--note',
      'Win condition: one proof-backed useful rep.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);

    const play = runCli(['play', '--as', 'justin'], { cwd: dir, env: { ...env, USER: 'keshav' } });
    assert.equal(play.status, 0, play.stderr);
    assert.match(play.stdout, /AgentXP Mode/);
    assert.match(play.stdout, /Player justin/);
    assert.match(play.stdout, /Handle source: --as\/--player\./);
    assert.match(play.stdout, /AgentXP Mode first rep/);
    assert.match(play.stdout, /Win condition: one proof-backed useful rep/);
    assert.match(play.stdout, /atris task claim [A-Z0-9]{3}-1 --as justin/);
    assert.match(play.stdout, /atris task ready [A-Z0-9]{3}-1 --as justin --proof/);
    assert.match(play.stdout, /atris xp card --local/);
    assert.match(play.stdout, /atris xp sync --local --token <owner-provided-token>/);
    assert.match(play.stdout, /atris login/);
    assert.match(play.stdout, /atris xp sync --local/);
    assert.match(play.stdout, /Leaderboard: https:\/\/api\.atris\.ai\/api\/agentxp\/leaderboard/);
    assert.match(play.stdout, /Proof recipe:/);
    assert.match(play.stdout, /Ready proof:/);

    const json = runCli(['play', '--as', 'justin', '--json'], { cwd: dir, env: { ...env, USER: 'keshav' } });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.schema, 'atris.agentxp_play_mode.v1');
    assert.equal(body.player, 'justin');
    assert.equal(body.player_source, 'flag');
    assert.equal(body.mission.title, 'AgentXP Mode first rep');
    assert.equal(body.mission.assigned_to, 'justin');
    assert.equal(body.global_sync_rule, 'Run atris login, then sync. Owner-provided sync tokens are guided-demo fallback only.');
    assert.equal(body.leaderboard_url, 'https://api.atris.ai/api/agentxp/leaderboard');
    assert.match(body.proof_recipe.verifier, /test -s AGENTXP_PROOF\.md/);
    assert.match(body.proof_recipe.solo_review_rule, /solo public smoke/);
    assert.equal(body.next_commands[0], `atris task claim ${body.mission.ref} --as justin`);
    assert.ok(
      body.next_commands.indexOf('atris login')
        < body.next_commands.indexOf('atris xp sync --local --token <owner-provided-token>')
    );
    assert.equal(body.next_commands.includes('atris login'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode defaults to current username instead of another assigned player', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', USER: 'keshav' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'Justin AgentXP Mode first rep',
      '--to',
      'justin',
      '--tag',
      'agent-xp',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);

    const play = runCli(['play', '--no-seed', '--json'], { cwd: dir, env });
    assert.equal(play.status, 0, play.stderr);
    const body = JSON.parse(play.stdout);
    assert.equal(body.player, 'keshav');
    assert.equal(body.player_source, 'local_user');
    assert.equal(body.mission, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode bootstraps a starter mission on a fresh player workspace', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = {
    ATRIS_TASKS_DB: dbPath,
    NODE_NO_WARNINGS: '1',
    USER: 'justin',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'justin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'START_HERE.md'), '# Justin\n');

    const play = runCli(['play'], { cwd: dir, env });
    assert.equal(play.status, 0, play.stderr);
    assert.match(play.stdout, /AgentXP Mode/);
    assert.match(play.stdout, /Player justin/);
    assert.match(play.stdout, /Handle source: inferred\. To choose one, run atris play --as <handle> or ATRIS_PLAYER=<handle> atris play\./);
    assert.match(play.stdout, /Starter mission created locally/);
    assert.match(play.stdout, /AgentXP Mode first rep: complete one proof-backed useful mission/);
    assert.match(play.stdout, /atris task claim [A-Z0-9]{3}-1 --as justin/);

    const json = runCli(['play', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.player, 'justin');
    assert.equal(body.player_source, 'local_user_team_match');
    assert.equal(body.seeded, null);
    assert.equal(body.mission.assigned_to, 'justin');
    assert.equal(body.mission.title, 'AgentXP Mode first rep: complete one proof-backed useful mission');
    assert.doesNotMatch(body.mission.prompt, /Do not self-accept/);
    assert.match(body.mission.prompt, /weak proof should be revised/);
    assert.match(body.proof_recipe.ready_proof, /atris task ready/);

    const list = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(list.status, 0, list.stderr);
    const tasks = JSON.parse(list.stdout).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].metadata.assigned_to, 'justin');
    assert.equal(tasks[0].metadata.delegate_via, 'agentxp_play');
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode makes a plain folder playable on first run', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', USER: 'keshav' };
  try {
    const json = runCli(['play', '--as', 'justin', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.player, 'justin');
    assert.equal(body.player_source, 'flag');
    assert.equal(body.workspace_root, fs.realpathSync(dir));
    assert.equal(body.seeded.title, 'AgentXP Mode first rep: complete one proof-backed useful mission');
    assert.equal(body.mission.assigned_to, 'justin');
    assert.deepEqual(body.next_commands.slice(0, 2), [
      `atris task claim ${body.mission.ref} --as justin`,
      `atris task ready ${body.mission.ref} --as justin --proof "AGENTXP_PROOF.md + test -s AGENTXP_PROOF.md passed" --result "Players can now claim AgentXP proof faster because the verifier names the finished artifact."`,
    ]);
    assert.match(body.proof_recipe.artifact, /AGENTXP_PROOF\.md/);
    assert.equal(body.next_commands.includes('atris xp sync --local --token <owner-provided-token>'), true);
    assert.equal(body.next_commands.includes('atris login'), true);
    assert.equal(body.next_commands.includes('atris xp sync --local'), true);
    assert.ok(fs.existsSync(path.join(dir, 'atris')), 'play should initialize the local game workspace');
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode help is workspace-free and non-mutating', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['play', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris play/);
    assert.doesNotMatch(res.stdout + res.stderr, /Run "atris init"|Not logged in|CONTEXT LOADED/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review writes a reviewed event and RSI episode jsonl', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris.md'), '# task tree\n', 'utf8');

    const add = runCli(['task', 'add', 'Close RSI task loop', '--tag', 'rsi', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const addPayload = JSON.parse(add.stdout);
    const id = addPayload.task_id;
    const ref = addPayload.task.display_id;
    assert.equal(runCli(['task', 'done', ref, '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--lesson', 'Small task events compound',
      '--next', 'Sync task events to Swarlo',
      '--proof', 'npm test',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, new RegExp(`reviewed ${ref} v4 reward=1`));
    assert.match(review.stdout, /next: Sync task events to Swarlo/);

    const events = runCli(['task', 'events', ref], { cwd: dir, env });
    assert.equal(events.status, 0, events.stderr);
    assert.match(events.stdout, new RegExp(`4\\treviewed\\t${ref}`));

    const episodePath = path.join(dir, '.atris', 'state', 'task_episodes.jsonl');
    const episodes = fs.readFileSync(episodePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(episodes.length, 2);
    const episode = episodes.at(-1);
    assert.equal(episode.schema, 'atris.task_episode.v1');
    assert.equal(typeof episode.tree_hash, 'string');
    assert.equal(episode.task_id, id);
    assert.equal(episode.reward.value, 1);
    assert.equal(episode.action.actor, 'codex');
    assert.equal(episode.lesson, 'Small task events compound');
    assert.equal(episode.proof, 'npm test');
    assert.equal(episode.next_task_suggestion, 'Sync task events to Swarlo');
    assert.equal(episode.goal, null);
    assert.deepEqual(episode.career_xp, {
      eligible: false,
      source: 'task_review',
      reward: 1,
      proof_required: true,
    });
    assert.deepEqual(episode.rl, {
      label: 'accepted',
      source: 'task_review',
      reward: 1,
      has_proof: true,
      has_lesson: true,
      has_next_task: true,
      landing_completeness: 0,
      approval_status: 'accepted',
    });
  } finally {
    cleanupTempDir(dir);
  }
});

test('task done with proof writes a reviewed proof event', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Validate proof persistence', '--tag', 'rsi'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const id = add.stdout.trim().split('\t')[0];

    const done = runCli([
      'task', 'done', id,
      '--proof', 'task show validation passed',
      '--lesson', 'done with proof should unlock review state',
      '--json',
    ], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);
    const donePayload = JSON.parse(done.stdout);
    assert.equal(donePayload.reviewed, true);
    assert.equal(donePayload.reward, 1);
    assert.equal(donePayload.episode.proof, 'task show validation passed');
    assert.equal(donePayload.episode.lesson, 'done with proof should unlock review state');
    assert.equal(donePayload.episode.career_xp.eligible, false);
    assert.equal(donePayload.xp_projection.total_xp, 0);
    assert.equal(donePayload.xp_projection.collected_receipts, 0);
    assert.equal(
      donePayload.xp_projection.earning_model.policies.task_done_with_proof,
      'Records proof for review and RL context; emits no Career XP receipt until human accept.',
    );

    const show = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    assert.equal(task.status, 'done');
    assert.deepEqual(task.events.map(e => e.event_type), ['created', 'completed', 'reviewed']);
    assert.equal(task.review.proof, 'task show validation passed');
    assert.equal(task.review.reward, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task plan and do record an explicit headless stage contract', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Make task stage loop explicit', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const unplannedDo = runCli(['task', 'do', ref, '--as', 'codex', '--first-move', 'patch the CLI', '--json'], { cwd: dir, env });
    assert.equal(unplannedDo.status, 1);
    assert.equal(JSON.parse(unplannedDo.stdout).reason, 'goal_required');

    const inlineDoTask = runCli(['task', 'add', 'Inline do must not skip plan', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(inlineDoTask.status, 0, inlineDoTask.stderr);
    const inlineDoRef = JSON.parse(inlineDoTask.stdout).task.display_id;
    const inlineDo = runCli([
      'task', 'do', inlineDoRef,
      '--as', 'codex',
      '--goal', 'Try to skip the plan',
      '--proof-needed', 'node --test should not run yet',
      '--first-move', 'start too early',
      '--json',
    ], { cwd: dir, env });
    assert.equal(inlineDo.status, 1);
    assert.equal(JSON.parse(inlineDo.stdout).reason, 'plan_required');

    const owned = runCli(['task', 'add', 'Do not plan another owner task', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(owned.status, 0, owned.stderr);
    const ownedRef = JSON.parse(owned.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ownedRef, '--as', 'alice'], { cwd: dir, env }).status, 0);
    const otherOwnerPlan = runCli([
      'task', 'plan', ownedRef,
      '--as', 'codex',
      '--goal', 'Change someone else task',
      '--exit', 'should be rejected',
      '--proof-needed', 'should be rejected',
      '--json',
    ], { cwd: dir, env });
    assert.equal(otherOwnerPlan.status, 1);
    assert.equal(JSON.parse(otherOwnerPlan.stdout).reason, 'claimed_by_other');

    const otherOwnerPlanWithAssignee = runCli([
      'task', 'plan', ownedRef,
      '--as', 'codex',
      '--owner', 'alice',
      '--goal', 'Rewrite by naming the claimant',
      '--exit', 'should be rejected',
      '--proof-needed', 'should be rejected',
      '--json',
    ], { cwd: dir, env });
    assert.equal(otherOwnerPlanWithAssignee.status, 1);
    assert.equal(JSON.parse(otherOwnerPlanWithAssignee.stdout).reason, 'claimed_by_other');

    const claimedAfterPlan = runCli(['task', 'add', 'Do not start after external claim', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(claimedAfterPlan.status, 0, claimedAfterPlan.stderr);
    const claimedAfterPlanRef = JSON.parse(claimedAfterPlan.stdout).task.display_id;
    const claimedAfterPlanStage = runCli([
      'task', 'plan', claimedAfterPlanRef,
      '--as', 'codex',
      '--owner', 'codex',
      '--goal', 'Keep planned owner aligned',
      '--exit', 'claim owner and plan owner agree',
      '--proof-needed', 'node --test task stage coverage passes',
      '--json',
    ], { cwd: dir, env });
    assert.equal(claimedAfterPlanStage.status, 0, claimedAfterPlanStage.stderr);
    assert.equal(runCli(['task', 'claim', claimedAfterPlanRef, '--as', 'alice'], { cwd: dir, env }).status, 0);
    const claimedConflictDo = runCli([
      'task', 'do', claimedAfterPlanRef,
      '--as', 'codex',
      '--first-move', 'start despite external claim',
      '--json',
    ], { cwd: dir, env });
    assert.equal(claimedConflictDo.status, 1);
    assert.equal(JSON.parse(claimedConflictDo.stdout).reason, 'claimed_by_other');

    const missingExit = runCli(['task', 'plan', ref, '--goal', 'Ship task stage CLI', '--proof-needed', 'node --test commands passed', '--json'], { cwd: dir, env });
    assert.equal(missingExit.status, 1);
    assert.equal(JSON.parse(missingExit.stdout).reason, 'exit_required');

    const planned = runCli([
      'task', 'plan', ref,
      '--as', 'codex',
      '--goal', 'Ship task stage CLI',
      '--summary', 'Add durable Plan and Do stage commands',
      '--owner', 'codex',
      '--exit', 'task can enter Review with command-backed proof',
      '--proof-needed', 'node --test test/commands.test.js passes for task stage commands',
      '--first-move', 'patch task-db stageTask',
      '--confidence', '0.9',
      '--json',
    ], { cwd: dir, env });
    assert.equal(planned.status, 0, planned.stderr);
    const plannedPayload = JSON.parse(planned.stdout);
    assert.equal(plannedPayload.action, 'planned');
    assert.equal(plannedPayload.task.status, 'open');
    assert.equal(plannedPayload.task.objective, 'Ship task stage CLI');
    assert.equal(plannedPayload.task.metadata.stage, 'plan');
    assert.equal(plannedPayload.task.metadata.verify, 'node --test test/commands.test.js passes for task stage commands');
    assert.match(plannedPayload.stage_packet, /TASK_STAGE_UPDATE/);
    assert.match(plannedPayload.stage_packet, /stage: plan/);
    assert.match(plannedPayload.stage_packet, /goal: Ship task stage CLI/);
    assert.match(plannedPayload.stage_packet, /proof_needed: node --test test\/commands\.test\.js passes for task stage commands/);

    const wrongOwnerDo = runCli([
      'task', 'do', ref,
      '--as', 'bob',
      '--first-move', 'take over another owner plan',
      '--json',
    ], { cwd: dir, env });
    assert.equal(wrongOwnerDo.status, 1);
    assert.equal(JSON.parse(wrongOwnerDo.stdout).reason, 'claimed_by_other');

    const rewritePlanDo = runCli([
      'task', 'do', ref,
      '--as', 'codex',
      '--goal', 'Rewrite the recorded plan',
      '--proof-needed', 'weaker proof',
      '--first-move', 'start from rewritten text',
      '--json',
    ], { cwd: dir, env });
    assert.equal(rewritePlanDo.status, 1);
    assert.equal(JSON.parse(rewritePlanDo.stdout).reason, 'plan_goal_mismatch');

    const exitMismatchDo = runCli([
      'task', 'do', ref,
      '--as', 'codex',
      '--exit', 'different review boundary',
      '--first-move', 'start with changed exit',
      '--json',
    ], { cwd: dir, env });
    assert.equal(exitMismatchDo.status, 1);
    assert.equal(JSON.parse(exitMismatchDo.stdout).reason, 'plan_exit_mismatch');

    const showPlanned = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(showPlanned.status, 0, showPlanned.stderr);
    const plannedTask = JSON.parse(showPlanned.stdout);
    assert.equal(plannedTask.latest_event_type, 'task_planned');
    assert.equal(plannedTask.history.message_count, 1);
    assert.match(plannedTask.messages[0].content, /TASK_STAGE_UPDATE/);
    assert.match(plannedTask.messages[0].content, /exit: task can enter Review with command-backed proof/);

    const statusAfterPlan = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(statusAfterPlan.status, 0, statusAfterPlan.stderr);
    assert.equal(JSON.parse(statusAfterPlan.stdout).status.counts.plan, 1);

    const doing = runCli([
      'task', 'do', ref,
      '--as', 'codex',
      '--summary', 'Start from the recorded plan',
      '--first-move', 'run the focused command tests',
      '--json',
    ], { cwd: dir, env });
    assert.equal(doing.status, 0, doing.stderr);
    const doingPayload = JSON.parse(doing.stdout);
    assert.equal(doingPayload.action, 'doing');
    assert.equal(doingPayload.task.status, 'claimed');
    assert.equal(doingPayload.task.claimed_by, 'codex');
    assert.equal(doingPayload.task.metadata.stage, 'do');
    assert.match(doingPayload.stage_packet, /stage: do/);
    assert.doesNotMatch(doingPayload.stage_packet, /confidence:/);
    assert.match(doingPayload.stage_packet, /first_move: run the focused command tests/);

    const showDoing = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(showDoing.status, 0, showDoing.stderr);
    const doingTask = JSON.parse(showDoing.stdout);
    assert.equal(doingTask.latest_event_type, 'work_started');
    assert.equal(doingTask.messages.length, 2);
    assert.match(doingTask.messages.at(-1).content, /stage: do/);

    const ready = runCli(['task', 'ready', ref, '--as', 'codex', '--proof', 'node --check test/commands.test.js passed for task stage commands', '--json'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.status, 'review');
    assert.equal(readyPayload.task.review.proof, 'node --check test/commands.test.js passed for task stage commands');
    assert.equal(readyPayload.task.review.verification_chat.schema, 'atris.task_review_chat.v1');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task do reloads latest plan metadata after claiming an open task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const workspaceRoot = fs.realpathSync(path.join(dir, 'project-obelisk'));
    const created = taskDb.addTask(db, {
      title: 'Use freshest plan during Do claim',
      tag: 'capture',
      workspaceRoot,
    });
    const planned = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'plan',
      goal: 'Old plan goal',
      exit: 'old exit',
      proofNeeded: 'old proof',
      firstMove: 'old first move',
    });
    assert.equal(planned.staged, true);

    db.prepare(`
      CREATE TRIGGER refresh_plan_after_stage_claim
      AFTER UPDATE OF status ON tasks
      WHEN NEW.id = '${created.id}' AND OLD.status = 'open' AND NEW.status = 'claimed'
      BEGIN
        UPDATE tasks
           SET updated_at = 4102444800000,
               metadata = '{"stage":"plan","planned_at":"fresh-plan","stage_plan_recorded_at":"fresh-plan","goal_objective":"Fresh plan goal","stage_goal":"Fresh plan goal","exit_condition":"fresh exit","verify":"fresh proof","proof_needed":"fresh proof","first_move":"fresh first move","next_button":"Start do"}'
         WHERE id = NEW.id;
      END
    `).run();

    const doing = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'do',
      firstMove: 'run the freshest plan',
    });
    assert.equal(doing.staged, true);
    assert.match(doing.stage_packet, /goal: Fresh plan goal/);
    assert.match(doing.stage_packet, /exit: fresh exit/);
    assert.match(doing.stage_packet, /proof_needed: fresh proof/);

    const updated = taskDb.getTask(db, created.id);
    assert.equal(updated.status, 'claimed');
    assert.equal(updated.metadata.stage, 'do');
    assert.equal(updated.metadata.goal_objective, 'Fresh plan goal');
    assert.equal(updated.metadata.exit_condition, 'fresh exit');
    assert.equal(updated.metadata.verify, 'fresh proof');
    assert.equal(updated.metadata.next_button, 'Move to review');
    assert.ok(updated.updated_at > 4102444800000);
    const events = taskDb.listTaskEvents(db, { taskId: created.id });
    const workStarted = events.find(event => event.event_type === 'work_started');
    assert.equal(workStarted.payload.goal, 'Fresh plan goal');
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task do rolls back the claim when plan ownership changes during claim', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const workspaceRoot = fs.realpathSync(path.join(dir, 'project-obelisk'));
    const created = taskDb.addTask(db, {
      title: 'Do should not keep a stale claim',
      tag: 'capture',
      workspaceRoot,
    });
    const planned = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'plan',
      owner: 'codex',
      goal: 'Old plan goal',
      exit: 'old exit',
      proofNeeded: 'old proof',
    });
    assert.equal(planned.staged, true);

    db.prepare(`
      CREATE TRIGGER reassign_plan_after_stage_claim
      AFTER UPDATE OF status ON tasks
      WHEN NEW.id = '${created.id}' AND OLD.status = 'open' AND NEW.status = 'claimed'
      BEGIN
        UPDATE tasks
           SET updated_at = 4102444800000,
               metadata = '{"stage":"plan","planned_at":"fresh-plan","stage_plan_recorded_at":"fresh-plan","stage_owner":"alice","assigned_to":"alice","goal_objective":"Fresh plan goal","stage_goal":"Fresh plan goal","exit_condition":"fresh exit","verify":"fresh proof","proof_needed":"fresh proof","next_button":"Start do"}'
         WHERE id = NEW.id;
      END
    `).run();

    const doing = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'do',
      firstMove: 'start from stale owner',
    });
    assert.equal(doing.staged, false);
    assert.equal(doing.reason, 'claimed_by_other');
    assert.equal(doing.claimed_by, 'alice');

    const updated = taskDb.getTask(db, created.id);
    assert.equal(updated.status, 'open');
    assert.equal(updated.claimed_by, null);
    assert.equal(updated.metadata.stage, 'plan');
    assert.equal(updated.metadata.stage_owner, 'alice');
    assert.ok(updated.updated_at > 4102444800000);
    const eventTypes = taskDb.listTaskEvents(db, { taskId: created.id }).map(event => event.event_type);
    assert.deepEqual(eventTypes, ['created', 'task_planned']);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task do lets current claimant override stale plan owner metadata', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const workspaceRoot = fs.realpathSync(path.join(dir, 'project-obelisk'));
    const created = taskDb.addTask(db, {
      title: 'Do should trust the current claimant',
      tag: 'capture',
      workspaceRoot,
      status: 'claimed',
      claimedBy: 'agi-research',
      metadata: {
        stage: 'plan',
        planned_at: 'old-plan',
        stage_plan_recorded_at: 'old-plan',
        stage_owner: 'keshavrao',
        assigned_to: 'keshavrao',
        goal_objective: 'Ship the claimed task',
        stage_goal: 'Ship the claimed task',
        exit_condition: 'Do starts under the actual claimant',
        verify: 'node --test task do ownership coverage',
        proof_needed: 'node --test task do ownership coverage',
        next_button: 'Start do',
      },
    });

    const doing = taskDb.stageTask(db, {
      id: created.id,
      actor: 'agi-research',
      stage: 'do',
      firstMove: 'continue from the claimed row',
    });
    assert.equal(doing.staged, true);
    assert.match(doing.stage_packet, /owner: agi-research/);

    const updated = taskDb.getTask(db, created.id);
    assert.equal(updated.status, 'claimed');
    assert.equal(updated.claimed_by, 'agi-research');
    assert.equal(updated.metadata.stage, 'do');
    assert.equal(updated.metadata.stage_owner, 'agi-research');
    assert.equal(updated.metadata.assigned_to, 'agi-research');
    assert.equal(updated.metadata.goal_objective, 'Ship the claimed task');
    const eventTypes = taskDb.listTaskEvents(db, { taskId: created.id }).map(event => event.event_type);
    assert.deepEqual(eventTypes, ['claimed', 'work_started']);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task do assigns legacy claimed rows that have no claimant', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const workspaceRoot = fs.realpathSync(path.join(dir, 'project-obelisk'));
    const created = taskDb.addTask(db, {
      title: 'Legacy claimed task without owner',
      tag: 'capture',
      workspaceRoot,
      status: 'claimed',
    });
    const planned = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'plan',
      owner: 'codex',
      goal: 'Recover unowned claimed task',
      exit: 'Do assigns the missing owner',
      proofNeeded: 'node --test task stage coverage passes',
    });
    assert.equal(planned.staged, true);

    const doing = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'do',
      firstMove: 'continue the legacy claimed row',
    });
    assert.equal(doing.staged, true);
    const updated = taskDb.getTask(db, created.id);
    assert.equal(updated.status, 'claimed');
    assert.equal(updated.claimed_by, 'codex');
    assert.equal(updated.metadata.stage, 'do');
    const eventTypes = taskDb.listTaskEvents(db, { taskId: created.id }).map(event => event.event_type);
    assert.deepEqual(eventTypes, ['claimed', 'task_planned', 'claimed', 'work_started']);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task chat refines a durable goal before plan', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Make a vague task useful', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const emptyChat = runCli(['task', 'chat', ref, '--json'], { cwd: dir, env });
    assert.equal(emptyChat.status, 2);
    assert.equal(JSON.parse(emptyChat.stdout).reason, 'content_required');

    const chat = runCli([
      'task', 'chat', ref,
      'This needs one concrete goal before execution',
      '--goal', 'Ship durable task chat refinement',
      '--summary', 'Narrowed from vague task to one proofable primitive',
      '--as', 'operator',
      '--json',
    ], { cwd: dir, env });
    assert.equal(chat.status, 0, chat.stderr);
    const chatPayload = JSON.parse(chat.stdout);
    assert.equal(chatPayload.action, 'chatted');
    assert.equal(chatPayload.goal_changed, true);
    assert.equal(chatPayload.task.objective, 'Ship durable task chat refinement');
    assert.equal(chatPayload.task.metadata.task_goal, 'Ship durable task chat refinement');
    assert.match(chatPayload.chat_packet, /TASK_CHAT_UPDATE/);
    assert.match(chatPayload.chat_packet, /goal: Ship durable task chat refinement/);

    const clearPlan = runCli(['task', 'clear-plan', '--yes', '--json'], { cwd: dir, env });
    assert.equal(clearPlan.status, 0, clearPlan.stderr);
    assert.equal(JSON.parse(clearPlan.stdout).cleared_count, 0);

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    assert.equal(shown.latest_event_type, 'task_chat');
    assert.equal(shown.objective, 'Ship durable task chat refinement');
    assert.ok(shown.messages.some(message => message.content.includes('TASK_CHAT_UPDATE')));

    const plan = runCli([
      'task', 'plan', ref,
      '--as', 'codex',
      '--exit', 'task chat can seed the plan goal',
      '--proof-needed', 'node --test task chat coverage passes',
      '--json',
    ], { cwd: dir, env });
    assert.equal(plan.status, 0, plan.stderr);
    const planPayload = JSON.parse(plan.stdout);
    assert.match(planPayload.stage_packet, /goal: Ship durable task chat refinement/);
    assert.equal(planPayload.task.metadata.task_goal, 'Ship durable task chat refinement');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task page exposes one-task goal chat stage and review actions', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Make one task page useful', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const firstPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(firstPage.status, 0, firstPage.stderr);
    const firstPayload = JSON.parse(firstPage.stdout);
    assert.equal(firstPayload.action, 'page');
    assert.equal(firstPayload.page.schema, 'atris.task_page.v1');
    assert.equal(firstPayload.page.task.ref, ref);
    assert.equal(firstPayload.page.stage.current, 'backlog');
    assert.equal(firstPayload.page.stage.next_action.key, 'plan');
    assert.match(firstPayload.page.actions.plan_command, new RegExp(`atris task plan ${ref}`));
    assert.equal(firstPayload.page.review.human_accept.enabled, false);
    assert.notEqual(firstPayload.page.stage.next_action.key, 'accept');

    const chat = runCli([
      'task', 'chat', ref,
      'Turn the card into a focused task page contract',
      '--goal', 'Ship a headless task page contract',
      '--summary', 'Need one stable packet for UI and agents',
      '--as', 'operator',
      '--json',
    ], { cwd: dir, env });
    assert.equal(chat.status, 0, chat.stderr);

    const chatPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(chatPage.status, 0, chatPage.stderr);
    const chatContract = JSON.parse(chatPage.stdout).page;
    assert.equal(chatContract.goal.text, 'Ship a headless task page contract');
    assert.equal(chatContract.goal.source, 'task_goal');
    assert.match(chatContract.chat.command, /atris task chat/);
    assert.ok(chatContract.chat.recent_messages.some(message => message.content.includes('TASK_CHAT_UPDATE')));
    assert.match(chatContract.actions.plan_command, /Ship a headless task page contract/);

    const plan = runCli([
      'task', 'plan', ref,
      '--as', 'codex',
      '--exit', 'task page shows the next Do action',
      '--proof-needed', 'node --test task page coverage passes',
      '--json',
    ], { cwd: dir, env });
    assert.equal(plan.status, 0, plan.stderr);

    const planPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(planPage.status, 0, planPage.stderr);
    const planned = JSON.parse(planPage.stdout).page;
    assert.equal(planned.stage.current, 'plan');
    assert.equal(planned.stage.next_action.key, 'do');
    assert.match(planned.stage.next_action.command, new RegExp(`atris task do ${ref}`));
    assert.equal(planned.stage.rail.find(item => item.key === 'plan').state, 'current');

    const doing = runCli(['task', 'do', ref, '--as', 'codex', '--first-move', 'patch the page contract', '--json'], { cwd: dir, env });
    assert.equal(doing.status, 0, doing.stderr);

    const doPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(doPage.status, 0, doPage.stderr);
    const doingContract = JSON.parse(doPage.stdout).page;
    assert.equal(doingContract.stage.current, 'do');
    assert.equal(doingContract.stage.next_action.key, 'ready');
    assert.match(doingContract.stage.next_action.command, new RegExp(`atris task ready ${ref}`));

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed for task page review',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const reviewPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(reviewPage.status, 0, reviewPage.stderr);
    const reviewContract = JSON.parse(reviewPage.stdout).page;
    assert.equal(reviewContract.stage.current, 'review');
    assert.equal(reviewContract.stage.next_action.key, 'review_chat');
    assert.match(reviewContract.stage.next_action.command, new RegExp(`atris task review-chat ${ref} --as codex-review`));
    assert.equal(reviewContract.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.equal(reviewContract.review.human_accept.enabled, true);
    assert.equal(reviewContract.review.human_accept.human_only, true);
    assert.equal(reviewContract.review.human_accept.command, `atris task accept ${ref}`);
    assert.notEqual(reviewContract.stage.next_action.command, reviewContract.review.human_accept.command);

    const customReviewerPage = runCli(['task', 'page', ref, '--as', 'alice-review', '--json'], { cwd: dir, env });
    assert.equal(customReviewerPage.status, 0, customReviewerPage.stderr);
    const customReviewerContract = JSON.parse(customReviewerPage.stdout).page;
    assert.equal(customReviewerContract.stage.next_action.command, `atris task review-chat ${ref} --as alice-review`);
    assert.equal(customReviewerContract.review.verification_chat.command, `atris task review-chat ${ref} --as alice-review`);
    assert.equal(customReviewerContract.review.verification_chat.pass_command, `atris task review ${ref} --reward 0 --as alice-review --proof "<specific verifier commands passed and diff/proof inspected>" --verify "<safe verifier command>"`);

    const certify = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', 'node --test test/commands.test.js passed and task page inspected',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certify.status, 0, certify.stderr);
    const certifiedPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(certifiedPage.status, 0, certifiedPage.stderr);
    const certifiedContract = JSON.parse(certifiedPage.stdout).page;
    assert.equal(certifiedContract.stage.current, 'review');
    assert.equal(certifiedContract.stage.next_action.key, 'human_accept_waiting');
    assert.equal(certifiedContract.stage.next_action.command, null);
    assert.equal(certifiedContract.review.handoff.next_action, 'human_accept_waiting');
    assert.equal(certifiedContract.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.equal(certifiedContract.review.verification_chat.command, `atris task review-chat ${ref} --as codex-review`);
    assert.equal(certifiedContract.actions.review_chat_command, `atris task review-chat ${ref} --as codex-review`);
    assert.equal(certifiedContract.review.human_accept.enabled, true);
    assert.equal(certifiedContract.review.human_accept.command, `atris task accept ${ref}`);

    const certifiedReviewChat = runCli(['task', 'review-chat', ref, '--as', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(certifiedReviewChat.status, 0, certifiedReviewChat.stderr);
    const certifiedReviewChatPayload = JSON.parse(certifiedReviewChat.stdout);
    assert.equal(certifiedReviewChatPayload.action, 'review_chat');
    assert.equal(certifiedReviewChatPayload.appended, true);
    assert.equal(certifiedReviewChatPayload.contract.review.agent_certified, true);

    const certifiedShow = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(certifiedShow.status, 0, certifiedShow.stderr);
    assert.equal(JSON.parse(certifiedShow.stdout).review.verification_chat, undefined);

    const legacyAdd = runCli(['task', 'add', 'Legacy done row still needs review', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(legacyAdd.status, 0, legacyAdd.stderr);
    const legacyAddPayload = JSON.parse(legacyAdd.stdout);
    const legacyRef = legacyAddPayload.task.display_id;
    const previousTaskDb = process.env.ATRIS_TASKS_DB;
    const taskDb = require('../lib/task-db');
    try {
      process.env.ATRIS_TASKS_DB = dbPath;
      taskDb.close();
      const db = taskDb.open();
      const legacyDone = taskDb.doneTask(db, { id: legacyAddPayload.task_id, status: 'done', actor: 'codex' });
      assert.equal(legacyDone.updated, true);
      taskDb.close();
    } finally {
      taskDb.close();
      if (previousTaskDb === undefined) delete process.env.ATRIS_TASKS_DB;
      else process.env.ATRIS_TASKS_DB = previousTaskDb;
    }

    const legacyPage = runCli(['task', 'page', legacyRef, '--json'], { cwd: dir, env });
    assert.equal(legacyPage.status, 0, legacyPage.stderr);
    const legacyContract = JSON.parse(legacyPage.stdout).page;
    assert.equal(legacyContract.task.status, 'done');
    assert.equal(legacyContract.stage.current, 'review');
    assert.equal(legacyContract.stage.next_action.key, 'review');
    assert.match(legacyContract.stage.next_action.command, new RegExp(`atris task review ${legacyRef}`));
    assert.match(legacyContract.stage.next_action.command, /--reward 0/);
    assert.equal(legacyContract.review.verification_chat, null);
    assert.equal(legacyContract.review.human_accept.enabled, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task step advances one safe headless action and never human-accepts', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Drive task loop from a single headless step', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const missingGoal = runCli(['task', 'step', ref, '--exit', 'needs a goal first', '--proof-needed', 'node --check missing goal coverage passes', '--json'], { cwd: dir, env });
    assert.equal(missingGoal.status, 2);
    const missingGoalPayload = JSON.parse(missingGoal.stdout);
    assert.equal(missingGoalPayload.reason, 'goal_required');
    assert.equal(missingGoalPayload.page.stage.current, 'backlog');
    assert.equal(missingGoalPayload.page.stage.next_action.key, 'plan');

    const planned = runCli([
      'task', 'step', ref,
      'Narrow this task before planning',
      '--goal', 'Drive one task through Plan Do Review from step',
      '--summary', 'chat narrowed the task before plan',
      '--exit', 'step returns a Do-ready page',
      '--proof-needed', 'node --check test/commands.test.js passes task step coverage',
      '--json',
    ], { cwd: dir, env });
    assert.equal(planned.status, 0, planned.stderr);
    const plannedPayload = JSON.parse(planned.stdout);
    assert.equal(plannedPayload.action, 'stepped');
    assert.equal(plannedPayload.step_action, 'planned');
    assert.equal(plannedPayload.chat.action, 'chatted');
    assert.equal(plannedPayload.page.schema, 'atris.task_page.v1');
    assert.equal(plannedPayload.page.stage.current, 'plan');
    assert.equal(plannedPayload.page.stage.next_action.key, 'do');
    assert.equal(plannedPayload.page.goal.text, 'Drive one task through Plan Do Review from step');
    assert.match(plannedPayload.page.actions.step_command, new RegExp(`atris task step ${ref} --json`));
    assert.equal(plannedPayload.page.api.step, `/api/tasks/${plannedPayload.task.id}/step`);

    const doing = runCli(['task', 'step', ref, '--as', 'codex', '--first-move', 'run the headless step test', '--json'], { cwd: dir, env });
    assert.equal(doing.status, 0, doing.stderr);
    const doingPayload = JSON.parse(doing.stdout);
    assert.equal(doingPayload.step_action, 'doing');
    assert.equal(doingPayload.page.stage.current, 'do');
    assert.equal(doingPayload.task.status, 'claimed');

    const weakReady = runCli(['task', 'step', ref, '--proof', 'done', '--json'], { cwd: dir, env });
    assert.equal(weakReady.status, 2);
    const weakReadyPayload = JSON.parse(weakReady.stdout);
    assert.equal(weakReadyPayload.reason, 'weak_proof');
    assert.equal(weakReadyPayload.page.stage.current, 'do');

    const ready = runCli([
      'task', 'step', ref,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed for task step ready',
      '--lesson', 'Step keeps XP behind human accept',
      '--next', 'Use step from the task page UI later',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.step_action, 'ready');
    assert.equal(readyPayload.page.stage.current, 'review');
    assert.equal(readyPayload.page.stage.next_action.key, 'review_chat');
    assert.equal(readyPayload.handoff.next_action, 'agent_review_again');
    assert.equal(readyPayload.page.review.human_accept.enabled, true);
    assert.notEqual(readyPayload.page.stage.next_action.command, readyPayload.page.review.human_accept.command);

    const reviewChat = runCli(['task', 'step', ref, '--reviewer', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(reviewChat.status, 0, reviewChat.stderr);
    const reviewChatPayload = JSON.parse(reviewChat.stdout);
    assert.equal(reviewChatPayload.step_action, 'review_chat');
    assert.equal(reviewChatPayload.contract.schema, 'atris.task_review_chat.v1');
    assert.match(reviewChatPayload.contract.codex_prompt, /\/codex review/);
    assert.ok(reviewChatPayload.page.chat.recent_messages.some(message => message.content.includes('TASK_REVIEW_CHAT')));
    assert.equal(reviewChatPayload.page.task.status, 'review');
    assert.equal(reviewChatPayload.page.review.human_accept.enabled, true);

    const certify = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', 'node --test test/commands.test.js passed during certified step regression',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certify.status, 0, certify.stderr);
    const certifiedStep = runCli(['task', 'step', ref, '--json'], { cwd: dir, env });
    assert.equal(certifiedStep.status, 1);
    const certifiedStepPayload = JSON.parse(certifiedStep.stdout);
    assert.equal(certifiedStepPayload.reason, 'agent_certified_continue_work');
    assert.equal(certifiedStepPayload.page.stage.next_action.key, 'continue_work');
    assert.equal(certifiedStepPayload.page.stage.next_action.command, `atris task continue-work ${ref} --as codex --json`);
    assert.equal(certifiedStepPayload.page.review.human_accept.enabled, true);
    assert.equal(certifiedStepPayload.page.review.verification_chat.schema, 'atris.task_review_chat.v1');

    const certifiedMessageStep = runCli([
      'task', 'step', ref,
      'should not write to certified review',
      '--goal', 'Certified review should not be refined by step',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certifiedMessageStep.status, 1);
    const certifiedMessagePayload = JSON.parse(certifiedMessageStep.stdout);
    assert.equal(certifiedMessagePayload.reason, 'agent_certified_continue_work');

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const shownTask = JSON.parse(show.stdout);
    assert.equal(shownTask.status, 'review');
    assert.equal(shownTask.metadata.task_goal, 'Drive one task through Plan Do Review from step');
    assert.equal(shownTask.messages.some(message => message.content.includes('should not write to certified review')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task current-step advances the scoped current task one safe action', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewAdd = runCli(['task', 'add', 'Unrelated review debt stays global', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(reviewAdd.status, 0, reviewAdd.stderr);
    const reviewTask = JSON.parse(reviewAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', reviewTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', reviewTask.display_id,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed for unrelated review debt',
    ], { cwd: dir, env }).status, 0);

    const scopedAdd = runCli([
      'task', 'add', 'Scoped current step task',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedAdd.status, 0, scopedAdd.stderr);
    const scopedTask = JSON.parse(scopedAdd.stdout).task;
    const scopedPlan = runCli([
      'task', 'plan', scopedTask.display_id,
      '--as', 'codex',
      '--goal', 'Advance the scoped current task',
      '--exit', 'current-step can start the task from Plan',
      '--proof-needed', 'node --test test/commands.test.js passes current-step coverage',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedPlan.status, 0, scopedPlan.stderr);

    const unscopedCurrent = runCli(['task', 'current', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(unscopedCurrent.status, 0, unscopedCurrent.stderr);
    const unscopedPayload = JSON.parse(unscopedCurrent.stdout);
    assert.equal(unscopedPayload.current.selected_task_id, reviewTask.id);
    assert.equal(unscopedPayload.current.selected_reason, 'review_needs_agent_verification');

    const doing = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-928',
      '--as', 'codex',
      '--first-move', 'run the scoped current-step test',
      '--json',
      '--full',
    ], { cwd: dir, env });
    assert.equal(doing.status, 0, doing.stderr);
    const doingPayload = JSON.parse(doing.stdout);
    assert.equal(doingPayload.action, 'current_step');
    assert.equal(doingPayload.selected_ref, scopedTask.display_id);
    assert.equal(doingPayload.selected_next_key, doingPayload.before_current.next.key);
    assert.equal(doingPayload.before_current.scope.goal_id, 'OBL-928');
    assert.equal(doingPayload.before_current.selected_task_id, scopedTask.id);
    assert.equal(doingPayload.before_current.selected_ref, scopedTask.display_id);
    assert.equal(doingPayload.before_current.selected_reason, 'plan_ready');
    assert.equal(doingPayload.step.step_action, 'doing');
    assert.equal(doingPayload.step.task.id, scopedTask.id);
    assert.equal(doingPayload.page.stage.current, 'do');
    assert.equal(doingPayload.after_current.selected_task_id, scopedTask.id);
    assert.equal(doingPayload.after_current.selected_ref, scopedTask.display_id);
    assert.equal(doingPayload.after_current.selected_reason, 'claimed_by_owner');
    assert.equal(doingPayload.after.current.selected_task_id, scopedTask.id);
    assert.equal(doingPayload.after.page.stage.current, 'do');
    assert.equal(doingPayload.current.selected_reason, 'claimed_by_owner');
    assert.equal(doingPayload.safety.read_only, false);
    assert.equal(doingPayload.safety.claims_work, true);
    assert.equal(doingPayload.safety.human_accept, false);

    const ready = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-928',
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed for current-step ready',
      '--result', FIXTURE_RESULT_SENTENCE,
      '--lesson', 'current-step keeps current and step contracts together',
      '--next', 'Use current-step from the mission runner',
      '--json',
      '--full',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.selected_task_id, scopedTask.id);
    assert.equal(readyPayload.selected_ref, scopedTask.display_id);
    assert.equal(readyPayload.selected_next_key, readyPayload.before_current.next.key);
    assert.equal(readyPayload.step.step_action, 'ready');
    assert.equal(readyPayload.current.selected_task_id, scopedTask.id);
    assert.equal(readyPayload.current.selected_ref, scopedTask.display_id);
    assert.equal(readyPayload.current.next.key, 'review_chat');
    assert.equal(readyPayload.after_current.selected_task_id, scopedTask.id);
    assert.equal(readyPayload.after_current.next.key, 'review_chat');
    assert.equal(readyPayload.after.current.next.key, 'review_chat');
    assert.equal(readyPayload.page.review.human_accept.enabled, true);
    assert.equal(readyPayload.safety.human_accept, false);

    const reviewChat = runCli(['task', 'current-step', '--goal-id', 'OBL-928', '--reviewer', 'codex-review', '--json', '--full'], { cwd: dir, env });
    assert.equal(reviewChat.status, 0, reviewChat.stderr);
    const reviewChatPayload = JSON.parse(reviewChat.stdout);
    assert.equal(reviewChatPayload.step.step_action, 'review_chat');
    assert.equal(reviewChatPayload.step.contract.schema, 'atris.task_review_chat.v1');
    assert.match(reviewChatPayload.step.contract.codex_prompt, /\/codex review/);
    assert.ok(reviewChatPayload.page.chat.recent_messages.some(message => message.content.includes('TASK_REVIEW_CHAT')));
    assert.equal(reviewChatPayload.page.review.human_accept.enabled, true);
    assert.equal(reviewChatPayload.safety.human_accept, false);

    const reviewShow = runCli(['task', 'show', reviewTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(reviewShow.status, 0, reviewShow.stderr);
    assert.equal(JSON.parse(reviewShow.stdout).messages.some(message => message.content.includes('TASK_REVIEW_CHAT')), false);
    const scopedShow = runCli(['task', 'show', scopedTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(scopedShow.status, 0, scopedShow.stderr);
    const scopedDetail = JSON.parse(scopedShow.stdout);
    assert.equal(scopedDetail.status, 'review');
    assert.equal(scopedDetail.review.approval_status, 'pending');
    assert.ok(scopedDetail.messages.some(message => message.content.includes('TASK_REVIEW_CHAT')));

    const continueAdd = runCli([
      'task', 'add', 'Current-step certified continuation parent',
      '--tag', 'task',
      '--goal-id', 'OBL-931',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueAdd.status, 0, continueAdd.stderr);
    const continueTask = JSON.parse(continueAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', continueTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', continueTask.display_id,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before current-step continue-work',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueTask.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during current-step continue-work review',
      '--next', 'Current-step continuation child',
    ], { cwd: dir, env }).status, 0);

    const waitingAdd = runCli([
      'task', 'add', 'Current-step waits for human accept only',
      '--tag', 'task',
      '--goal-id', 'OBL-931',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingAdd.status, 0, waitingAdd.stderr);
    const waitingTask = JSON.parse(waitingAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', waitingTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', waitingTask.display_id,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before current-step human wait',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingTask.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during current-step human wait review',
    ], { cwd: dir, env }).status, 0);

    const continueStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-931',
      '--review-state', 'continue-work',
      '--as', 'codex',
      '--json',
      '--full',
    ], { cwd: dir, env });
    assert.equal(continueStep.status, 0, continueStep.stderr);
    const continueStepPayload = JSON.parse(continueStep.stdout);
    assert.equal(continueStepPayload.before_current.scope.review_state, 'continue-work');
    assert.equal(continueStepPayload.before_current.selected_task_id, continueTask.id);
    assert.equal(continueStepPayload.selected_ref, continueTask.display_id);
    assert.equal(continueStepPayload.selected_next_key, 'continue_work');
    assert.equal(continueStepPayload.before_current.selected_ref, continueTask.display_id);
    assert.equal(continueStepPayload.before_current.next.key, 'continue_work');
    assert.equal(continueStepPayload.step.step_action, 'continue_work');
    assert.equal(continueStepPayload.step.continue_work.action, 'continue_work');
    assert.equal(continueStepPayload.step.continue_work.parent_task_id, continueTask.id);
    assert.equal(continueStepPayload.step.continue_work.created, true);
    assert.equal(continueStepPayload.step.next_task.title, 'Current-step continuation child');
    assert.equal(continueStepPayload.page.task.id, continueStepPayload.step.next_task.id);
    assert.equal(continueStepPayload.safety.human_accept, false);
    assert.equal(continueStepPayload.safety.claims_work, false);
    const continueParentShow = runCli(['task', 'show', continueTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(continueParentShow.status, 0, continueParentShow.stderr);
    const continueParentDetail = JSON.parse(continueParentShow.stdout);
    assert.equal(continueParentDetail.status, 'review');
    assert.equal(continueParentDetail.review.approval_status, 'pending');

    const waitingStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-931',
      '--review-state', 'human-accept-waiting',
      '--as', 'codex',
      '--json',
      '--full',
    ], { cwd: dir, env });
    assert.notEqual(waitingStep.status, 0);
    const waitingStepPayload = JSON.parse(waitingStep.stdout);
    assert.equal(waitingStepPayload.reason, 'agent_certified_waiting_human');
    assert.equal(waitingStepPayload.selected_ref, waitingTask.display_id);
    assert.equal(waitingStepPayload.selected_next_key, 'human_accept_waiting');
    assert.equal(waitingStepPayload.current.selected_task_id, waitingTask.id);
    assert.equal(waitingStepPayload.current.selected_ref, waitingTask.display_id);
    assert.equal(waitingStepPayload.current.next.key, 'human_accept_waiting');
    assert.equal(waitingStepPayload.page.stage.next_action.command, null);
    assert.equal(waitingStepPayload.page.stage.next_action.api, null);
    const waitingShow = runCli(['task', 'show', waitingTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(waitingShow.status, 0, waitingShow.stderr);
    const waitingDetail = JSON.parse(waitingShow.stdout);
    assert.equal(waitingDetail.status, 'review');
    assert.equal(waitingDetail.review.approval_status, 'pending');

    const otherAdd = runCli([
      'task', 'add', 'Other owner scoped task stays untouched',
      '--tag', 'task',
      '--goal-id', 'OBL-929',
      '--json',
    ], { cwd: dir, env });
    assert.equal(otherAdd.status, 0, otherAdd.stderr);
    const otherTask = JSON.parse(otherAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', otherTask.display_id, '--as', 'other-agent'], { cwd: dir, env }).status, 0);
    const otherStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-929',
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed without touching other owner work',
      '--json',
      '--full',
    ], { cwd: dir, env });
    assert.notEqual(otherStep.status, 0);
    const otherPayload = JSON.parse(otherStep.stdout);
    assert.equal(otherPayload.reason, 'claimed_by_other');
    assert.equal(otherPayload.selected_ref, otherTask.display_id);
    assert.equal(otherPayload.selected_next_key, otherPayload.current.next.key);
    assert.equal(otherPayload.current.selected_task_id, otherTask.id);
    assert.equal(otherPayload.current.selected_ref, otherTask.display_id);
    assert.equal(otherPayload.current.selected_reason, 'active_do_elsewhere');
    const otherShow = runCli(['task', 'show', otherTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(otherShow.status, 0, otherShow.stderr);
    const otherDetail = JSON.parse(otherShow.stdout);
    assert.equal(otherDetail.status, 'claimed');
    assert.equal(otherDetail.claimed_by, 'other-agent');

    const otherReviewAdd = runCli([
      'task', 'add', 'Other owner review task stays untouched',
      '--tag', 'task',
      '--goal-id', 'OBL-930',
      '--json',
    ], { cwd: dir, env });
    assert.equal(otherReviewAdd.status, 0, otherReviewAdd.stderr);
    const otherReviewTask = JSON.parse(otherReviewAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', otherReviewTask.display_id, '--as', 'other-agent'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', otherReviewTask.display_id,
      '--as', 'other-agent',
      '--proof', 'node --check test/commands.test.js passed before other owner review',
    ], { cwd: dir, env }).status, 0);
    const otherReviewStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-930',
      '--as', 'codex',
      '--reviewer', 'codex-review',
      '--json',
      '--full',
    ], { cwd: dir, env });
    assert.notEqual(otherReviewStep.status, 0);
    const otherReviewPayload = JSON.parse(otherReviewStep.stdout);
    assert.equal(otherReviewPayload.reason, 'claimed_by_other');
    assert.equal(otherReviewPayload.current.selected_task_id, otherReviewTask.id);
    assert.equal(otherReviewPayload.current.selected_reason, 'review_needs_agent_verification');
    const otherReviewShow = runCli(['task', 'show', otherReviewTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(otherReviewShow.status, 0, otherReviewShow.stderr);
    const otherReviewDetail = JSON.parse(otherReviewShow.stdout);
    assert.equal(otherReviewDetail.status, 'review');
    assert.equal(otherReviewDetail.claimed_by, 'other-agent');
    assert.equal(otherReviewDetail.messages.some(message => message.content.includes('TASK_REVIEW_CHAT')), false);
  } finally {
    cleanupTempDir(dir);
  }
});
