// Part 7 of 8 of the commands suite, split so node --test runs them in parallel.
// Shared imports and fixture helpers live in test/helpers/commands-fixtures.js.
const test = require('node:test');
const {
  assert,
  fs,
  path,
  http,
  spawn,
  spawnSync,
  ensureWikiScaffold,
  analyzeBusinessDoctor,
  businessMatchesSlug,
  getVerifyCommand,
  getRecentSignals,
  renderHumanSuggestion,
  renderHumanTickIntro,
  repoRoot,
  cliPath,
  makeTempDir,
  cleanupTempDir,
  runCli,
  hasNodeSqlite,
  waitForOutput,
  runGit,
  initWorkspace,
  writeTodayLog,
} = require('./helpers/commands-fixtures');

test('task serve exposes a local task factory API', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = ready.match[1];

	    const html = await fetch(base).then(r => r.text());
	    assert.match(html, /Atris Task Factory/);
	    // heartbeat strip + live activity stream (replaced the old smoke placeholder)
	    assert.match(html, /class="beat" id="heartbeat"/);
	    assert.match(html, /class="activity" id="activity"/);
	    assert.match(html, /async function loadStream\(\)/);
	    assert.match(html, /\/api\/tasks\/' \+ task\.id \+ '\/ready/);
	    assert.match(html, /\/api\/tasks\/' \+ task\.id \+ '\/accept/);
	    assert.match(html, /if \(lesson\) payload\.lesson = lesson/);
	    assert.match(html, /if \(nextTask\) payload\.next = nextTask/);
	    assert.match(html, /task\.review && task\.review\.next_task/);
	    assert.doesNotMatch(html, /\/api\/tasks\/' \+ task\.id \+ '\/finish/);

    // the activity stream endpoint returns a heartbeat + an events array
    const stream = await fetch(`${base}/api/stream`).then(r => r.json());
    assert.equal(stream.ok, true);
    assert.ok(stream.heartbeat && typeof stream.heartbeat.state === 'string');
    assert.ok(Array.isArray(stream.events));

    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Ship the task factory board', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(created.ok, true);
    assert.equal(created.task.title, 'Ship the task factory board');

    const claimed = await fetch(`${base}/api/tasks/${created.task_id.slice(0, 8)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'swarlo' }),
    }).then(r => r.json());
    assert.equal(claimed.ok, true);
    assert.equal(claimed.task.claimed_by, 'swarlo');

	    const noted = await fetch(`${base}/api/tasks/${created.task_id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', content: 'Looks good in the board' }),
    }).then(r => r.json());
	    assert.equal(noted.ok, true);
	    assert.equal(noted.task.messages[0].content, 'Looks good in the board');

	    const missingFinishProofResponse = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'operator' }),
	    });
	    assert.equal(missingFinishProofResponse.status, 400);
	    const missingFinishProof = await missingFinishProofResponse.json();
	    assert.equal(missingFinishProof.reason, 'proof_required');

	    const weakFinishProofResponse = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'operator', proof: 'done' }),
	    });
	    assert.equal(weakFinishProofResponse.status, 400);
	    const weakFinishProof = await weakFinishProofResponse.json();
	    assert.equal(weakFinishProof.reason, 'weak_proof');

	    const finished = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'operator',
	        proof: 'node --test test/commands.test.js passed for task serve API',
	        lesson: 'Task factory API can drive the board',
	        next: 'Connect the board to Swarlo leases',
	        createNext: true,
      }),
    }).then(r => r.json());
    assert.equal(finished.ok, true);
    assert.equal(finished.task.status, 'done');
    assert.equal(finished.episode.career_xp.eligible, false);
    assert.equal(finished.xp_projection.total_xp, 0);
    assert.ok(finished.next_task_id);

    const apiReview = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reject stale API proof after revise', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiReview.ok, true);
    const apiReviewId = apiReview.task_id;
    const earlyApiReviewChatResponse = await fetch(`${base}/api/tasks/${apiReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    });
    assert.equal(earlyApiReviewChatResponse.status, 409);
    assert.equal((await earlyApiReviewChatResponse.json()).reason, 'not_reviewable_open');

    const apiStage = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Drive plan do review through API', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiStage.ok, true);
    const apiStageId = apiStage.task_id;

    const apiChatTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Refine API task chat', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiChatTask.ok, true);
    const apiEmptyChatResponse = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator' }),
    });
    assert.equal(apiEmptyChatResponse.status, 400);
    assert.equal((await apiEmptyChatResponse.json()).reason, 'content_required');
    const apiChat = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'operator',
        content: 'Make this task useful before planning',
        goal: 'API chat seeds the task goal',
        summary: 'chat narrowed the task',
      }),
    }).then(r => r.json());
    assert.equal(apiChat.ok, true);
    assert.equal(apiChat.action, 'chatted');
    assert.equal(apiChat.task.objective, 'API chat seeds the task goal');
    assert.equal(apiChat.task.metadata.task_goal, 'API chat seeds the task goal');
    assert.ok(apiChat.task.messages.some(message => message.content.includes('TASK_CHAT_UPDATE')));
    const apiChatPlan = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        exit: 'API chat plan can use the refined goal',
        proof_needed: 'node --test API chat coverage passes',
      }),
    }).then(r => r.json());
    assert.equal(apiChatPlan.ok, true);
    assert.match(apiChatPlan.stage_packet, /goal: API chat seeds the task goal/);
    const apiChatBacklog = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/backlog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', reason: 'preserve task goal while clearing plan' }),
    }).then(r => r.json());
    assert.equal(apiChatBacklog.ok, true);
    assert.equal(apiChatBacklog.task.metadata.task_goal, 'API chat seeds the task goal');
    assert.equal(apiChatBacklog.task.metadata.goal_objective, undefined);

    const apiStepTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Drive API task step', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiStepTask.ok, true);
    const apiStepPlanned = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        message: 'Refine this API step task before plan',
        goal: 'API step drives Plan Do Review',
        summary: 'step includes chat before plan',
        exit: 'API step returns the next page action',
        proof_needed: 'node --test test/commands.test.js passes API step coverage',
      }),
    }).then(r => r.json());
    assert.equal(apiStepPlanned.ok, true);
    assert.equal(apiStepPlanned.action, 'stepped');
    assert.equal(apiStepPlanned.step_action, 'planned');
    assert.equal(apiStepPlanned.chat.action, 'chatted');
    assert.equal(apiStepPlanned.page.stage.current, 'plan');
    assert.equal(apiStepPlanned.page.stage.next_action.key, 'do');
    assert.equal(apiStepPlanned.page.api.step, `/api/tasks/${apiStepTask.task_id}/step`);

    const apiStepDoing = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'run API step smoke' }),
    }).then(r => r.json());
    assert.equal(apiStepDoing.ok, true);
    assert.equal(apiStepDoing.step_action, 'doing');
    assert.equal(apiStepDoing.page.stage.current, 'do');

    const apiStepReady = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed for API task step',
        lesson: 'API step keeps accept human-only',
      }),
    }).then(r => r.json());
    assert.equal(apiStepReady.ok, true);
    assert.equal(apiStepReady.step_action, 'ready');
    assert.equal(apiStepReady.page.stage.current, 'review');
    assert.equal(apiStepReady.page.stage.next_action.key, 'review_chat');
    assert.notEqual(apiStepReady.page.stage.next_action.command, apiStepReady.page.review.human_accept.command);

    const apiStepReviewChat = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer: 'codex-review' }),
    }).then(r => r.json());
	    assert.equal(apiStepReviewChat.ok, true);
	    assert.equal(apiStepReviewChat.step_action, 'review_chat');
	    assert.equal(apiStepReviewChat.contract.schema, 'atris.task_review_chat.v1');
	    assert.equal(apiStepReviewChat.page.task.status, 'review');

	    const apiScopedAdd = runCli([
	      'task', 'add', 'Scoped API current task',
	      '--tag', 'api-scope',
	      '--goal-id', 'OBL-928',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiScopedAdd.status, 0, apiScopedAdd.stderr);
	    const apiScopedTask = JSON.parse(apiScopedAdd.stdout).task;

	    const apiCurrent = await fetch(`${base}/api/tasks/current?owner=codex&reviewer=codex-review`).then(r => r.json());
	    assert.equal(apiCurrent.ok, true);
	    assert.equal(apiCurrent.action, 'current');
	    assert.equal(apiCurrent.current.schema, 'atris.task_current.v1');
	    assert.equal(apiCurrent.current.safety.read_only, true);
	    assert.equal(apiCurrent.current.safety.claims_work, false);
	    assert.equal(apiCurrent.current.safety.human_accept, false);
	    assert.equal(apiCurrent.current.selected_task_id, apiStepTask.task_id);
	    assert.equal(apiCurrent.page.stage.current, 'review');
	    assert.equal(apiCurrent.current.next.key, 'review_chat');
	    assert.equal(apiCurrent.current.next.step_api, `/api/tasks/${apiStepTask.task_id}/step`);
	    assert.equal(apiCurrent.queue.schema, 'atris.task_queue.v1');
	    assert.ok(apiCurrent.queue.counts.review >= 1);

	    const apiCapabilities = await fetch(`${base}/api/tasks/capabilities`).then(r => r.json());
	    assert.equal(apiCapabilities.ok, true);
	    assert.equal(apiCapabilities.action, 'capabilities');
	    assert.deepEqual(apiCapabilities.capabilities, apiCurrent.current.capabilities);
	    assert.equal(apiCapabilities.safety.read_only, true);
	    assert.equal(apiCapabilities.safety.claims_work, false);
	    assert.equal(apiCapabilities.safety.human_accept, false);
	    assert.equal(apiCapabilities.safety.xp_after_human_accept, true);
	    assert.equal(apiCapabilities.projection_path, undefined);

	    const apiCapabilitiesCheck = await fetch(`${base}/api/tasks/capabilities/check?owner=codex`).then(r => r.json());
	    assert.equal(apiCapabilitiesCheck.ok, true);
	    assert.equal(apiCapabilitiesCheck.action, 'capabilities_check');
	    assert.equal(apiCapabilitiesCheck.schema, 'atris.task_capabilities_check.v1');
	    assert.deepEqual(apiCapabilitiesCheck.capabilities, apiCurrent.current.capabilities);
	    assert.equal(apiCapabilitiesCheck.summary.failed, 0);
	    assert.equal(apiCapabilitiesCheck.safety.mutates_task_db, false);
	    assert.equal(apiCapabilitiesCheck.safety.writes_projection, true);
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'current_queue_capabilities_match' && check.ok));
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'read_only_projection_semantics_declared' && check.ok));
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'capabilities_check_surface_declared' && check.ok));

	    assert.equal(runCli(['task', 'claim', apiScopedTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    const apiScopedCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-928`).then(r => r.json());
	    assert.equal(apiScopedCurrent.ok, true);
	    assert.equal(apiScopedCurrent.current.scope.goal_id, 'OBL-928');
	    assert.equal(apiScopedCurrent.current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiScopedCurrent.current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiScopedCurrent.queue.counts.total, 1);
	    assert.equal(apiScopedCurrent.queue.counts.review, 0);
	    assert.equal(apiScopedCurrent.page.task.ref, apiScopedTask.display_id);

	    const apiScopedQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-928&tag=api-scope`).then(r => r.json());
	    assert.equal(apiScopedQueue.ok, true);
	    assert.equal(apiScopedQueue.queue.scope.goal_id, 'OBL-928');
	    assert.equal(apiScopedQueue.queue.scope.tag, 'api-scope');
	    assert.equal(apiScopedQueue.queue.counts.total, 1);
	    assert.equal(apiScopedQueue.queue.columns.find(column => column.key === 'do').items[0].id, apiScopedTask.id);

	    const apiStatusCurrent = await fetch(`${base}/api/tasks/current?status=review&review_state=needs-agent`).then(r => r.json());
		    assert.equal(apiStatusCurrent.ok, true);
		    assert.equal(apiStatusCurrent.current.scope.status, 'review');
		    assert.equal(apiStatusCurrent.current.scope.review_state, 'needs-agent');
			    assert.equal(apiStatusCurrent.current.selected_task_id, apiStepTask.task_id);
			    assert.equal(apiStatusCurrent.current.next.key, 'review_chat');
			    assert.equal(apiStatusCurrent.selected.continue_work_command, undefined);
			    assert.equal(apiStatusCurrent.selected.commands.continue_work, undefined);
			    assert.deepEqual(apiStatusCurrent.current.capabilities, apiStatusCurrent.queue.capabilities);
			    assert.equal(apiStatusCurrent.current.capabilities.schema, 'atris.task_capabilities.v1');
			    assert.deepEqual(apiStatusCurrent.current.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.lanes['needs-agent'].step_action, 'review_chat');
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.safety.claims_work, 'conditional');
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.stage_safety.plan.claims_work, true);
			    assert.equal(apiStatusCurrent.current.review_state_counts.active_filter, 'needs-agent');
			    assert.equal(apiStatusCurrent.current.review_state_counts.scope.status, 'review');
			    assert.equal(apiStatusCurrent.current.review_state_counts.scope.review_state, null);
		    assert.equal(apiStatusCurrent.current.review_state_counts.total, 1);
		    assert.equal(apiStatusCurrent.current.review_state_counts.needs_agent, 1);
		    assert.deepEqual(apiStatusCurrent.current.review_state_actions, apiStatusCurrent.queue.review_state_actions);
		    assert.equal(apiStatusCurrent.current.review_state_actions.active_filter, 'needs-agent');
		    assert.equal(apiStatusCurrent.current.review_state_actions.scope.status, 'review');
		    assert.equal(apiStatusCurrent.current.review_state_actions.scope.review_state, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.needs_agent, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat_count, 1);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].id, apiStepTask.task_id);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].next_action, 'pending_review_chat');
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].command, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].api, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.continue_work, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.human_accept_waiting, null);

		    const apiNeedsAgentQueue = await fetch(`${base}/api/tasks/queue?status=review&review_state=needs-agent`).then(r => r.json());
		    assert.equal(apiNeedsAgentQueue.ok, true);
		    assert.equal(apiNeedsAgentQueue.action, 'queue');
		    assert.equal(apiNeedsAgentQueue.current.scope.status, 'review');
		    assert.equal(apiNeedsAgentQueue.current.scope.review_state, 'needs-agent');
		    assert.equal(apiNeedsAgentQueue.current.selected_task_id, apiStepTask.task_id);
		    assert.equal(apiNeedsAgentQueue.current.next.key, 'review_chat');
		    assert.equal(apiNeedsAgentQueue.queue.scope.status, 'review');
		    assert.equal(apiNeedsAgentQueue.queue.scope.review_state, 'needs-agent');
		    assert.equal(apiNeedsAgentQueue.queue.counts.total, 1);
		    assert.equal(apiNeedsAgentQueue.queue.counts.review, 1);
		    assert.deepEqual(apiNeedsAgentQueue.current.review_state_counts, apiNeedsAgentQueue.queue.review_state_counts);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_counts.total, 1);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_counts.needs_agent, 1);
		    assert.deepEqual(apiNeedsAgentQueue.current.review_state_actions, apiNeedsAgentQueue.queue.review_state_actions);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.active_filter, 'needs-agent');
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.needs_agent, null);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat_count, 1);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].id, apiStepTask.task_id);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].next_action, 'pending_review_chat');
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].command, null);
		    const apiNeedsAgentItem = apiNeedsAgentQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiNeedsAgentItem.id, apiStepTask.task_id);
		    assert.equal(apiNeedsAgentItem.continue_work_command, undefined);
		    assert.equal(apiNeedsAgentItem.commands.continue_work, undefined);

	    const apiContinueCreated = runCli([
	      'task', 'add', 'API certified task with continuation action',
	      '--tag', 'api-review-state',
	      '--goal-id', 'OBL-934',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiContinueCreated.status, 0, apiContinueCreated.stderr);
	    const apiContinueTask = JSON.parse(apiContinueCreated.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiContinueTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiContinueTask.display_id,
	      '--as', 'codex',
	      '--proof', 'node --check test/commands.test.js passed before API continue-work filter',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'review', apiContinueTask.display_id,
	      '--reward', '0',
	      '--as', 'codex-review',
	      '--proof', 'node --test test/commands.test.js passed during API continue-work filter',
	      '--next', 'Run the API continuation follow-up',
	    ], { cwd: dir, env }).status, 0);

	    const apiWaitingCreated = runCli([
	      'task', 'add', 'API certified task waiting for human accept',
	      '--tag', 'api-review-state',
	      '--goal-id', 'OBL-934',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiWaitingCreated.status, 0, apiWaitingCreated.stderr);
	    const apiWaitingTask = JSON.parse(apiWaitingCreated.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiWaitingTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiWaitingTask.display_id,
	      '--as', 'codex',
	      '--proof', 'node --check test/commands.test.js passed before API human-accept filter',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'review', apiWaitingTask.display_id,
	      '--reward', '0',
	      '--as', 'codex-review',
	      '--proof', 'node --test test/commands.test.js passed during API human-accept filter',
	    ], { cwd: dir, env }).status, 0);

	    const apiContinueCommand = `atris task continue-work ${apiContinueTask.display_id} --as codex --json`;
	    const apiContinueCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=continue-work`).then(r => r.json());
	    assert.equal(apiContinueCurrent.ok, true);
	    assert.equal(apiContinueCurrent.current.scope.goal_id, 'OBL-934');
	    assert.equal(apiContinueCurrent.current.scope.review_state, 'continue-work');
	    assert.equal(apiContinueCurrent.current.selected_task_id, apiContinueTask.id);
	    assert.equal(apiContinueCurrent.current.next.key, 'continue_work');
	    assert.equal(apiContinueCurrent.current.next.command, apiContinueCommand);
	    assert.deepEqual(apiContinueCurrent.current.next.api, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
	    assert.equal(apiContinueCurrent.selected.continue_work_command, apiContinueCommand);
		    assert.deepEqual(apiContinueCurrent.selected.api.next_action, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
		    assert.equal(apiContinueCurrent.current.safety.read_only, true);
		    assert.equal(apiContinueCurrent.current.safety.human_accept, false);
		    assert.deepEqual(apiContinueCurrent.current.capabilities, apiContinueCurrent.queue.capabilities);
		    assert.equal(apiContinueCurrent.current.capabilities.current_step.lanes['continue-work'].creates_or_reuses_follow_up, true);
		    assert.equal(apiContinueCurrent.current.capabilities.current_step.lanes['human-accept-waiting'].reason, 'agent_certified_waiting_human');
		    assert.equal(apiContinueCurrent.current.review_state_counts.active_filter, 'continue-work');
		    assert.equal(apiContinueCurrent.current.review_state_counts.scope.goal_id, 'OBL-934');
		    assert.equal(apiContinueCurrent.current.review_state_counts.scope.review_state, null);
	    assert.equal(apiContinueCurrent.current.review_state_counts.total, 2);
	    assert.equal(apiContinueCurrent.current.review_state_counts.continue_work, 1);
	    assert.equal(apiContinueCurrent.current.review_state_counts.human_accept_waiting, 1);
	    assert.equal(apiContinueCurrent.current.review_state_counts.certified, 2);
	    assert.deepEqual(apiContinueCurrent.current.review_state_actions, apiContinueCurrent.queue.review_state_actions);
	    assert.equal(apiContinueCurrent.current.review_state_actions.active_filter, 'continue-work');
	    assert.equal(apiContinueCurrent.current.review_state_actions.scope.goal_id, 'OBL-934');
	    assert.equal(apiContinueCurrent.current.review_state_actions.scope.review_state, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.next_action, 'continue_work');
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.command, apiContinueCommand);
	    assert.deepEqual(apiContinueCurrent.current.review_state_actions.continue_work.api, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.continue_work_command, apiContinueCommand);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.command, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.api, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.human_accept.human_only, true);

		    const apiContinueQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=continue-work`).then(r => r.json());
		    assert.equal(apiContinueQueue.ok, true);
		    assert.equal(apiContinueQueue.action, 'queue');
		    assert.equal(apiContinueQueue.current.scope.review_state, 'continue-work');
		    assert.equal(apiContinueQueue.current.selected_task_id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.current.next.key, 'continue_work');
		    assert.equal(apiContinueQueue.current.next.command, apiContinueCommand);
		    assert.equal(apiContinueQueue.queue.scope.review_state, 'continue-work');
		    assert.equal(apiContinueQueue.queue.counts.total, 1);
		    assert.equal(apiContinueQueue.queue.counts.review, 1);
		    assert.deepEqual(apiContinueQueue.current.review_state_counts, apiContinueQueue.queue.review_state_counts);
		    assert.equal(apiContinueQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiContinueQueue.queue.review_state_counts.continue_work, 1);
		    assert.equal(apiContinueQueue.queue.review_state_counts.human_accept_waiting, 1);
		    assert.deepEqual(apiContinueQueue.current.review_state_actions, apiContinueQueue.queue.review_state_actions);
		    assert.equal(apiContinueQueue.queue.review_state_actions.active_filter, 'continue-work');
		    assert.equal(apiContinueQueue.queue.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.queue.review_state_actions.continue_work.command, apiContinueCommand);
		    assert.equal(apiContinueQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiContinueQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    assert.equal(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].continue_work_command, apiContinueCommand);
		    assert.deepEqual(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].api.next_action, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });

	    const apiWaitingCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=human-accept-waiting`).then(r => r.json());
	    assert.equal(apiWaitingCurrent.ok, true);
	    assert.equal(apiWaitingCurrent.current.scope.review_state, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.selected_task_id, apiWaitingTask.id);
	    assert.equal(apiWaitingCurrent.current.next.key, 'human_accept_waiting');
	    assert.equal(apiWaitingCurrent.current.next.command, null);
	    assert.equal(apiWaitingCurrent.current.next.api, null);
	    assert.equal(apiWaitingCurrent.selected.continue_work_command, undefined);
	    assert.equal(apiWaitingCurrent.selected.commands.continue_work, undefined);
	    assert.equal(apiWaitingCurrent.selected.api.next_action, undefined);
	    assert.equal(apiWaitingCurrent.current.safety.read_only, true);
	    assert.equal(apiWaitingCurrent.current.safety.human_accept, false);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.active_filter, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_counts.total, 2);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.continue_work, 1);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.human_accept_waiting, 1);
	    assert.deepEqual(apiWaitingCurrent.current.review_state_actions, apiWaitingCurrent.queue.review_state_actions);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.active_filter, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.continue_work.command, apiContinueCommand);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.command, null);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.api, null);

		    const apiWaitingQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=human-accept-waiting`).then(r => r.json());
		    assert.equal(apiWaitingQueue.ok, true);
		    assert.equal(apiWaitingQueue.action, 'queue');
		    assert.equal(apiWaitingQueue.current.scope.review_state, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiWaitingQueue.current.next.key, 'human_accept_waiting');
		    assert.equal(apiWaitingQueue.current.next.command, null);
		    assert.equal(apiWaitingQueue.queue.scope.review_state, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.queue.counts.total, 1);
		    assert.equal(apiWaitingQueue.queue.counts.review, 1);
		    assert.deepEqual(apiWaitingQueue.current.review_state_counts, apiWaitingQueue.queue.review_state_counts);
		    assert.equal(apiWaitingQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiWaitingQueue.queue.review_state_counts.certified, 2);
		    assert.deepEqual(apiWaitingQueue.current.review_state_actions, apiWaitingQueue.queue.review_state_actions);
		    assert.equal(apiWaitingQueue.queue.review_state_actions.active_filter, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiWaitingQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    const apiWaitingItem = apiWaitingQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiWaitingItem.id, apiWaitingTask.id);
		    assert.equal(apiWaitingItem.continue_work_command, undefined);
		    assert.equal(apiWaitingItem.commands.continue_work, undefined);
		    assert.equal(apiWaitingItem.api.next_action, undefined);

		    const apiNoNextCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=no_next_task`).then(r => r.json());
		    assert.equal(apiNoNextCurrent.ok, true);
		    assert.equal(apiNoNextCurrent.current.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiNoNextCurrent.current.next.key, 'human_accept_waiting');
		    assert.equal(apiNoNextCurrent.current.next.command, null);
		    assert.equal(apiNoNextCurrent.current.review_state_counts.active_filter, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.review_state_counts.total, 2);
		    assert.equal(apiNoNextCurrent.current.review_state_counts.human_accept_waiting, 1);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.active_filter, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.human_accept_waiting.command, null);

		    const apiNoNextQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=no_next_task`).then(r => r.json());
		    assert.equal(apiNoNextQueue.ok, true);
		    assert.equal(apiNoNextQueue.action, 'queue');
		    assert.equal(apiNoNextQueue.current.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextQueue.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiNoNextQueue.current.next.key, 'human_accept_waiting');
		    assert.equal(apiNoNextQueue.current.next.command, null);
		    assert.equal(apiNoNextQueue.queue.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextQueue.queue.counts.total, 1);
		    assert.equal(apiNoNextQueue.queue.counts.review, 1);
		    assert.deepEqual(apiNoNextQueue.current.review_state_counts, apiNoNextQueue.queue.review_state_counts);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.continue_work, 1);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.human_accept_waiting, 1);
		    assert.deepEqual(apiNoNextQueue.current.review_state_actions, apiNoNextQueue.queue.review_state_actions);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.active_filter, 'no_next_task');
		    assert.equal(apiNoNextQueue.queue.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    const apiNoNextItem = apiNoNextQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiNoNextItem.id, apiWaitingTask.id);
		    assert.equal(apiNoNextItem.continue_work_command, undefined);
		    assert.equal(apiNoNextItem.commands.continue_work, undefined);

		    const apiCertifiedStepMessageResponse = await fetch(`${base}/api/tasks/${apiContinueTask.id}/step`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({
		        actor: 'codex',
		        message: 'should not write API certified review',
		        goal: 'API certified review should not be refined by step',
		      }),
		    });
		    assert.equal(apiCertifiedStepMessageResponse.status, 409);
		    const apiCertifiedStepMessage = await apiCertifiedStepMessageResponse.json();
		    assert.equal(apiCertifiedStepMessage.reason, 'agent_certified_continue_work');
		    const apiContinueAfterGenericStep = await fetch(`${base}/api/tasks/${apiContinueTask.id}`).then(r => r.json());
		    assert.equal(apiContinueAfterGenericStep.task.status, 'review');
		    assert.equal(apiContinueAfterGenericStep.task.messages.some(m => m.content.includes('should not write API certified review')), false);

		    const apiCurrentStepContinue = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-934&review_state=continue-work`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({ actor: 'codex' }),
		    }).then(r => r.json());
		    assert.equal(apiCurrentStepContinue.ok, true);
		    assert.equal(apiCurrentStepContinue.action, 'current_step');
		    assert.equal(apiCurrentStepContinue.before_current.scope.review_state, 'continue-work');
		    assert.equal(apiCurrentStepContinue.before_current.selected_task_id, apiContinueTask.id);
		    assert.equal(apiCurrentStepContinue.selected_next_key, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.step_action, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.continue_work.action, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.continue_work.parent_task_id, apiContinueTask.id);
		    assert.equal(apiCurrentStepContinue.step.continue_work.created, true);
		    assert.equal(apiCurrentStepContinue.step.next_task.title, 'Run the API continuation follow-up');
		    assert.equal(apiCurrentStepContinue.page.task.id, apiCurrentStepContinue.step.next_task.id);
		    assert.equal(apiCurrentStepContinue.safety.human_accept, false);
		    assert.equal(apiCurrentStepContinue.safety.claims_work, false);
		    const apiContinueParentAfterStep = await fetch(`${base}/api/tasks/${apiContinueTask.id}`).then(r => r.json());
		    assert.equal(apiContinueParentAfterStep.task.status, 'review');
		    assert.equal(apiContinueParentAfterStep.task.review.approval_status, 'pending');

		    const apiCurrentStepWaitingResponse = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-934&review_state=human-accept-waiting`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({ actor: 'codex' }),
		    });
		    assert.equal(apiCurrentStepWaitingResponse.status, 409);
		    const apiCurrentStepWaiting = await apiCurrentStepWaitingResponse.json();
		    assert.equal(apiCurrentStepWaiting.reason, 'agent_certified_waiting_human');
		    assert.equal(apiCurrentStepWaiting.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiCurrentStepWaiting.selected_next_key, 'human_accept_waiting');
		    assert.equal(apiCurrentStepWaiting.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiCurrentStepWaiting.current.next.key, 'human_accept_waiting');
		    assert.equal(apiCurrentStepWaiting.page.stage.next_action.command, null);
		    assert.equal(apiCurrentStepWaiting.page.stage.next_action.api, null);
		    const apiWaitingAfterStep = await fetch(`${base}/api/tasks/${apiWaitingTask.id}`).then(r => r.json());
		    assert.equal(apiWaitingAfterStep.task.status, 'review');
		    assert.equal(apiWaitingAfterStep.task.review.approval_status, 'pending');

	    const apiQueue = await fetch(`${base}/api/tasks/queue?owner=codex&limit=1`).then(r => r.json());
	    assert.equal(apiQueue.ok, true);
	    assert.equal(apiQueue.action, 'queue');
	    assert.equal(apiQueue.current.schema, 'atris.task_current.v1');
	    assert.equal(apiQueue.queue.columns.some(column => column.key === 'review'), true);
	    const apiStepDetailAfterCurrent = await fetch(`${base}/api/tasks/${apiStepTask.task_id}`).then(r => r.json());
	    assert.equal(apiStepDetailAfterCurrent.task.status, 'review');
	    assert.equal(apiStepDetailAfterCurrent.task.review.approval_status, 'pending');

	    const apiCurrentStepReady = await fetch(`${base}/api/tasks/current/step?goal_id=OBL-928`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'codex',
	        proof: 'node --check test/commands.test.js passed for API current-step ready',
	        lesson: 'API current-step keeps current and step together',
	      }),
	    }).then(r => r.json());
	    assert.equal(apiCurrentStepReady.ok, true);
	    assert.equal(apiCurrentStepReady.action, 'current_step');
	    assert.equal(apiCurrentStepReady.before_current.scope.goal_id, 'OBL-928');
	    assert.equal(apiCurrentStepReady.before_current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.before_current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiCurrentStepReady.selected_next_key, apiCurrentStepReady.before_current.next.key);
	    assert.equal(apiCurrentStepReady.step.step_action, 'ready');
	    assert.equal(apiCurrentStepReady.current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.after_current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.after_current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.after.current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.safety.read_only, false);
	    assert.equal(apiCurrentStepReady.safety.human_accept, false);

	    const apiCurrentStepReviewChat = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-928`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ reviewer: 'codex-review' }),
	    }).then(r => r.json());
	    assert.equal(apiCurrentStepReviewChat.ok, true);
	    assert.equal(apiCurrentStepReviewChat.step.step_action, 'review_chat');
	    assert.equal(apiCurrentStepReviewChat.step.contract.schema, 'atris.task_review_chat.v1');
	    assert.match(apiCurrentStepReviewChat.step.contract.codex_prompt, /\/codex review/);
	    assert.equal(apiCurrentStepReviewChat.page.review.human_accept.enabled, true);
	    assert.equal(apiCurrentStepReviewChat.safety.human_accept, false);

	    const apiOtherReviewAdd = runCli([
	      'task', 'add', 'API other owner review stays untouched',
	      '--tag', 'api-scope',
	      '--goal-id', 'OBL-930',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOtherReviewAdd.status, 0, apiOtherReviewAdd.stderr);
	    const apiOtherReviewTask = JSON.parse(apiOtherReviewAdd.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiOtherReviewTask.display_id, '--as', 'alice'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiOtherReviewTask.display_id,
	      '--as', 'alice',
	      '--proof', 'node --check test/commands.test.js passed before API other owner review',
	    ], { cwd: dir, env }).status, 0);
	    const apiOtherReviewStepResponse = await fetch(`${base}/api/tasks/current/step?goal_id=OBL-930`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'codex', reviewer: 'codex-review' }),
	    });
	    assert.equal(apiOtherReviewStepResponse.status, 409);
	    const apiOtherReviewStep = await apiOtherReviewStepResponse.json();
	    assert.equal(apiOtherReviewStep.reason, 'claimed_by_other');
	    assert.equal(apiOtherReviewStep.current.selected_task_id, apiOtherReviewTask.id);
	    assert.equal(apiOtherReviewStep.current.selected_reason, 'review_needs_agent_verification');
	    const apiOtherReviewDetail = await fetch(`${base}/api/tasks/${apiOtherReviewTask.id}`).then(r => r.json());
	    assert.equal(apiOtherReviewDetail.task.status, 'review');
	    assert.equal(apiOtherReviewDetail.task.claimed_by, 'alice');
	    assert.equal(apiOtherReviewDetail.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')), false);

	    const apiScopedDetailAfterCurrentStep = await fetch(`${base}/api/tasks/${apiScopedTask.id}`).then(r => r.json());
	    assert.equal(apiScopedDetailAfterCurrentStep.task.status, 'review');
	    assert.equal(apiScopedDetailAfterCurrentStep.task.review.approval_status, 'pending');
	    assert.ok(apiScopedDetailAfterCurrentStep.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

	    const apiOwnerQueryAdd = runCli([
	      'task', 'add', 'API owner query current-step task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-929',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerQueryAdd.status, 0, apiOwnerQueryAdd.stderr);
	    const apiOwnerQueryTask = JSON.parse(apiOwnerQueryAdd.stdout).task;
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerQueryTask.display_id,
	      '--as', 'alice',
	      '--goal', 'API current-step honors query owner',
	      '--exit', 'owner query steps the owner current task',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner query coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerQueryTask.display_id,
	      '--as', 'alice',
	      '--first-move', 'alice owns API current-step query work',
	    ], { cwd: dir, env }).status, 0);
	    const apiOwnerQueryCurrent = await fetch(`${base}/api/tasks/current?owner=alice&goal_id=OBL-929`).then(r => r.json());
	    assert.equal(apiOwnerQueryCurrent.ok, true);
	    assert.equal(apiOwnerQueryCurrent.current.owner, 'alice');
	    assert.equal(apiOwnerQueryCurrent.current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiOwnerQueryCurrent.current.selected_task_id, apiOwnerQueryTask.id);
	    const apiOwnerQueryStep = await fetch(`${base}/api/tasks/current/step?owner=alice&goal_id=OBL-929`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        proof: 'node --check test/commands.test.js passed for API current-step owner query',
	        lesson: 'POST current-step uses the same query owner as GET current',
	      }),
	    }).then(r => r.json());
	    assert.equal(apiOwnerQueryStep.ok, true);
	    assert.equal(apiOwnerQueryStep.before_current.owner, 'alice');
	    assert.equal(apiOwnerQueryStep.before_current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiOwnerQueryStep.before_current.selected_task_id, apiOwnerQueryTask.id);
	    assert.equal(apiOwnerQueryStep.step.step_action, 'ready');
	    assert.equal(apiOwnerQueryStep.step.task.id, apiOwnerQueryTask.id);
	    assert.equal(apiOwnerQueryStep.safety.human_accept, false);

	    const apiOwnerPrecedenceAliceAdd = runCli([
	      'task', 'add', 'API owner precedence Alice task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-931',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerPrecedenceAliceAdd.status, 0, apiOwnerPrecedenceAliceAdd.stderr);
	    const apiOwnerPrecedenceAliceTask = JSON.parse(apiOwnerPrecedenceAliceAdd.stdout).task;
	    const apiOwnerPrecedenceCodexAdd = runCli([
	      'task', 'add', 'API owner precedence Codex task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-931',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerPrecedenceCodexAdd.status, 0, apiOwnerPrecedenceCodexAdd.stderr);
	    const apiOwnerPrecedenceCodexTask = JSON.parse(apiOwnerPrecedenceCodexAdd.stdout).task;
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerPrecedenceAliceTask.display_id,
	      '--as', 'alice',
	      '--goal', 'Alice owns the query-selected task',
	      '--exit', 'query owner cannot be overridden by body actor',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner precedence coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerPrecedenceAliceTask.display_id,
	      '--as', 'alice',
	      '--first-move', 'alice owns the query-selected work',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerPrecedenceCodexTask.display_id,
	      '--as', 'codex',
	      '--goal', 'Codex owns a different same-scope task',
	      '--exit', 'query owner still selects Alice',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner precedence coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerPrecedenceCodexTask.display_id,
	      '--as', 'codex',
	      '--first-move', 'codex owns separate same-scope work',
	    ], { cwd: dir, env }).status, 0);
	    const apiOwnerPrecedenceCurrent = await fetch(`${base}/api/tasks/current?owner=alice&goal_id=OBL-931`).then(r => r.json());
	    assert.equal(apiOwnerPrecedenceCurrent.current.selected_task_id, apiOwnerPrecedenceAliceTask.id);
	    const apiOwnerPrecedenceResponse = await fetch(`${base}/api/tasks/current/step?owner=alice&goal_id=OBL-931`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'codex',
	        proof: 'node --check test/commands.test.js passed for API current-step owner precedence',
	      }),
	    });
	    assert.equal(apiOwnerPrecedenceResponse.status, 409);
	    const apiOwnerPrecedenceStep = await apiOwnerPrecedenceResponse.json();
	    assert.equal(apiOwnerPrecedenceStep.reason, 'claimed_by_other');
	    assert.equal(apiOwnerPrecedenceStep.current.selected_task_id, apiOwnerPrecedenceAliceTask.id);
	    const apiOwnerPrecedenceCodexDetail = await fetch(`${base}/api/tasks/${apiOwnerPrecedenceCodexTask.id}`).then(r => r.json());
	    assert.equal(apiOwnerPrecedenceCodexDetail.task.status, 'claimed');

	    const apiUnplannedDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'start too early' }),
    });
    assert.equal(apiUnplannedDo.status, 409);
    assert.equal((await apiUnplannedDo.json()).reason, 'goal_required');

    const apiInlineDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Skip API plan',
        proof_needed: 'should still need a plan event',
        first_move: 'start too early',
      }),
    });
    assert.equal(apiInlineDo.status, 409);
    assert.equal((await apiInlineDo.json()).reason, 'plan_required');

    const apiPlan = await fetch(`${base}/api/tasks/${apiStageId}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Prove API Plan Do Review',
        summary: 'Use API stage endpoints before review',
        owner: 'codex',
        exit: 'ready endpoint receives specific proof',
        proof_needed: 'node --test command API stage coverage passes',
        first_move: 'call the do endpoint',
      }),
    }).then(r => r.json());
    assert.equal(apiPlan.ok, true);
    assert.equal(apiPlan.action, 'planned');
    assert.equal(apiPlan.task.metadata.stage, 'plan');
    assert.match(apiPlan.stage_packet, /stage: plan/);
    assert.match(apiPlan.stage_packet, /goal: Prove API Plan Do Review/);

    const apiExitRewriteDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        exit: 'different API review boundary',
        first_move: 'start from rewritten API exit',
      }),
    });
    assert.equal(apiExitRewriteDo.status, 409);
    assert.equal((await apiExitRewriteDo.json()).reason, 'plan_exit_mismatch');

    const apiRewriteDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Replace API plan',
        proof_needed: 'weaker API proof',
        first_move: 'start from rewritten API text',
      }),
    });
    assert.equal(apiRewriteDo.status, 409);
    assert.equal((await apiRewriteDo.json()).reason, 'plan_goal_mismatch');

    const apiDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'run the API stage smoke' }),
    }).then(r => r.json());
    assert.equal(apiDo.ok, true);
    assert.equal(apiDo.action, 'doing');
    assert.equal(apiDo.task.status, 'claimed');
    assert.equal(apiDo.task.claimed_by, 'codex');
    assert.equal(apiDo.task.metadata.stage, 'do');
    assert.match(apiDo.stage_packet, /stage: do/);

    const apiBacklogTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Move API plan row back to backlog', tag: 'plan' }),
    }).then(r => r.json());
    assert.equal(apiBacklogTask.ok, true);
    const apiBacklogTaskId = apiBacklogTask.task_id;
    const apiBacklogPlan = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'API backlog has a plan',
        exit: 'API backlog endpoint clears it',
        proof_needed: 'node --test API backlog coverage passes',
      }),
    }).then(r => r.json());
    assert.equal(apiBacklogPlan.ok, true);

    const apiBacklog = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/backlog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', reason: 'operator changed priority', tag: 'feature' }),
    }).then(r => r.json());
    assert.equal(apiBacklog.ok, true);
    assert.equal(apiBacklog.action, 'backlogged');
    assert.equal(apiBacklog.task.tag, 'capture');
    assert.equal(apiBacklog.task.metadata.stage, undefined);
    assert.equal(apiBacklog.task.latest_event_type, 'task_backlogged');

    const apiBacklogDo = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'start after API backlog' }),
    });
    assert.equal(apiBacklogDo.status, 409);
    assert.equal((await apiBacklogDo.json()).reason, 'goal_required');

    const apiBulkA = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API clear plan A', tag: 'feature' }),
    }).then(r => r.json());
    const apiBulkB = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API clear plan B', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiBulkA.ok, true);
    assert.equal(apiBulkB.ok, true);
    for (const taskId of [apiBulkA.task_id, apiBulkB.task_id]) {
      const planned = await fetch(`${base}/api/tasks/${taskId}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'codex',
          owner: 'codex',
          goal: `API bulk goal ${taskId}`,
          exit: `API bulk exit ${taskId}`,
          proof_needed: `API bulk proof ${taskId}`,
        }),
      }).then(r => r.json());
      assert.equal(planned.ok, true);
    }
    const apiClearMissingConfirm = await fetch(`${base}/api/tasks/clear-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(apiClearMissingConfirm.status, 400);
    assert.equal((await apiClearMissingConfirm.json()).reason, 'confirm_required');

    const apiClearPlan = await fetch(`${base}/api/tasks/clear-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', confirm: true, reason: 'operator cleared Plan' }),
    }).then(r => r.json());
    assert.equal(apiClearPlan.ok, true);
    assert.equal(apiClearPlan.action, 'clear_plan');
    assert.equal(apiClearPlan.cleared_count, 2);
    assert.deepEqual(apiClearPlan.tasks.map(task => task.id).sort(), [apiBulkA.task_id, apiBulkB.task_id].sort());
    assert.ok(apiClearPlan.tasks.every(task => task.tag === 'capture'));

    const missingReadyProofResponse = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(missingReadyProofResponse.status, 400);
    const missingReadyProof = await missingReadyProofResponse.json();
    assert.equal(missingReadyProof.reason, 'proof_required');

    const weakReadyProofResponse = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'done' }),
    });
    assert.equal(weakReadyProofResponse.status, 400);
    const weakReadyProof = await weakReadyProofResponse.json();
    assert.equal(weakReadyProof.reason, 'weak_proof');

    const apiReady = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'node --check test/commands.test.js passed before revise' }),
    }).then(r => r.json());
    assert.equal(apiReady.ok, true);

    const prematureApiFinishResponse = await fetch(`${base}/api/tasks/${apiReviewId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'node --check test/commands.test.js passed while blocked in review' }),
    });
    assert.equal(prematureApiFinishResponse.status, 409);
    const prematureApiFinish = await prematureApiFinishResponse.json();
    assert.equal(prematureApiFinish.reason, 'not_open_or_claimed');

    const apiRevise = await fetch(`${base}/api/tasks/${apiReviewId}/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', note: 'needs another pass' }),
    }).then(r => r.json());
    assert.equal(apiRevise.ok, true);
    assert.equal(apiRevise.task.status, 'open');

    const staleApiAcceptResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator' }),
    });
    assert.equal(staleApiAcceptResponse.status, 400);
    const staleApiAccept = await staleApiAcceptResponse.json();
    assert.equal(staleApiAccept.reason, 'proof_required');

    const freshApiReady = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed after API ready',
        lesson: 'API accept keeps the ready lesson',
        next: 'Create the API follow-up task',
      }),
    }).then(r => r.json());
    assert.equal(freshApiReady.ok, true);

    const apiDetail = await fetch(`${base}/api/tasks/${apiReviewId}`).then(r => r.json());
    assert.equal(apiDetail.ok, true);
    assert.equal(apiDetail.action, 'detail');
    assert.equal(apiDetail.task.id, apiReviewId);
    assert.equal(apiDetail.task.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.match(apiDetail.task.review.verification_chat.command, /atris task review-chat /);
    assert.match(apiDetail.task.review.verification_chat.codex_prompt, /\/codex review/);
    assert.equal(apiDetail.page.schema, 'atris.task_page.v1');
    assert.equal(apiDetail.page.stage.current, 'review');
    assert.equal(apiDetail.page.stage.next_action.key, 'review_chat');
    assert.equal(apiDetail.page.review.human_accept.enabled, true);
    assert.notEqual(apiDetail.page.stage.next_action.command, apiDetail.page.review.human_accept.command);

    const apiPage = await fetch(`${base}/api/tasks/${apiReviewId}/page`).then(r => r.json());
    assert.equal(apiPage.ok, true);
    assert.equal(apiPage.action, 'page');
    assert.equal(apiPage.page.task.id, apiReviewId);
    assert.equal(apiPage.page.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.equal(apiPage.page.chat.can_chat, true);

    const apiReviewChat = await fetch(`${base}/api/tasks/${apiReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    }).then(r => r.json());
    assert.equal(apiReviewChat.ok, true);
    assert.equal(apiReviewChat.action, 'review_chat');
    assert.equal(apiReviewChat.appended, true);
    assert.ok(apiReviewChat.version);
    assert.equal(apiReviewChat.contract.schema, 'atris.task_review_chat.v1');
    assert.match(apiReviewChat.contract.codex_prompt, /\/codex review/);
    assert.match(apiReviewChat.contract.codex_prompt, /Reject stale API proof after revise/);
    assert.match(apiReviewChat.contract.pass_command, /atris task review /);
    assert.equal(apiReviewChat.contract.verification_focus.proof_claim, 'node --check test/commands.test.js passed after API ready');
    assert.ok(apiReviewChat.contract.verification_focus.commands_to_verify.some(command => command.includes('node --check test/commands.test.js')));
    assert.ok(apiReviewChat.contract.verification_focus.files_to_inspect.includes('test/commands.test.js'));
    assert.match(apiReviewChat.contract.required_checks.join('\n'), /Re-run or inspect these proof commands/);
    assert.match(apiReviewChat.contract.required_checks.join('\n'), /Inspect these named files\/artifacts/);
    assert.ok(apiReviewChat.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

    const apiDetailAfterReviewChat = await fetch(`${base}/api/tasks/${apiReviewId}`).then(r => r.json());
    assert.equal(apiDetailAfterReviewChat.ok, true);
    assert.ok(apiDetailAfterReviewChat.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

    const apiDefaultReviewTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API default review is verifier-only', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiDefaultReviewTask.ok, true);
    const apiDefaultReviewId = apiDefaultReviewTask.task_id;
    const apiDefaultReady = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed before default API review',
      }),
    }).then(r => r.json());
    assert.equal(apiDefaultReady.ok, true);
    const apiDefaultReview = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'validator',
        proof: 'node --check test/commands.test.js passed during default API review',
      }),
    }).then(r => r.json());
    assert.equal(apiDefaultReview.ok, true);
    assert.equal(apiDefaultReview.episode.reward.value, 0);
    const apiDefaultDetail = await fetch(`${base}/api/tasks/${apiDefaultReviewId}`).then(r => r.json());
    assert.equal(apiDefaultDetail.task.review.approval_status, 'pending');
    assert.equal(apiDefaultDetail.task.review.agent_review_pass_count, 2);
    assert.equal(apiDefaultDetail.task.review.agent_certified, true);
    assert.equal(apiDefaultDetail.task.review.verification_chat, undefined);
    assert.equal(apiDefaultDetail.page.stage.next_action.key, 'human_accept_waiting');
    assert.equal(apiDefaultDetail.page.stage.next_action.command, null);
    assert.equal(apiDefaultDetail.page.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.match(apiDefaultDetail.page.actions.review_chat_command, /atris task review-chat /);
    assert.equal(apiDefaultDetail.page.review.human_accept.enabled, true);

    const apiCertifiedReviewChatResponse = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    });
    assert.equal(apiCertifiedReviewChatResponse.status, 200);
    const apiCertifiedReviewChat = await apiCertifiedReviewChatResponse.json();
    assert.equal(apiCertifiedReviewChat.ok, true);
    assert.equal(apiCertifiedReviewChat.action, 'review_chat');
    assert.equal(apiCertifiedReviewChat.contract.review.agent_certified, true);

    const weakApiAcceptResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', proof: 'done' }),
    });
    assert.equal(weakApiAcceptResponse.status, 400);
    const weakApiAccept = await weakApiAcceptResponse.json();
    assert.equal(weakApiAccept.reason, 'weak_proof');

    const invalidRewardResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', reward: 0 }),
    });
    assert.equal(invalidRewardResponse.status, 400);
    const invalidReward = await invalidRewardResponse.json();
    assert.equal(invalidReward.reason, 'invalid_reward');

    const freshApiAccept = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', createNext: true }),
    }).then(r => r.json());
    assert.equal(freshApiAccept.ok, true);
    assert.equal(freshApiAccept.episode.proof, 'node --check test/commands.test.js passed after API ready');
    assert.equal(freshApiAccept.episode.lesson, 'API accept keeps the ready lesson');
    assert.equal(freshApiAccept.episode.next_task_suggestion, 'Create the API follow-up task');
    assert.ok(freshApiAccept.next_task_id);

    const apiReviewGate = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reject weak API review proof', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiReviewGate.ok, true);
    const weakReviewProofResponse = await fetch(`${base}/api/tasks/${apiReviewGate.task_id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'validator', reward: 1, proof: 'done' }),
    });
    assert.equal(weakReviewProofResponse.status, 400);
    const weakReviewProof = await weakReviewProofResponse.json();
    assert.equal(weakReviewProof.reason, 'weak_proof');

    const clearReview = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Clear stale review guidance', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(clearReview.ok, true);
    const clearReviewId = clearReview.task_id;

    const clearReady = await fetch(`${base}/api/tasks/${clearReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed for clear review',
        lesson: 'stale ready lesson',
        next: 'stale ready next',
      }),
    }).then(r => r.json());
    assert.equal(clearReady.ok, true);

    const omittedApiReview = await fetch(`${base}/api/tasks/${clearReviewId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'validator', reward: 0 }),
    }).then(r => r.json());
    assert.equal(omittedApiReview.ok, true);
    assert.equal(omittedApiReview.task.review.proof, 'node --check test/commands.test.js passed for clear review');
    assert.equal(omittedApiReview.task.review.lesson, 'stale ready lesson');
    assert.equal(omittedApiReview.task.review.next_task, 'stale ready next');

    const clearAccept = await fetch(`${base}/api/tasks/${clearReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', lesson: '', next: '' }),
    }).then(r => r.json());
    assert.equal(clearAccept.ok, true);
    assert.equal(clearAccept.episode.proof, 'node --check test/commands.test.js passed for clear review');
    assert.equal(clearAccept.episode.lesson, '');
    assert.equal(clearAccept.episode.next_task_suggestion, null);
    assert.equal(clearAccept.task.review.proof, 'node --check test/commands.test.js passed for clear review');
    assert.equal(clearAccept.task.review.lesson, null);
    assert.equal(clearAccept.task.review.next_task, null);

    const scopedApiCreateNext = runCli([
      'task', 'add', 'Scoped API create-next parent',
      '--tag', 'factory',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedApiCreateNext.status, 0, scopedApiCreateNext.stderr);
    const scopedApiParent = JSON.parse(scopedApiCreateNext.stdout).task;
    const scopedApiReady = await fetch(`${base}/api/tasks/${scopedApiParent.id}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed for scoped API createNext',
        next: 'Scoped API follow-up task',
      }),
    }).then(r => r.json());
    assert.equal(scopedApiReady.ok, true);
    const scopedApiAccept = await fetch(`${base}/api/tasks/${scopedApiParent.id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', createNext: true }),
    }).then(r => r.json());
    assert.equal(scopedApiAccept.ok, true);
    assert.ok(scopedApiAccept.next_task_id);

    const listed = await fetch(`${base}/api/tasks`).then(r => r.json());
    assert.equal(listed.ok, true);
    assert.ok(listed.projection.tasks.some(t => t.id === finished.next_task_id && t.title === 'Connect the board to Swarlo leases'));
    assert.ok(listed.projection.tasks.some(t => t.id === freshApiAccept.next_task_id && t.title === 'Create the API follow-up task'));
    assert.ok(listed.projection.tasks.some(t => t.id === scopedApiAccept.next_task_id
      && t.title === 'Scoped API follow-up task'
      && t.metadata.goal_id === 'OBL-932'
      && t.lineage.parent_task_id === scopedApiParent.id));
  } finally {
    if (child) child.kill('SIGTERM');
    cleanupTempDir(dir);
  }
});

test('task sync dry-run maps local tasks to canonical cloud task writes', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-task-sync',
      slug: 'task-sync-lab',
    }), 'utf8');

    const created = runCli(['task', 'new', 'Sync local task to cloud control plane', '--tag', 'swarlo', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    const noted = runCli(['task', 'say', id, 'Use dry-run before cloud writes', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(noted.status, 0, noted.stderr);

    const ready = runCli(['task', 'ready', id, '--proof', 'dry-run sync validation passed', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const sync = runCli(['task', 'sync', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(sync.status, 0, sync.stderr);
    const payload = JSON.parse(sync.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.business_id, 'biz-task-sync');
    assert.equal(payload.planned_writes, 1);
    assert.equal(payload.plan[0].method, 'POST');
    assert.equal(payload.plan[0].endpoint, '/business/biz-task-sync/work/tasks');
    assert.equal(payload.plan[0].body.type, 'improvement');
    assert.equal(payload.plan[0].body.owner_member_id, 'agent:codex');
    assert.equal(payload.plan[0].body.metadata.source, 'atris_cli_task');
    assert.equal(payload.plan[0].body.metadata.local_task_id, id);
    assert.equal(payload.plan[0].body.metadata.approval_status, 'pending');
    assert.equal(payload.plan[0].body.metadata.swarlo.lease_owner, 'codex');
    assert.equal(payload.plan[0].body.metadata.swarlo.lease_state, 'none');
    assert.equal(payload.plan[0].body.needs_approval, true);
    assert.equal(payload.plan[0].after_create[0].body.state, 'doing');
    assert.match(payload.plan[0].body.description, /Use dry-run before cloud writes/);
    assert.match(payload.plan[0].body.description, /Proof: dry-run sync validation passed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task projection exposes goals, review proof, and task lineage for visual boards', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'goals.md'), [
      '---',
      'type: goals',
      '---',
      '',
      '# Goals',
      '',
      '- Build the task factory into a compounding autonomous development surface',
      '- Connect tasks to Swarlo and Supabase',
      '',
    ].join('\n'), 'utf8');

    const created = runCli(['task', 'new', 'Improve task factory lineage view', '--tag', 'tasks', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const unrelated = runCli(['task', 'new', 'Repair notarized Mac installer', '--tag', 'release', '--json'], { cwd: dir, env });
    assert.equal(unrelated.status, 0, unrelated.stderr);
    const unrelatedId = JSON.parse(unrelated.stdout).task_id;

    const genericLoop = runCli(['task', 'new', 'Loop tick: Validate local Claude /goal behavior', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(genericLoop.status, 0, genericLoop.stderr);
    const genericLoopId = JSON.parse(genericLoop.stdout).task_id;

    const finished = runCli([
      'task', 'finish', id,
      '--proof', 'board lineage validation passed',
      '--lesson', 'Visual tasks need goal and proof context',
      '--next', 'Render lineage in Task Factory board',
      '--create-next',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finished.status, 0, finished.stderr);
    const donePayload = JSON.parse(finished.stdout);
    const nextId = donePayload.next_task_id;

    const exported = runCli(['task', 'export', '--json'], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    const projection = JSON.parse(exported.stdout).projection;
    assert.equal(projection.goals.items[0], 'Build the task factory into a compounding autonomous development surface');
    assert.ok(projection.streams.some(stream => stream.objective === 'Build the task factory into a compounding autonomous development surface'));
    const parent = projection.tasks.find(t => t.id === id);
    const child = projection.tasks.find(t => t.id === nextId);
    const unrelatedTask = projection.tasks.find(t => t.id === unrelatedId);
    const genericLoopTask = projection.tasks.find(t => t.id === genericLoopId);
    assert.equal(parent.objective, 'Build the task factory into a compounding autonomous development surface');
    assert.equal(unrelatedTask.objective, null);
    assert.equal(genericLoopTask.objective, null);
    assert.equal(parent.review.summary, 'Completed result for improve task factory lineage view.');
    assert.equal(parent.review.proof, 'board lineage validation passed');
    assert.equal(parent.review.lesson, 'Visual tasks need goal and proof context');
    assert.deepEqual(parent.lineage.child_task_ids, [nextId]);
    assert.equal(parent.lineage.next_task_suggestion, 'Render lineage in Task Factory board');
    assert.equal(child.lineage.parent_task_id, id);
    assert.equal(child.lineage.parent_title, 'Improve task factory lineage view');
    const stream = projection.streams.find(s => s.objective === parent.objective);
    assert.equal(stream.done_count, 1);
    assert.equal(stream.active_count, 1);
    assert.ok(stream.tasks.some(t => t.id === nextId && t.parent_task_id === id));
  } finally {
    cleanupTempDir(dir);
  }
});

test('TODO fallback parser handles nested groups and modern task ids', () => {
  const dir = makeTempDir();
  try {
    const todoPath = path.join(dir, 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '### UX',
      '- [ ] **Fast idea dump** — capture rough thoughts before running agents.',
      '- **windows-public-release-T1:** Publish signed Windows installer [agent] [execute]',
      '  **Verify:** npm run release:gate:win',
      '',
      '## In Progress',
      '',
      '- **prod-first-install-hotfix-T1:** Fix first-install failures [agent] [execute]',
      '  **Claimed by:** Codex at 2026-05-02T12:34:00Z',
      '  **Verify:** npm run update:smoke',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const { parseTodoFile } = require('../lib/todo-fallback');
    const parsed = parseTodoFile(todoPath);
    assert.equal(parsed.backlog.length, 2);
    assert.equal(parsed.backlog[0].title, 'Fast idea dump - capture rough thoughts before running agents.');
    assert.equal(parsed.backlog[1].id, 'windows-public-release-T1');
    assert.equal(parsed.backlog[1].verify, 'npm run release:gate:win');
    assert.equal(parsed.inProgress[0].id, 'prod-first-install-hotfix-T1');
    assert.equal(parsed.inProgress[0].claimed, 'Codex at 2026-05-02T12:34:00Z');
    assert.equal(parsed.inProgress[0].verify, 'npm run update:smoke');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task import preserves Verify metadata through DB-backed TODO shim', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    const todoPath = path.join(atrisDir, 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **T1:** Task plane import keeps proof [endgame] [execute]',
      '  **Verify:** test -f done.txt',
      '',
      '## In Progress',
      '',
      '- **T2:** Claimed task keeps section [execute]',
      '  **Claimed by:** codex at 2026-04-28T07:29:42Z',
      '  **Verify:** test -f claimed.txt',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const imported = runCli(['task', 'import', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /imported 2 new, skipped 0/);

    const script = [
      "const { parseTodo } = require('./lib/todo');",
      "const { getVerifyCommand } = require('./commands/autopilot');",
      `const todo = parseTodo(${JSON.stringify(todoPath)});`,
      `const verify = getVerifyCommand(${JSON.stringify(dir)}, 'Task plane import keeps proof');`,
      "console.log(JSON.stringify({ todo, verify }));",
    ].join('\n');
    const parsed = spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        ATRIS_TASK_DB: '1',
        ATRIS_TASKS_DB: dbPath,
        NODE_NO_WARNINGS: '1',
      },
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    const out = JSON.parse(parsed.stdout);
    assert.equal(out.todo.backlog[0].verify, 'test -f done.txt');
    assert.equal(out.todo.inProgress[0].verify, 'test -f claimed.txt');
    assert.equal(out.todo.inProgress[0].claimed, 'codex at 2026-04-28T07:29:42Z');
    assert.deepEqual(out.verify, { cmd: 'test -f done.txt', explicit: true });
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// search
// ============================================

test('search with no keyword prints usage', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['search'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Usage: atris search/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search help flags print usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const flag of ['--help', '-h']) {
      const res = runCli(['search', flag], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `search ${flag}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris search <keyword>/);
      assert.doesNotMatch(res.stdout, /No atris\/logs\/ directory found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `search ${flag} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `search ${flag} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('search with zero hits outside a workspace points newcomers to init', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['search', 'credits'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    // outside a workspace the hint is the whole output; empty scan rows are noise
    assert.match(res.stdout, /No atris folder here\. Run atris init to set one up\./);
    assert.doesNotMatch(res.stdout, /Feature: none/);
    assert.doesNotMatch(res.stdout, /No matches found\./);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search walks features team wiki then journal in compact mode', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'features', 'credits'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'treasury'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'logs', '2026'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'features', 'credits', 'idea.md'), 'Credits feature spec\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'treasury', 'MEMBER.md'), 'Owns credits and billing.\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'credits.md'), 'Credits decisions live here.\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-07-04.md'), 'older credits note\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-07-05.md'), 'newer credits note\n', 'utf8');

    const res = runCli(['search', 'credits'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Feature: atris\/features\/credits\//);
    assert.match(res.stdout, /Owner: atris\/team\/treasury\/MEMBER\.md/);
    assert.match(res.stdout, /Wiki: atris\/wiki\/credits\.md/);
    assert.match(res.stdout, /Journal:\n- atris\/logs\/2026\/2026-07-05\.md:1: newer credits note/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search raw prints full file line dump', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'features', 'credits'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'logs', '2026'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'features', 'credits', 'idea.md'), 'Credits feature spec\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-07-05.md'), [
      'newer credits note',
      'another credits note',
    ].join('\n'), 'utf8');

    const res = runCli(['search', 'credits', '--raw'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Searching for "credits" in source, atris\/MAP\.md, atris\/features, atris\/team, atris\/wiki, atris\/logs/);
    assert.match(res.stdout, /atris\/features\/credits\/idea\.md:1\n  Credits feature spec/);
    assert.match(res.stdout, /atris\/logs\/2026\/2026-07-05\.md:1\n  newer credits note/);
    assert.match(res.stdout, /atris\/logs\/2026\/2026-07-05\.md:2\n  another credits note/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('learn help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const helpArg of ['--help', '-h', 'help']) {
      const res = runCli(['learn', helpArg], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `learn ${helpArg}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris learn \[command\]/);
      assert.doesNotMatch(res.stderr, /atris\/ folder not found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `learn ${helpArg} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `learn ${helpArg} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('soul help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const helpArg of ['--help', '-h', 'help']) {
      const res = runCli(['soul', helpArg], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `soul ${helpArg}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /atris soul/);
      assert.doesNotMatch(res.stderr, /No atris\/ folder found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `soul ${helpArg} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `soul ${helpArg} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('top-level help shows local and global first-run commands', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /already won\. one next step/);
    assert.match(res.stdout, /atris later "/);
    assert.match(res.stdout, /atris do\b/);
    assert.match(res.stdout, /Keep working/);
    assert.match(res.stdout, /help --all/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('fresh workspace prompt gives one primary first command plus local fallback', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli([], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /is empty/);
    assert.match(res.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(res.stdout, /atris init --minimal/);
    assert.ok(res.stdout.trim().split('\n').filter(Boolean).length <= 6);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('workspace-free help smoke sweep covers common entrypoints', () => {
  const cases = [
    ['--help'],
    ['status', '--help'],
    ['analytics', '--help'],
    ['brain', '--help'],
    ['brain', '-h'],
    ['brainstorm', '--help'],
    ['brainstorm', '-h'],
    ['brainstorm', 'help'],
    ['fast', '--help'],
    ['ax', 'fast', '--help'],
    ['search', '--help'],
    ['search', '-h'],
    ['learn', '--help'],
    ['learn', '-h'],
    ['learn', 'help'],
    ['soul', '--help'],
    ['soul', '-h'],
    ['soul', 'help'],
    ['activate', '--help'],
    ['launchpad', '--help'],
    ['next', '--help'],
    ['now', '--help'],
    ['radar', '--help'],
    ['ctop', '--help'],
    ['clean', '--help'],
    ['verify', '--help'],
    ['loop', '--help'],
    ['pulse', '--help'],
    ['serve', '--help'],
    ['agent', '--help'],
    ['update', '--help'],
    ['sync', '--help'],
    ['upgrade', '--help'],
    ['release', '--help'],
    ['login', '--help'],
    ['logout', '--help'],
    ['whoami', '--help'],
    ['switch', '--help'],
    ['use', '--help'],
    ['accounts', '--help'],
    ['balance', '--help'],
    ['usage', '--help'],
    ['api-key', '--help'],
    ['topup', '--help'],
    ['buy', '--help'],
    ['transactions', '--help'],
    ['integrations', '--help'],
    ['skill', '--help'],
    ['member', '--help'],
    ['business', 'init', '--help'],
    ['business', 'create', '--help'],
    ['plugin', '--help'],
    ['experiments', '--help'],
    ['receipt', '--help'],
    ['proof', '--help'],
    ['play', '--help'],
    ['code-review', '--help'],
    ['cr', '--help'],
  ];

  for (const args of cases) {
    const dir = makeTempDir();
    try {
      const home = path.join(dir, 'home');
      const res = runCli(args, { cwd: dir, env: { HOME: home } });
      const label = args.join(' ');
      assert.equal(res.status, 0, `${label}: ${res.stderr || res.stdout}`);
      assert.ok((res.stdout + res.stderr).trim().length > 0, `${label} printed no help`);
      assert.doesNotMatch(res.stdout + res.stderr, /folder not found|Run "atris init"|Not logged in|Checking for updates|Current Status|Atris Analytics|CONTEXT LOADED|Wiki Loop/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${label} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${label} created ~/.atris`);
    } finally {
      cleanupTempDir(dir);
    }
  }
});

test('launchpad --json picks the current actor claimed task first', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), [
      '# Atris Brain Status',
      '',
      '## Next Move',
      '',
      'Pick the highest-leverage open TODO item.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      surface: { hidden_done_count: 7 },
      tasks: [
        {
          id: 'task-codex',
          display_id: 'CLI-9',
          title: 'Ship launchpad',
          status: 'claimed',
          claimed_by: 'codex',
          updated_at: 30,
          metadata: {},
        },
        {
          id: 'task-review',
          display_id: 'CLI-8',
          title: 'Check finished work',
          status: 'review',
          claimed_by: 'claude',
          updated_at: 20,
          metadata: { agent_review_pass_count: 1 },
          review: { agent_review_pass_count: 1 },
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      id: 'mission-live',
      objective: 'Keep loop alive',
      status: 'running',
      verifier: 'npm test',
    })}\n`, 'utf8');

    const res = runCli(['launchpad', '--json', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.schema, 'atris.launchpad.v1');
    assert.equal(payload.next_action.kind, 'continue_claimed_task');
    assert.equal(payload.next_action.command, 'atris task step CLI-9');
    assert.equal(payload.counts.review_needs_agent, 1);
    assert.equal(payload.counts.missions_need_tick, 1);
    assert.deepEqual(payload.suggestions.map(item => item.title), [
      'Finish current work',
      'Run the paused live job',
      'Check a finished change',
    ]);
    assert.equal(payload.suggestions[0].subject, 'Ship launchpad');
    assert.equal(payload.suggestions[0].ref, 'CLI-9');
  } finally {
    cleanupTempDir(dir);
  }
});

test('launchpad --json reports clean review queue and endgame seed action', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO',
      '',
      '## Endgame',
      '',
      '**Slug:** autopilot-runner-agnostic',
      '**Horizon:** runner swaps should be config-only',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), '# Status\n\n## Next Move\n\nSeed work.\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [],
    }, null, 2), 'utf8');

    const res = runCli(['launchpad', '--json', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.counts.open, 0);
    assert.equal(payload.counts.review, 0);
    assert.equal(payload.counts.review_needs_agent, 0);
    assert.equal(payload.counts.review_certified, 0);
    assert.equal(payload.next_action.kind, 'seed_endgame_task');
    assert.equal(payload.next_action.command, 'atris task next --create-next');
    assert.equal(payload.next_action.endgame.slug, 'autopilot-runner-agnostic');
  } finally {
    cleanupTempDir(dir);
  }
});

test('launchpad chooses a verifier mission when there is no owned claimed task', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), '# Status\n\n## Next Move\n\nSeed work.\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        {
          id: 'task-review',
          display_id: 'CLI-10',
          title: 'Check finished work',
          status: 'review',
          claimed_by: 'claude',
          updated_at: 20,
          metadata: { agent_review_pass_count: 1 },
          review: { agent_review_pass_count: 1 },
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      id: 'mission-verify',
      objective: 'Ship one checked loop',
      status: 'ready',
      verifier: 'node --test',
    })}\n`, 'utf8');

    const res = runCli(['launchpad', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Live job waiting on a check/);
    assert.match(res.stdout, /Ship one checked loop/);
    assert.match(res.stdout, /RUN THIS\n\s+atris mission tick mission-verify --verify --complete-on-pass/);
    assert.match(res.stdout, /WHAT HAPPENED\n\s+Ship one checked loop/);
    assert.match(res.stdout, /WHAT TO WORK ON NEXT\n\s+1\. Run the paused live job/);
    assert.match(res.stdout, /2\. Check a finished change/);
    assert.match(res.stdout, /An always-on job is paused until its check runs\./);
    assert.doesNotMatch(res.stdout, /proof|review-chat|agent review/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('init scaffolds atris/wiki/briefs instead of syntheses', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'briefs')));
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'syntheses')), false);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Atris is the source of truth/);
    assert.match(agents, /AGENTS\.md`; do not turn it into a parallel brain/);
    assert.match(agents, /`atris\/atris\.md` \| Protocol\/backbone/);
    assert.match(agents, /`atris task ready <id> --proof/);
    assert.match(agents, /Human accept\s+-> task Done \+ AgentXP awarded/);
    assert.doesNotMatch(agents, /task finish <id> --proof/);
    const claudeCommand = fs.readFileSync(path.join(dir, '.claude', 'commands', 'atris.md'), 'utf8');
    assert.match(claudeCommand, /atris\/atris\.md/);
    assert.match(claudeCommand, /AGENTS\.md is only a tool adapter/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('init scaffolds Devin permission for Atris command access', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const configPath = path.join(dir, '.devin', 'config.local.json');
    assert.ok(fs.existsSync(configPath));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.permissions.allow, ['Exec(atris)']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('agent doctor verifies local AI CLI wiring without auth', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['agent', 'doctor', '--account', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'agent_doctor');
    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.checks.map((check) => [check.id, check.ok]),
      [
        ['atris-core', true],
        ['codex', true],
        ['claude', true],
        ['cursor', true],
        ['devin', true],
      ]
    );
    assert.ok(payload.binaries.some((binary) => binary.name === 'devin'));
    assert.ok(payload.binaries.some((binary) => binary.name === 'agy'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('agent help hides internal dogfood diagnostic', () => {
  const dir = makeTempDir();
  let res;
  try {
    res = runCli(['agent', '--help'], { cwd: dir });
  } finally {
    cleanupTempDir(dir);
  }
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, /dogfood/);
  assert.match(res.stdout, /Usage: atris agent \[doctor\|spawn\|spawns\|spawn-status\]/);
});

test('agent dogfood is gated from public CLI', () => {
  const dir = makeTempDir();
  let res;
  try {
    res = runCli(['agent', 'dogfood', '--help'], { cwd: dir });
  } finally {
    cleanupTempDir(dir);
  }
  assert.equal(res.status, 1);
  assert.match(res.stderr, /internal diagnostic/);
  assert.match(res.stderr, /atris agent doctor/);
});

test('agent dogfood help is available only behind internal gate', () => {
  const dir = makeTempDir();
  let res;
  try {
    res = runCli(['agent', 'dogfood', '--help'], {
      cwd: dir,
      env: { ...process.env, ATRIS_INTERNAL_AGENT_DOGFOOD: '1' },
    });
  } finally {
    cleanupTempDir(dir);
  }
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /Internal usage: atris agent dogfood/);
});

test('agent spawn creates a durable worker request without auth', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['agent', 'spawn', 'worker', '--task', 'Fix one bounded bug', '--engine', 'codex', '--account', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'spawn_created');
    assert.equal(payload.request.role, 'worker');
    assert.equal(payload.request.task, 'Fix one bounded bug');
    assert.equal(payload.request.engine, 'codex');
    assert.match(payload.request.command, /^codex exec /);

    const list = runCli(['agent', 'spawns', '--account', '--json'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.equal(JSON.parse(list.stdout).requests.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business slug matcher accepts config aliases', () => {
  const business = {
    slug: 'acme',
    name: 'Acme Co',
    config: { aliases: ['atris'] },
  };

  assert.equal(businessMatchesSlug(business, 'acme'), true);
  assert.equal(businessMatchesSlug(business, 'atris'), true);
  assert.equal(businessMatchesSlug(business, 'Acme Co'), false);
  assert.equal(businessMatchesSlug(business, 'Acme Co', { includeName: true }), true);
});

test('business doctor plans safe cache repoints for stale duplicate rows', () => {
  const active = {
    id: 'active-example',
    slug: 'example-customer-ops',
    name: 'example-customer-ops',
    workspace_id: 'active-workspace',
    config: {},
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [active],
    cache: {
      'example-customer-ops': {
        business_id: 'deleted-duplicate',
        workspace_id: 'deleted-workspace',
        name: 'example-customer-ops',
        slug: 'example-customer-ops-1',
      },
    },
    folderBindings: [],
  });

  assert.ok(analysis.issues.some((issue) => issue.code === 'stale-cache-repoint'));
  assert.equal(analysis.cacheUpdates['example-customer-ops'].business_id, 'active-example');
  assert.equal(analysis.cacheUpdates['example-customer-ops'].workspace_id, 'active-workspace');
  assert.equal(analysis.cacheUpdates['example-customer-ops'].slug, 'example-customer-ops');
});

test('business doctor accepts clean alias folders and asks for missing alias cache', () => {
  const atrisLabs = {
    id: 'biz-acme',
    slug: 'acme',
    name: 'Acme Co',
    workspace_id: 'workspace-acme',
    config: { aliases: ['atris'] },
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [atrisLabs],
    cache: {
      'acme': {
        business_id: 'biz-acme',
        workspace_id: 'workspace-acme',
        name: 'Acme Co',
        slug: 'acme',
      },
    },
    folderBindings: [{
      name: 'atris',
      isSymlink: false,
      hasAtris: true,
      hasBusinessJson: true,
      meta: {
        business_id: 'biz-acme',
        workspace_id: 'workspace-acme',
        name: 'Acme Co',
        slug: 'atris',
        canonical_slug: 'acme',
      },
    }],
  });

  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-name-not-slug-or-alias'), false);
  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-slug-mismatch'), false);
  assert.equal(analysis.cacheUpdates.atris.business_id, 'biz-acme');
  assert.equal(analysis.cacheUpdates.atris.canonical_slug, 'acme');
});

test('ensureWikiScaffold migrates legacy syntheses pages into briefs', () => {
  const dir = makeTempDir();
  try {
    const wikiDir = path.join(dir, 'atris', 'wiki');
    const legacyDir = path.join(wikiDir, 'syntheses');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(wikiDir, 'index.md'),
      '# Atris Wiki Index\n\n## Syntheses\n\n- [[atris/wiki/syntheses/example.md]]\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(legacyDir, 'example.md'),
      '---\ntype: synthesis\nslug: example\ntitle: Example\n---\n# Example\n',
      'utf8'
    );

    ensureWikiScaffold(dir);

    const briefsPath = path.join(wikiDir, 'briefs', 'example.md');
    assert.ok(fs.existsSync(briefsPath));
    assert.equal(fs.existsSync(legacyDir), false);
    assert.match(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), /## Briefs/);
    assert.doesNotMatch(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), /syntheses/);
    assert.match(fs.readFileSync(briefsPath, 'utf8'), /^type: brief$/m);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search without workspace data prints compact empty result', () => {
  const dir = makeTempDir();
  try {
    // an atris folder exists but is empty: compact rows, not the init hint
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Feature: none/);
    assert.match(res.stdout, /Journal: none/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search finds matches in journal files', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n- **I1:** Fix the auth module\n');
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Journal:\n- atris\/logs\/\d{4}\/\d{4}-\d{2}-\d{2}\.md:5: - \*\*I1:\*\* Fix the auth module/);
    assert.match(res.stdout, /auth/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search is case-insensitive', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Notes\n\nDebugged the AUTH flow\n');
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Journal:\n- atris\/logs\/\d{4}\/\d{4}-\d{2}-\d{2}\.md:5: Debugged the AUTH flow/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search with no matches prints no matches', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Notes\n\nNothing relevant here\n');
    const res = runCli(['search', 'xyznonexistent'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Journal: none/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// analytics
// ============================================

test('analytics exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics shows zero completions on fresh workspace', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Total completions:\s+0/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics counts completions in journal', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Completed ✅\n\n- **C1: Shipped auth**\n- **C2: Fixed bug**\n\n## Inbox\n\n');
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Today should show 2 completions
    assert.match(res.stdout, /2/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics counts inbox items when Inbox is last section', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Inbox at the end with no ## or --- after it (regression test)
    writeTodayLog(dir, '# Log\n\n## Completed ✅\n\n---\n\n## Inbox\n\n- **I1:** Fix auth\n- **I2:** Add tests\n');
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Inbox items:\s+2/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('getRecentSignals returns empty commit/wiki/lesson signals when sources are missing', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.rmSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), { force: true });
    fs.rmSync(path.join(dir, 'atris', 'lessons.md'), { force: true });

    const signals = getRecentSignals(dir);
    assert.deepEqual(signals.recentCommits, []);
    assert.equal(signals.wikiHealth, null);
    assert.deepEqual(signals.recentLessons, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('getRecentSignals reads recent git commits, wiki health, and last 10 lesson lines', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const initResult = runGit(['init'], dir);
    assert.equal(initResult.status, 0, initResult.stderr);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    const commitResult = runGit(['commit', '-m', 'seed workspace'], dir);
    assert.equal(commitResult.status, 0, commitResult.stderr);

    const statusPath = path.join(dir, 'atris', 'wiki', 'STATUS.md');
    fs.writeFileSync(statusPath, '# STATUS\n\nHealth: 3/5\nNext move: tighten loop\n', 'utf8');

    const lessonsPath = path.join(dir, 'atris', 'lessons.md');
    const lessonLines = Array.from({ length: 12 }, (_, i) => `- lesson ${i + 1}`);
    fs.writeFileSync(lessonsPath, `${lessonLines.join('\n')}\n`, 'utf8');

    const signals = getRecentSignals(dir);
    assert.equal(signals.recentCommits.length, 1);
    assert.match(signals.recentCommits[0], /seed workspace/);
    assert.match(signals.wikiHealth, /Health: 3\/5/);
    assert.equal(signals.recentLessons.length, 10);
    assert.deepEqual(signals.recentLessons, lessonLines.slice(-10));
  } finally {
    cleanupTempDir(dir);
  }
});

test('renderHumanTickIntro keeps the default autopilot briefing plain and narrow', () => {
  const text = renderHumanTickIntro({
    time: '11:20 a.m.',
    identity: 'Ship one clean step at a time.',
    slug: 'loop-self-seeds-horizons',
    horizon: 'Teach the loop to imagine the next horizon when the queue goes quiet.',
    total: 5,
    done: 2
  }, {
    auto: true,
    durationLabel: 'until clean'
  });

  assert.match(text, /I am starting an autopilot tick in autonomous mode\./);
  assert.match(text, /Progress is 2 of 5 endgame steps\./);
  assert.doesNotMatch(text, /[┌┐└┘│]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
  }
});

test('renderHumanSuggestion keeps the default suggestion briefing plain and narrow', () => {
  const text = renderHumanSuggestion({
    task: 'Rewrite the autopilot tick output to match the chief-of-staff format.',
    why: 'The current box-heavy output makes it hard for a non-technical reader to decide whether to let the loop continue.',
    kind: 'execute'
  }, 1, 4);

  assert.match(text, /I picked task 1 of 4\./);
  assert.match(text, /Next: approve it, skip it, or stop the loop\./);
  assert.doesNotMatch(text, /[┌┐└┘│]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
  }
});

// ============================================
// visualize
// ============================================

test('visualize exits 1 when no journal exists', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Remove any auto-created log
    const logsDir = path.join(dir, 'atris', 'logs');
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris log/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize exits 1 when inbox is empty', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n\n## Notes\n\n');
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Inbox|inbox/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize renders breakdown for inbox items', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n- **I1:** Build the dashboard\n\n## Notes\n\n');
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Build the dashboard/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize dry-run accepts any prompt without requiring inbox', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['visualize', 'show the connect-api workflow for onboarding', '--dry-run'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Visualize dry run/);
    assert.match(res.stdout, /gpt-image-2/);
    assert.match(res.stdout, /connect-api workflow/);
    assert.match(res.stdout, /Artifact type: workflow/);
    assert.match(res.stdout, /atris\/reports\/visuals/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize dry-run supports custom output and raw prompt', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli([
      'visualize',
      'exact raw diagram prompt',
      '--dry-run',
      '--raw',
      '--out',
      'custom/path.png',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /custom\/path\.png/);
    assert.match(res.stdout, /exact raw diagram prompt/);
    assert.doesNotMatch(res.stdout, /Workspace context to respect/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// clean
// ============================================

test('clean exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean --json reports missing atris folder without text chrome', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean', '--json'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.action, 'clean');
    assert.match(payload.error, /atris\/ folder not found/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean --help prints usage without touching workspace', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris clean/);
    assert.match(res.stdout, /--dry-run/);
    assert.match(res.stdout, /--json/);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean --dry-run --json reports machine-readable health', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['clean', '--dry-run', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'clean');
    assert.equal(payload.dry_run, true);
    assert.equal(payload.results.stale_tasks.count, 0);
    assert.equal(typeof payload.results.map_refs.healed_count, 'number');
    assert.equal(payload.results.map_refs.verb, 'would_heal');
    assert.equal(Array.isArray(payload.results.map_refs.items), true);
    assert.equal(typeof payload.results.stale_pages.count, 'number');
    assert.equal(Array.isArray(payload.results.stale_pages.items), true);
    assert.equal(Array.isArray(payload.manual_action), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean dry-run shows MAP refs it would heal', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), [
      'function main() {',
      '  return true;',
      '}',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), [
      '# MAP.md',
      '',
      '- `src/app.js:20` (`main`)',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['clean', '--dry-run', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.results.map_refs.healed_count, 1);
    assert.deepEqual(payload.results.map_refs.items, [
      {
        old: '`src/app.js:20`',
        new: '`src/app.js:1`',
        symbol: 'main',
      },
    ]);
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8'), /src\/app\.js:20/);

    const text = runCli(['clean', '--dry-run'], { cwd: dir });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Would heal 1 MAP\.md reference/);
    assert.match(text.stdout, /`src\/app\.js:20` -> `src\/app\.js:1` \(main\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean reports clean workspace on fresh init', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['clean'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Should complete without crashing
    assert.match(res.stdout, /clean|stale|target/i);
  } finally {
    cleanupTempDir(dir);
  }
});
