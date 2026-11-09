'use strict';

// A read-only recommendation. Existing task commands own every transition.
const { readFlag } = require('./arg-parser');
const { workerEnvMarker } = require('./task-core');
const { autoJobForMember } = require('./member-engine');
const { skipReason, heldForPerson, taskCheck } = require('./member-task-pick');
const { buildNextWorkContext } = require('./next-work-context');

const text = (value) => typeof value === 'string' ? value.trim() : '';
const quote = (value) => /^[A-Za-z0-9_.:-]+$/.test(String(value))
  ? String(value) : "'" + String(value).replace(/'/g, "'\\''") + "'";
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : null;
const ref = (task) => identifier(task?.display_id) || identifier(task?.id) || '';
const certified = (task) => task?.review?.agent_certified === true || task?.metadata?.agent_certified === true;

function agentCaller(args = [], env = process.env) {
  if (args.includes('--human')) return null;
  const explicit = args.some((arg) => arg === '--agent' || arg.startsWith('--agent='));
  if (!explicit && env.ATRIS_AGENT_PROOF_ONLY === '0') return null;
  if (!explicit && !workerEnvMarker(env) && !text(env.ATRIS_AGENT_ID)) return null;
  const named = text(readFlag(args, '--agent'));
  const as = text(readFlag(args, '--as'));
  const member = named || as || text(env.ATRIS_AGENT_ID) || 'builder';
  const error = named && as && named !== as ? 'conflicting_owner'
    : !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(member) ? 'invalid_owner' : null;
  return { kind: 'agent', member, error };
}

function checkFor(task) {
  const metadata = task?.metadata || {};
  const command = text(metadata.verify) || text(metadata.proof_needed);
  return {
    command,
    runnable: Boolean(command) && command.length <= 600
      && taskCheck({ metadata: { verify: command } }).runnable,
  };
}

function planningNeeds(task) {
  const meta = task.metadata || {};
  const needs = [];
  if (!checkFor(task).runnable) needs.push('runnable_check');
  if (!(text(meta.task_goal) || text(meta.goal_objective) || text(meta.objective) || text(meta.stage_goal))) needs.push('goal');
  if (!(text(meta.exit_condition) || text(meta.done_looks_like))) needs.push('exit_condition');
  if (!text(meta.first_move)) needs.push('first_move');
  if (!(meta.planned_at || meta.stage_plan_recorded_at || meta.stage === 'plan' || meta.stage === 'do')) needs.push('recorded_plan');
  return needs;
}

function builtBy(task, member) {
  const meta = task.metadata || {};
  const actors = [task.claimed_by, ...(Array.isArray(meta.built_by) ? meta.built_by : [meta.built_by])];
  return actors.some((actor) => text(actor) === member);
}

function recommendAgentWork({ tasks = [], member, job = 'build', taskSource = 'database', taskId = '' } = {}) {
  const pending = tasks.filter((task) => taskSource === 'database' && identifier(task?.id)
      && task?.status === 'review' && certified(task))
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .slice(0, 5).map((task) => ({
      task_id: task.id || null, reference: ref(task) || null,
      reason: 'human_acceptance', human_only: true,
      command: ref(task) ? 'atris task accept ' + quote(ref(task)) : null,
    }));
  const result = (task, action, reason, needs = []) => ({
    task, action, reason, needs, human_pending: pending,
  });
  const bound = taskId ? tasks.find((task) => task.id === taskId || ref(task) === taskId) : null;
  if (taskId && !bound) return result(null, 'blocked', 'The requested task is not in current workspace evidence.', ['current_task']);
  if (bound && taskSource !== 'database') {
    return result(bound, 'discover', 'Confirm the bound task state before relying on this snapshot.', ['authoritative_task_state']);
  }
  const rows = taskId ? [bound] : tasks;
  const eligible = rows.filter((task) => {
    if (!task || typeof task !== 'object') return false;
    // An absent or unusable check still permits planning. It never permits
    // claiming or executing; ownership and human holds remain unchanged.
    const probe = { ...task, metadata: { ...task.metadata, verify: '' } };
    return !skipReason(probe, job, { member, recoverClaimed: true });
  }).sort((a, b) => Number(b.status === 'claimed') - Number(a.status === 'claimed')
    || Number(Boolean(text(b.metadata?.assigned_to))) - Number(Boolean(text(a.metadata?.assigned_to)))
    || Number(a.created_at || 0) - Number(b.created_at || 0)
    || String(a.id || '').localeCompare(String(b.id || '')));
  let selected = eligible[0] || null;
  if (!selected && job === 'review') {
    selected = rows.find((task) => task?.status === 'review' && !certified(task)
      && !heldForPerson(task) && !builtBy(task, member)) || null;
    if (selected) {
      if (taskSource !== 'database') return result(selected, 'discover', 'Confirm the current task state before reviewing this snapshot.', ['authoritative_task_state']);
      return result(selected, 'review', 'An independent reviewer can check the finished work.');
    }
  }
  if (!selected) {
    if (bound) return result(bound, 'blocked', 'The requested task is held, finished, or owned elsewhere.', ['eligible_task']);
    return result(null, 'discover', 'No eligible work is recorded. Inspect the goal and prior results before proposing one verifiable change.', ['eligible_task']);
  }
  if (taskSource !== 'database') {
    return result(selected, 'discover', 'Confirm current task evidence before claiming or changing this snapshot.', ['authoritative_task_state']);
  }
  const needs = planningNeeds(selected);
  if (needs.length) return result(selected, 'plan', 'Inspect this task and record its goal, exit, first move and runnable check before starting it.', needs);
  return selected.status === 'claimed'
    ? result(selected, 'continue', 'Continue the owned work and collect real proof before marking it ready.')
    : result(selected, 'claim', 'This owned or matching task has a recorded plan and runnable check.');
}

function recommendationCommand(decision, member) {
  if (decision.action === 'discover') return null;
  const taskRef = ref(decision.task);
  if (!taskRef) return null;
  if (decision.action === 'claim') return 'atris task claim ' + quote(taskRef) + ' --as ' + quote(member);
  if (decision.action === 'review') return 'atris task review-chat ' + quote(taskRef) + ' --as ' + quote(member);
  return 'atris task page ' + quote(taskRef) + ' --json';
}

function buildAgentNext({ root = process.cwd(), args = [], env = process.env, snapshot, tasks, scope = {}, evidence } = {}) {
  const caller = agentCaller(args, env);
  if (!caller) return null;
  const taskDb = require('./task-db');
  const workspaceRoot = taskDb.workspaceRoot(root);
  const taskId = text(readFlag(args, '--task'));
  const state = snapshot || require('./first-minute').loadLocalTaskState(workspaceRoot, {
    includeAllActive: true, taskIds: taskId ? [taskId] : [],
  });
  const rows = tasks || state.tasks;
  const decision = caller.error
    ? { task: null, action: 'blocked', reason: 'Name one valid functional owner for this agent.', needs: ['functional_owner'], human_pending: [] }
    : recommendAgentWork({ tasks: rows, member: caller.member, job: autoJobForMember(caller.member, ''), taskSource: state.source, taskId });
  if (decision.task && !identifier(decision.task.id)) {
    decision.action = 'discover';
    decision.needs.push('stable_task_identity');
    decision.reason = 'Confirm a stable task identity before using this evidence.';
  }
  const command = recommendationCommand(decision, caller.member);
  const context = evidence || buildNextWorkContext({
    root: workspaceRoot, tasks: rows, selected: decision.task, owner: caller.member,
    taskSource: state.source, generatedAt: state.generated_at,
  });
  // The existing evidence packet keeps its own factual gaps. The action is
  // the owner's next permitted step, not a claim that a check has passed.
  context.next_step.kind = decision.action === 'plan' ? 'discover'
    : ['claim', 'continue'].includes(decision.action) ? 'execute'
    : decision.action === 'review' ? 'review' : decision.action === 'discover' ? 'discover'
    : ['human_decision', 'wait'].includes(context.next_step.kind) ? context.next_step.kind : 'discover';
  context.next_step.reason = decision.reason;
  const task = decision.task;
  return {
    schema: 'atris.agent_next.v1', ok: !caller.error, status: decision.action === 'blocked' ? 'blocked' : 'ok',
    actor: { kind: 'agent', member: caller.error ? null : caller.member },
    owner: caller.error ? null : caller.member, action: decision.action,
    task_id: identifier(task?.id), reference: task ? ref(task) || null : null,
    command, reason: decision.reason, needs: decision.needs,
    task: task ? {
      id: identifier(task.id), display_id: identifier(task.display_id),
      title: text(task.title).slice(0, 240), status: task.status,
      claimed_by: task.claimed_by || null, assigned_to: task.metadata?.assigned_to || null,
    } : null,
    human_pending: decision.human_pending, context, scope,
    safety: { read_only: true, claims_work: false, human_accept: false, awards_xp: false },
  };
}

function printAgentNext(payload, { asJson = false, alias = 'next_action', log = console.log } = {}) {
  if (asJson) {
    log(JSON.stringify({ ...payload, [alias]: payload.command }, null, 2));
    return 0;
  }
  const title = payload.task?.title;
  const message = payload.action === 'plan' && title ? 'plan ' + title + ' and define its check.'
    : payload.action === 'claim' && title ? title + ' has a plan and a check.'
    : payload.action === 'continue' && title ? 'continue ' + title + '.'
    : payload.reason;
  log(message.replace(/^[A-Z]/, (letter) => letter.toLowerCase()));
  if (payload.human_pending.length) log('\nhuman approval is still pending; this step does not accept that work.');
  if (payload.command) log('\nnext: ' + payload.command);
  return 0;
}

module.exports = { agentCaller, planningNeeds, recommendAgentWork, buildAgentNext, printAgentNext };
