'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { hasFlag } = require('./arg-parser');
const {
  compactErrorPayload,
  printCliJson,
} = require('./cli-json');
const {
  taskProofState,
  LOCAL_SUCCESS_PROOF_EXAMPLE,
  unrunNamedProofCommandIssue,
} = require('./task-proof');
const {
  explanationFieldsFromInput,
} = require('./task-explanation');
const { RECEIPT_PATH_PATTERN } = require('./receipt-evidence');
const { isRetiredFillerReason } = require('./voice-gate');
const { operatorReady, hasAgentJargon, explainResult } = require('../commands/autoland');

const DEFAULT_OWNER = process.env.ATRIS_AGENT_ID
  || process.env.USER
  || os.userInfo().username
  || 'unknown';
const AGENT_CERTIFICATION_REVIEW_PASSES = 2;
const RESULT_SAVED_TEXT_LIMIT = 200;
const REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS = 3;
const REVIEW_LANE_LOOP_MAX_STEPS = 10;
const REVIEW_LANE_RUN_DEFAULT_MAX_RUNS = 3;
const REVIEW_LANE_RUN_MAX_RUNS = 20;
const PENDING_REVIEW_CHAT_STOP_REASON = 'pending_review_chat_waiting_for_agent_review';
const PROOF_BOUNDARY_BLOCKED_ACTION = 'proof_boundary_blocked';
const PROOF_BOUNDARY_BLOCKED_REASON = 'proof_boundary_blocked_requires_revision';
const MISSION_XP_END_TO_END_REASON = 'mission_xp_requires_end_to_end_receipt';
const MISSION_XP_END_TO_END_DETAIL = 'mission XP proof must name a zero-papercut end-to-end fresh-laptop pass through install, init, first mission, and first self-landed task; generic mission/tick receipts are not enough';
const READY_RESULT_TEACHING = 'ready needs --result: one plain sentence someone new to the project can understand. say what someone can do now and why it matters. no ids, no paths, no commands. example: operators can now read the whole team day on one page instead of scrolling raw logs.';

const STATUS_PLAN_TAGS = new Set([
  'agent',
  'autopilot',
  'cron',
  'endgame',
  'execute',
  'explore',
  'feature',
  'goal',
  'goal-step',
  'loop',
  'plan',
  'planned',
  'schedule',
  'scheduled',
  'shape',
  'shaping',
  'ui',
  'ux',
]);
const TASK_QUEUE_COLUMN_ORDER = ['do', 'review', 'plan', 'backlog', 'blocked', 'done'];
const TASK_QUEUE_COLUMN_LABELS = {
  backlog: 'Backlog',
  plan: 'Plan',
  do: 'Do',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
};
const TASK_REVIEW_STATE_LANES = ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified'];
const TASK_REVIEW_STATE_ALIASES = {
  'needs-agent': ['needs-review', 'agent-review'],
  'continue-work': ['continue', 'agent-actionable', 'executable'],
  'proof-boundary-blocked': ['proof-boundary', 'boundary-blocked', 'stale-pr-proof', 'unmerged-pr-proof'],
  'human-accept-waiting': ['human-accept', 'accept-waiting', 'waiting-accept', 'no-next-task'],
  certified: ['waiting-human', 'human-waiting'],
};

let taskDbModule = null;

function getTaskDb() {
  if (taskDbModule) return taskDbModule;
  try {
    taskDbModule = require('./task-db');
    return taskDbModule;
  } catch (e) {
    const message = String(e && (e.message || e));
    const missingSqlite = e && (
      e.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
      || /node:sqlite|No such built-in module/i.test(message)
    );
    if (missingSqlite) {
      console.error('atris task requires Node.js 22+ because it uses built-in node:sqlite.');
      console.error('Use the markdown TODO.md flow on older Node versions.');
      process.exit(1);
    }
    throw e;
  }
}

function warnIfTaskTitleNeedsOperatorWhy(title, options = {}) {
  const text = String(title || '').trim();
  if (!text || operatorReady(text)) return null;
  const warning = 'Warning: put the why in this task title in plain words: what it buys or costs, and who benefits. Drop flags and ids.';
  if (options.print !== false) console.error(warning);
  return warning;
}

function taskUsageText() {
  return `
atris task - durable local task state (SQLite, gitignored)

  golden path (one tick, by cron or by hand):
    atris task delegate "fix the login bug" --to <member>
    atris task claim <id> --as <member>
    ... build ...
    atris task ready <id> --verify
    atris autoland tick   # second check runs, task lands

  atris task                              Same two-line next as bare atris
  atris task desk [--all]                 Show the full task desk
  atris task new "<title>" [--what-changes "..."] [--why-it-matters "..."] [--done-looks-like "..."] [--verify <cmd>]
                                           Create a task with a plain explanation; omitted fields get honest defaults
  atris task next [--tag <tag>] [--agent <member>|--human] [--create-next]
                                           Show the next human or agent step; agent recommendations are read-only
  atris task continue-work <id>           Create/reuse a certified Review follow-up task
  atris task say <id> "<message>"         Add context to a task
  atris task chat <id> "<message>" [--goal "..."]  Refine a task chat + working goal
  atris task ready <id> --proof "..." --result "<sentence>" [--work-root <path>]
                                           Agent proof ready; native goal can complete
                                           --work-root names the copy you built in and the job records that copy's commit; ATRIS_WORK_ROOT is the fallback and a relative path resolves from the current folder
  atris task ready <id> --verify "<cmd>" --result "<sentence>"
                                           Run <cmd>; only ready if it exits 0 (executed proof)
                                           Writes atris/runs/ receipt (pass or fail); that local pass is enough proof
                                           Optional CI URL only with --proof-url and --i-fetched
  atris task receipt <id> --verify "<cmd>" Run <cmd> and write an atris/runs/ receipt without going to ready
  atris task plan-preview "<purpose>" [--tag <tag>] [--owner <member>] [--task <id>]
                                           Show the plain Plan before work starts
  atris task ready <id> --proof "..." --result "<sentence>" [--changed "..." --checked "..." --saved "..." --try "..."]
                                           Agent proof ready; records Result if needed
  atris task ready <id> --proof "..." --result "<sentence>" [--happened "..." --checked "..." --tested "..." --decision "..."]
                                           Agent proof ready; writes the human result receipt
  atris task result <id> "<sentence>"       Set or replace the day-one PM result sentence
  atris task result <id> --changed "..." --checked "..." [--saved "..."] [--try "..."]
                                           Show the plain Result and store trace on the task
  atris task review-chat <id> [--as <owner>]  Start a task-owned /codex verification chat
  atris task accept <id> [--proof "..."] [--public]
                                           Human accepts proof, marks done; --public also publishes AgentXP
  atris task certify-verified [--dry-run] [--limit <n>] [--as <actor>]
                                           Re-run the runnable check named in each Review proof as a second actor; passing rows certify (denied lanes and check-less rows wait for a human)
  atris task auto-accept-certified --dry-run [--strict-verify] [--all] [--limit <n>]
                                           Preview certified Review rows; live accept needs --confirm-human-accept --as <human>
  atris task sweep --auto-accept [--json]   Auto-accept verified Review rows; protected lanes wait for human
  atris task sweep [--json] [--stale-days N] [--claimer NAME] [--dry-run]   Release expired claims
  atris task sweep --held [--everywhere] [--dry-run] [--json]   Check held jobs against GitHub: credit a merge, release a closed pull request
  atris task audit [--limit <n>] [--revise] re-run stored verifies for newest accepted tasks; report-only unless --revise
  atris task revise <id> --note "..."      Send reviewed work back to Do

  atris task add "<title>" [--tag <tag>] [--goal-id <id>] [--what-changes "..."] [--why-it-matters "..."] [--done-looks-like "..."] [--verify <cmd>]  Create a task
  atris task delegate "<title>" [--to <member>] [--executed-by <engine>] [--goal-id <id>] [--tag <tag>] [--what-changes "..."] [--why-it-matters "..."] [--done-looks-like "..."] [--verify <cmd>]  Create assigned work
  atris task plan <id> --goal "..." --exit "..." --proof-needed "..."
                                           Record a task-owned Plan stage
  atris task do <id> --as <owner> --first-move "..."
                                           Start task-owned Do work from the plan
  atris task backlog <id> [--reason "..."] Move a planned open task back to Backlog
  atris task clear-plan --yes              Move all planned open tasks back to Backlog
  atris task day [--full] [--all] [--everywhere] [--json]  show today's owner-grouped task list
                                           text shows eight current rows; --full shows every active row
                                           --all stays in this workspace; --everywhere spans workspaces
  atris task list [--all] [--everywhere] [--status <s>]
                                           list tasks in this workspace; --everywhere spans workspaces
  atris task claim <id> [--as <owner>]     Atomic claim
  atris task release <id> [--as <owner>] [--reason "<why>"]   Release your own mistaken claim back to open
  atris task capabilities [--json]         Read-only task CLI/API capability contract
  atris task capabilities-check [--json]   Verify task capability contract conformance
  atris task review-lane-drain [--json]    Pick next safe Review-lane agent action
  atris task review-lane-act [--json]      Execute next safe Review-lane agent action
  atris task review-lane-loop [--json]     Run bounded safe Review-lane actions
  atris task review-lane-run [--json]      Run bounded review-lane loops and write receipts
  atris task current [--json] [--goal-id <id>] [--tag <tag>] [--status <s>] [--review-state <lane>]
                                           Read-only best next task page + queue
  atris task queue [--json] [--goal-id <id>] [--tag <tag>] [--status <s>] [--review-state <lane>]
                                           Read-only task lanes + current page
  atris task current-step [--json] [--goal-id <id>] [--tag <tag>] [--review-state <lane>]
                                           Advance the scoped current task one safe step
                                           review-state lanes: needs-agent, continue-work, human-accept-waiting, certified
  atris task note <id> "<message>"         Append dialogue/context to a task
  atris task retitle <id> "<new title>"    Rename a task and preserve the old title in dialogue
  atris task tag <id> --add <tag> [--remove <tag>]
                                           Update tags on an existing task (e.g. --add needs-human to hold it
                                           from sweep + fleet staffing); logs a task_tags_updated event
  atris task show <id> [--json]            Show a task card + dialogue
  atris task inspect <id> --fields review,status,title [--json]
                                           Field-selectable task state (review metadata, status, title, owner, tag)
  atris task page <id> [--json]            Show the one-task page contract
  atris task step <id> [--json]            Refine chat, then advance one safe Plan/Do/Review step
  atris task done <id> --proof "..."       Mark complete with proof
  atris task done <id> --failed [--proof "..."]  Mark failed, optionally reviewed
  atris task archive <id> --reason "..." [--from-failed] [--not-needed]
                                           Sweep off-roadmap/duplicate work as archived (not failed);
                                           --from-failed opts in to relabel a fail-closed row (never done)
                                           --not-needed: a person confirms the job did not need doing, so a
                                           drop on it stops counting against the member (needs --reason;
                                           refused inside an agent session or a dispatched worker)
  atris task reopen <id> [--reason "..."]  Send a done, waiting, failed, or archived task back to open
  atris task clear-done [--before <days>] [--dry-run] [--json]  Archive completed rows, oldest first
  atris task prune-test-junk [--yes] [--vacuum] [--json]
                                           Count rows test runs left from temp folders; --yes backs up the db, then removes them
  atris task keep [--json]                 Put away finished and untouched work, then refresh the list
  atris task reap-mission-blockers [--json] Close blocker rows whose missions are complete or stopped
  atris task relabel-archived [--dry-run|--apply]
                                           One-time OBL-1622 migration: relabel June-10 backlog-reset rows failed -> archived
  atris task finish <id> --proof "..."     Legacy alias for done with proof
  atris task review <id> --reward <n> [--verify "<cmd>"]
                                           Write review event + RSI episode
  atris task reviews [--all|--limit <n>] [--verbose]   Show certified Review items for human accept/revise
  atris task reviews --group-by <tag|owner|source>   Cluster approval-ready work for fast triage
  atris task accept-group <key>=<value> --spot-check K --confirm-human-accept --as <you> --verified <ids>
                                           Accept a whole cluster; career XP only on the K you verified
  atris task status [--json] [--history]   Compact live status for web/Swarlo
  atris task setup [--import-todo]         Create/refresh task projection
  atris task serve [--port <n>]            Open local task factory board
  atris task sync --dry-run                Plan cloud/Swarlo task sync writes
  atris task import <file>                 One-shot import from TODO.md
  atris task lineage <id> [--json]          Show endgame -> tasks -> commits chain
  atris task events [id] [--limit <n>]     print recent task events
  atris task events --all                  print the full current-workspace ledger
  atris task events --everywhere           print the full ledger across workspaces
  atris task export [--all] [--everywhere] [--out <file>]
                                           write web/desktop JSON projection
  atris task render [--all] [--everywhere] [--out <file>]
                                           regenerate compact TODO.md view from state
  atris task where                          Print db path + workspace scope
  atris task help                           This help

Confidence Gate:
  Before plan/do/review advances, find loopholes, patch them with proof,
  verifier, owner, rollback, or name the residual risk.

Env:
  ATRIS_TASKS_DB    Override db path (default ~/.atris/tasks.db)
  ATRIS_AGENT_ID    Owner id for claim/done (default: $USER)

Refs:
  Human views use semantic refs like OBL-18. Commands accept OBL-18,
  OBL18, full 26-char task IDs, and any unique legacy prefix. JSON/API
  keep the full id as canonical and also expose display_id + legacy_ref.

Headless:
  Add --json to task commands for machine-readable output and stable automation.
`.trim();
}

function taskUsageLines() {
  return taskUsageText().split('\n');
}

function help() {
  console.log(taskUsageText());
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || true;
}

function taskScopeEverywhere(args = [], options = {}) {
  if (options.everywhere !== undefined) return Boolean(options.everywhere);
  return hasFlag(args, '--everywhere');
}

function scopedWorkspaceRoot(taskDb, args = [], options = {}) {
  return taskScopeEverywhere(args, options) ? null : taskDb.workspaceRoot();
}

function hasEmptyFlagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] === '';
}

function wantsJson(args) {
  return hasFlag(args, '--json');
}

function parseAcceptReward(value, { defaultValue = 1 } = {}) {
  if (value === undefined || value === null || value === true) return { ok: true, value: defaultValue };
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { ok: false, reason: 'invalid_reward' };
  }
  return { ok: true, value: numeric };
}

function validHumanActorFlag(value) {
  if (typeof value !== 'string') return false;
  const actor = value.trim();
  return Boolean(actor) && !actor.startsWith('--') && actor !== 'auto-accept-certified';
}

const AGENT_ENV_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CURSOR_AGENT',
  'DEVIN_SESSION_ID',
];

function agentProofOnlyMode() {
  const explicit = process.env.ATRIS_AGENT_PROOF_ONLY;
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return Boolean(workerEnvMarker());
}

const WORKER_ENV_MARKERS = [
  ...AGENT_ENV_MARKERS,
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'ATRIS_MISSION_DRIVER_DETACHED',
  'ATRIS_MISSION_DRIVER_PARENT_PID',
  'ATRIS_DISPATCH_DEPTH',
];

function workerEnvMarker(env = process.env) {
  const found = WORKER_ENV_MARKERS.find((marker) => String(env[marker] || '').trim() !== '');
  if (found) return found;
  return String(env.ATRIS_AGENT_PROOF_ONLY || '').trim() === '1' ? 'ATRIS_AGENT_PROOF_ONLY' : '';
}

function failAgentProofOnly(label, detail) {
  failTask(
    label,
    'agent_proof_only_human_accept_blocked',
    detail || 'Agent proof-only mode can write notes, ready proof, and zero-reward reviews, but cannot mark tasks done or accept XP.',
  );
}

function writeStdoutSync(text) {
  const buffer = Buffer.from(text, 'utf8');
  const retryWait = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(process.stdout.fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        Atomics.wait(retryWait, 0, 0, 10);
        continue;
      }
      throw err;
    }
  }
}

function printJson(value) {
  writeStdoutSync(`${JSON.stringify(value, null, 2)}\n`);
}

function refreshCareerXpProjection(workspaceRoot) {
  if (!workspaceRoot) return null;
  try {
    const { collectLocalXpProjection } = require('../commands/xp');
    const { careerXpRoot } = require('./career-xp-root');
    return collectLocalXpProjection(['--workspace', careerXpRoot(workspaceRoot)]);
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function refreshCareerXpAfterReview(reviewed) {
  return refreshCareerXpProjection(reviewed?.episode?.workspace_root);
}

function compactCareerXpProjection(projection) {
  if (!projection || typeof projection !== 'object') return projection;
  const progress = projection.next_level_progress && typeof projection.next_level_progress === 'object'
    ? {
      level: projection.next_level_progress.level ?? null,
      next_level: projection.next_level_progress.next_level ?? null,
      current_xp: projection.next_level_progress.current_xp ?? null,
      required_xp: projection.next_level_progress.required_xp ?? null,
      remaining_xp: projection.next_level_progress.remaining_xp ?? null,
      percent: projection.next_level_progress.percent ?? null,
    }
    : null;
  const latest = projection.latest_accepted_proof && typeof projection.latest_accepted_proof === 'object'
    ? {
      label: projection.latest_accepted_proof.label ?? null,
      receipt_id: projection.latest_accepted_proof.receipt_id ?? null,
      source: projection.latest_accepted_proof.source ?? null,
      source_task_id: projection.latest_accepted_proof.source_task_id ?? null,
      title: projection.latest_accepted_proof.title ?? null,
      xp: projection.latest_accepted_proof.xp ?? null,
      reward: projection.latest_accepted_proof.reward ?? null,
      accepted_at: projection.latest_accepted_proof.accepted_at ?? null,
      goal: projection.latest_accepted_proof.goal ?? null,
    }
    : null;
  const integrity = projection.integrity && typeof projection.integrity === 'object'
    ? {
      status: projection.integrity.status ?? null,
      receipts_count: projection.integrity.receipts_count ?? projection.receipts_count ?? null,
      head_hash: projection.integrity.head_hash ?? null,
    }
    : null;
  return {
    schema: projection.schema,
    compact: true,
    total_xp: projection.total_xp ?? projection.total_agent_xp ?? projection.agent_xp ?? null,
    agent_xp: projection.agent_xp ?? projection.total_agent_xp ?? null,
    today_xp: projection.today_xp ?? projection.today_agent_xp ?? null,
    collected_receipts: projection.collected_receipts ?? 0,
    receipts_count: projection.receipts_count ?? null,
    level: projection.level ?? null,
    leaderboard_eligible: projection.leaderboard_eligible ?? null,
    integrity_status: projection.integrity_status ?? integrity?.status ?? null,
    next_level_progress: progress,
    latest_accepted_proof: latest,
    integrity,
    omitted: [
      'contribution_graph',
      'career',
      'earning_model',
      'local_activity',
      'ledger',
      'sources',
    ],
  };
}

function jsonModeActive() {
  return process.argv.includes('--json');
}

function failTask(label, reason, detail, exitCode = 2) {
  if (jsonModeActive()) {
    printCliJson(
      {
        ok: false,
        command: label,
        reason,
        detail: detail || null,
        selected_ref: null,
        next_command: null,
      },
      compactErrorPayload({ reason, detail: detail || null }),
      process.argv.slice(2),
    );
  } else {
    console.error(detail || `${label}: ${reason}`);
  }
  process.exit(exitCode);
}

function refuseCandidatePolicyGate(label, gate) {
  if (jsonModeActive()) {
    printJson({ ok: false, command: label, ...gate });
  } else {
    console.error(`${label}: ${gate.reason}: ${gate.message}`);
    if (Array.isArray(gate.offenders)) {
      gate.offenders.forEach((offender) => console.error(`  ${offender}`));
    }
    if (Array.isArray(gate.lesson_ids) && gate.lesson_ids.length) {
      console.error(`  lessons: ${gate.lesson_ids.join(', ')}`);
    }
  }
  process.exit(1);
}

function proofFlagValue(args) {
  const proof = flag(args, '--proof');
  return typeof proof === 'string' ? proof.trim() : '';
}

function resultSentenceIssue(value, { allowCommandMention = false } = {}) {
  const check = explainResult(value, { allowCommandMention });
  return check.ok ? null : check.reason;
}

function readyResultDetail(reason) {
  return reason ? `${READY_RESULT_TEACHING}\n${reason}` : READY_RESULT_TEACHING;
}

function requireResultSentence(label, value, { ready = false, allowCommandMention = false } = {}) {
  const issue = resultSentenceIssue(value, { allowCommandMention });
  if (!issue) return String(value || '').replace(/\s+/g, ' ').trim();
  const detail = ready ? readyResultDetail(issue) : issue;
  failTask(label, 'weak_result', detail);
}

function weakProofDetail(issue) {
  return `meaningful proof required: ${issue}\n${LOCAL_SUCCESS_PROOF_EXAMPLE}`;
}

function requireMeaningfulTaskProof(label, proof, { required = true } = {}) {
  const issue = meaningfulTaskProofIssue(proof, { required });
  if (issue) failTask(label, 'weak_proof', weakProofDetail(issue));
}

function requireRanNamedProofCommand(label, proof, ranCommand = '') {
  const issue = unrunNamedProofCommandIssue(proof, ranCommand);
  if (issue) failTask(label, issue.reason, issue.detail);
}

function sendProofIssue(res, proof, issue) {
  return sendJson(res, 400, {
    ok: false,
    reason: String(proof || '').trim() ? 'weak_proof' : 'proof_required',
    detail: weakProofDetail(issue),
  });
}

function textFlag(args, names) {
  for (const name of names) {
    const value = flag(args, name);
    if (typeof value === 'string') return value.trim();
  }
  return '';
}

function explanationFlags(args) {
  return explanationFieldsFromInput({
    what_changes: textFlag(args, ['--what-changes']),
    why_it_matters: textFlag(args, ['--why-it-matters']),
    done_looks_like: textFlag(args, ['--done-looks-like']),
  });
}

function landingFlags(args) {
  return {
    happened: textFlag(args, ['--landing', '--happened', '--what-happened']),
    checked: textFlag(args, ['--checked', '--how-checked']),
    tested: textFlag(args, ['--tested', '--what-tested']),
    decision: textFlag(args, ['--decision', '--acceptance']),
  };
}

function readyMergeFlags(args) {
  const commit = textFlag(args, ['--merge-commit']);
  const number = textFlag(args, ['--pr-number']);
  const url = textFlag(args, ['--pr-url']);
  if (!commit && !number && !url) return null;
  return {
    merge_commit: commit,
    number,
    url,
    merged_at: textFlag(args, ['--merged-at']),
    self_landed: hasFlag(args, '--self-landed'),
  };
}

function normalizedLandingSentence(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function defaultLandingSentenceForTitle(title) {
  return `Completed: ${String(title || '').trim()}.`;
}

function landingNeedsDayOnePm(sentence, title) {
  const text = normalizedLandingSentence(sentence);
  if (!text) return true;
  if (text.toLowerCase() === normalizedLandingSentence(defaultLandingSentenceForTitle(title)).toLowerCase()) return true;
  return hasAgentJargon(text) || /\bas\s+exists?\b/i.test(text) || !operatorReady(text);
}

function warnIfLandingNeedsDayOnePm(landing, title) {
  const sentence = landing && typeof landing === 'object' ? landing.happened : '';
  if (!landingNeedsDayOnePm(sentence, title)) return null;
  const warning = 'Advisory: add --landing with one plain sentence saying what someone can do now, in words a new teammate would get. No flags, no ids.';
  console.error(warning);
  return warning;
}

function requireExplicitLandingDayOnePm(label, landing, title) {
  const sentence = landing && typeof landing === 'object' ? normalizedLandingSentence(landing.happened) : '';
  if (!sentence || !landingNeedsDayOnePm(sentence, title)) return;
  failTask(
    label,
    'weak_landing',
    'landing needs one plain sentence saying what someone can do now and why it matters, in words a new teammate would understand. no flags, ids, or unnamed filters.',
  );
}

function numericFlag(args, name) {
  const value = flag(args, name);
  if (value === null || value === true || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function meaningfulTaskProofIssue(proof, { required = true } = {}) {
  const text = String(proof || '').trim();
  if (!required && !text) return null;
  const state = taskProofState(text);
  return state.ok ? null : state.reason;
}

function goldenPathMissionXpTask(task) {
  if (!task) return false;
  const metadata = task.metadata || {};
  const text = [
    task.title,
    task.tag,
    metadata.goal_id,
    metadata.goalId,
    metadata.mission_id,
    metadata.stop_condition,
    metadata.goal_objective,
    metadata.objective,
  ].filter(Boolean).join(' ');
  const missionXp = String(task.title || '').trim().toLowerCase().startsWith('mission xp:')
    || String(task.tag || '').toLowerCase() === 'agent-xp';
  return missionXp
    && /\b(?:golden[- ]path|zero[- ]knowledge|zero[- ]papercuts?|fresh[- ](?:laptop|environment|install|home)|self[- ]landed)\b/i.test(text);
}

function debugUnreadableReceipt(rel, err) {
  if (process.env.ATRIS_DEBUG) console.error(`[task] receipt unreadable, skipped: ${rel}: ${err && err.message}`);
}

function receiptTextForProof(proof, root = process.cwd()) {
  const chunks = [];
  const pattern = new RegExp(RECEIPT_PATH_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(String(proof || ''))) && chunks.length < 3) {
    const rel = match[1];
    if (!rel || rel.includes('*')) continue;
    try {
      const raw = fs.readFileSync(path.resolve(root, rel), 'utf8');
      const parsed = JSON.parse(raw);
      chunks.push(JSON.stringify({
        schema: parsed.schema || null,
        mission_id: parsed.mission_id || null,
        result: parsed.result || null,
        landing: parsed.landing || null,
        last_landing: parsed.last_landing || null,
        summary: parsed.summary || null,
      }).slice(0, 12000));
    } catch (err) {
      debugUnreadableReceipt(rel, err);
    }
  }
  return chunks.join(' ');
}

function missionReceiptResultForProof(task, proof, root = process.cwd()) {
  const metadata = task?.metadata || {};
  if (!metadata.mission_id && !metadata.goal_id) return null;
  const pattern = new RegExp(RECEIPT_PATH_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(String(proof || '')))) {
    const rel = match[1];
    if (!rel || rel.includes('*')) continue;
    let landing = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(root, rel), 'utf8'));
      landing = parsed?.result?.landing || parsed?.landing || parsed?.last_landing || null;
    } catch (err) {
      debugUnreadableReceipt(rel, err);
      continue;
    }
    const changed = String(landing?.changed || landing?.happened || '').replace(/\s+/g, ' ').trim();
    if (!changed) continue;
    if (/\brecorded tick \d+\.?$/i.test(changed) || /^recorded a proof heartbeat\b/i.test(changed)) continue;
    const reason = String(landing?.reason || landing?.why || '').replace(/\s+/g, ' ').trim();
    return { changed, reason: reason && !isRetiredFillerReason(reason) ? reason : null };
  }
  return null;
}

function missionXpEndToEndProofIssue(task, proof, root = process.cwd()) {
  if (!goldenPathMissionXpTask(task)) return null;
  const corpus = `${String(proof || '')} ${receiptTextForProof(proof, root)}`
    .replace(/\s+/g, ' ')
    .trim();
  const hasZeroPapercut = /\b(?:zero|0|no)\s+(?:new\s+)?papercuts?\b|\bzero[- ]papercut\b/i.test(corpus);
  const hasEndToEnd = /\bend[- ]to[- ]end\b|\bfull\s+(?:fresh[- ](?:laptop|environment)\s+)?pass\b|\bfresh[- ](?:laptop|environment|install)\b|\bclean\s+temp\s+home\b|\bnpm\s+pack\b/i.test(corpus);
  const hasSelfLanded = /\bself[- ]landed\b|\bfirst\s+self[- ]landed\s+task\b|\btask\s+reaches\s+done\b|\binstall\b.{0,120}\binit\b.{0,120}\bmission\b.{0,120}\b(?:self[- ]landed|task)\b/i.test(corpus);
  return hasZeroPapercut && hasEndToEnd && hasSelfLanded ? null : MISSION_XP_END_TO_END_DETAIL;
}

function missionXpProofBoundaryEvaluation(task, proofOverride = null) {
  if (!goldenPathMissionXpTask(task)) return null;
  const metadata = task.metadata || {};
  const review = task.review || {};
  const proof = proofOverride === null
    ? String(review.proof || metadata.latest_agent_proof || '').trim()
    : String(proofOverride || '').trim();
  const issue = missionXpEndToEndProofIssue(task, proof, task.workspace_root || process.cwd());
  if (!issue) return null;
  return {
    eligible: false,
    ref: taskRef(task),
    reason: MISSION_XP_END_TO_END_REASON,
    next_action: 'attach the zero-papercut end-to-end fresh-laptop receipt, then resubmit Mission XP proof',
    proof,
  };
}

function positional(args) {
  return args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1].startsWith('--')) return false;
    return true;
  });
}

function taskFromProjection(projection, id) {
  return projection.tasks.find(t => t.id === id) || null;
}

function taskRef(taskOrId) {
  if (!taskOrId) return 'TASK';
  if (typeof taskOrId === 'string') return taskOrId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
  return taskOrId.display_id || taskOrId.legacy_ref || taskRef(taskOrId.id);
}

function normalizeTaskLookupRef(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function taskLookupRefs(task) {
  if (!task) return [];
  return [task.id, task.display_id, task.legacy_ref, taskRef(task)]
    .map(normalizeTaskLookupRef)
    .filter(Boolean);
}

function resolveProjectionTaskRef(ref, taskByRef) {
  const key = normalizeTaskLookupRef(ref);
  return key ? taskByRef.get(key) || null : null;
}

function normalizedStatusPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function taskIsPlannedOpen(task) {
  const metadata = task && task.metadata || {};
  const tag = normalizedStatusPart(task && task.tag);
  const stage = normalizedStatusPart(metadata.stage);
  return STATUS_PLAN_TAGS.has(tag)
    || STATUS_PLAN_TAGS.has(stage)
    || Boolean(metadata.verify || metadata.goal || metadata.loop || metadata.cron || metadata.next_run_at);
}

function taskColumn(task) {
  if (task.status === 'open') return taskIsPlannedOpen(task) ? 'open' : 'backlog';
  if (task.status === 'claimed') return 'doing';
  if (task.status === 'review') return 'review';
  if (task.status === 'failed' && taskHasReview(task)) return 'done';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'done' && !taskHasReview(task)) return 'review';
  return 'done';
}

function taskHasReview(task) {
  if (task.latest_event_type === 'reviewed') return true;
  const review = task.review || {};
  return review.reward != null || Boolean(review.proof || review.lesson || review.next_task);
}

const TASK_BOARD_COLUMNS = [
  ['backlog', 'Backlog'],
  ['open', 'Open'],
  ['doing', 'Doing'],
  ['review', 'Review'],
  ['blocked', 'Blocked'],
  ['done', 'Done'],
];

function taskBoardViewModel(projection = {}) {
  const tasks = Array.isArray(projection.tasks) ? projection.tasks : [];
  const rows = tasks.map((task) => ({
    id: task.id,
    task,
    column: taskColumn(task),
    decision: taskHasReview(task),
  }));
  const columns = TASK_BOARD_COLUMNS.map(([key, label]) => ({
    key,
    label,
    rows: rows.filter((row) => row.column === key),
  }));
  const counts = {};
  for (const column of columns) counts[column.key] = column.rows.length;
  return {
    columns,
    counts,
    rows,
    total: rows.length,
    planTags: Array.from(STATUS_PLAN_TAGS),
  };
}

function taskBoardTemplate(model) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atris Task Factory</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    /* aesthetic: machine-room telemetry, warm-tinted dark, mono data, calm signals (no neon) */
    :root {
      color-scheme: dark;
      --bg: oklch(18% 0.012 160);
      --panel: oklch(22% 0.014 160);
      --panel-2: oklch(25% 0.016 160);
      --line: oklch(32% 0.015 160);
      --text: oklch(93% 0.012 150);
      --muted: oklch(70% 0.018 160);
      --accent: oklch(74% 0.115 158);
      --warn: oklch(81% 0.11 80);
      --bad: oklch(69% 0.14 25);
      --info: oklch(75% 0.10 240);
      --violet: oklch(73% 0.10 300);
      --sans: 'Space Grotesk', ui-sans-serif, system-ui, -apple-system, sans-serif;
      --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin:0; color:var(--text);
      font-family: var(--sans);
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      background:
        radial-gradient(1100px 520px at 82% -12%, oklch(30% 0.04 160 / 0.55), transparent 62%),
        repeating-linear-gradient(0deg, oklch(32% 0.015 160 / 0.16) 0 1px, transparent 1px 34px),
        var(--bg);
      background-attachment: fixed;
    }
    header { height:60px; display:flex; align-items:center; justify-content:space-between; padding:0 22px; border-bottom:1px solid var(--line); background:linear-gradient(180deg, var(--panel-2), var(--panel)); }
    h1 { font-size:17px; margin:0; font-weight:700; letter-spacing:-0.01em; }
    .sub { color:var(--muted); font-size:12px; }
    main { display:grid; grid-template-columns: 320px 1fr; height:calc(100vh - 60px); }
    aside { border-right:1px solid var(--line); padding:16px; overflow:auto; background:var(--panel); }
    section { min-width:0; overflow:auto; padding:16px; }
    label { display:block; color:var(--muted); font-size:12px; margin:10px 0 5px; }
    input, textarea, select { width:100%; border:1px solid var(--line); background:oklch(15% 0.012 160); color:var(--text); border-radius:8px; padding:9px 11px; font:inherit; font-size:13px; transition:border-color .18s cubic-bezier(0.25,1,0.5,1); }
    input:focus, textarea:focus, select:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
    textarea { min-height:82px; resize:vertical; font-family:var(--mono); font-size:12px; }
    button { border:1px solid var(--line); background:var(--panel-2); color:var(--text); border-radius:8px; padding:8px 12px; font:inherit; font-size:12px; cursor:pointer; transition:background .18s cubic-bezier(0.25,1,0.5,1), border-color .18s; }
    button:hover { border-color:var(--muted); background:oklch(29% 0.018 160); }
    button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    button:active { transform:translateY(1px); }
    .primary { background:oklch(38% 0.07 158); border-color:oklch(48% 0.09 158); color:oklch(96% 0.02 158); }
    .primary:hover { background:oklch(43% 0.085 158); border-color:var(--accent); }
    .grid { display:grid; grid-template-columns: repeat(var(--board-columns, 6), minmax(160px, 1fr)); gap:12px; align-items:start; }
    .overview { display:grid; grid-template-columns: minmax(260px, 1.4fr) minmax(260px, 1fr); gap:12px; margin-bottom:12px; }
    .goalbox, .chainbox { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:11px; min-height:88px; }
    .goalbox h2, .chainbox h2 { margin:0 0 8px; color:var(--muted); font-size:12px; font-weight:650; }
    .goalitem { font-size:13px; line-height:1.3; margin:5px 0; }
    .chainitem { display:grid; grid-template-columns:72px 1fr; gap:8px; font-size:12px; line-height:1.3; margin:5px 0; color:var(--muted); }
    .chainitem strong { color:var(--text); font-weight:600; }
    .streams { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:12px; margin-bottom:12px; }
    .stream { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:11px; min-height:126px; }
    .stream h2 { margin:0 0 8px; font-size:12px; color:var(--text); line-height:1.25; font-weight:500; }
    .streambar { display:flex; height:7px; overflow:hidden; border-radius:999px; background:oklch(15% 0.012 160); border:1px solid var(--line); margin:8px 0; }
    .streambar span { display:block; min-width:2px; }
    .seg-open { background:var(--muted); }
    .seg-doing { background:var(--accent); }
    .seg-review { background:var(--warn); }
    .seg-blocked { background:var(--bad); }
    .streamtask { display:grid; grid-template-columns:64px 1fr; gap:8px; color:var(--muted); font-size:11px; line-height:1.25; margin-top:6px; }
    .streamtask strong { color:var(--text); font-weight:550; }
    .col { background:var(--panel); border:1px solid var(--line); border-radius:8px; min-height:160px; overflow:hidden; }
    .col h2 { margin:0; padding:10px 11px; font-size:12px; color:var(--muted); border-bottom:1px solid var(--line); display:flex; justify-content:space-between; }
    .cards { padding:8px; display:flex; flex-direction:column; gap:8px; }
    .card { text-align:left; width:100%; background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:9px; transition:transform .18s cubic-bezier(0.25,1,0.5,1), border-color .18s, background .18s; }
    .card:hover { transform:scale(1.02); border-color:var(--muted); background:oklch(28% 0.018 160); }
    .card.active { border-color:var(--accent); box-shadow:0 0 0 1px oklch(74% 0.115 158 / 0.3); }
    .title { font-size:13px; line-height:1.25; }
    .meta { margin-top:6px; color:var(--muted); font-size:11px; display:flex; gap:6px; flex-wrap:wrap; font-family:var(--mono); }
    .pill { border:1px solid var(--line); border-radius:999px; padding:1px 6px; }
    .why { margin-top:7px; color:var(--muted); font-size:11px; line-height:1.25; }
    .plain { margin-top:6px; font-size:11px; line-height:1.35; color:var(--text); }
    .plain div + div { color:var(--muted); }
    .fact { margin:10px 0; background:oklch(15% 0.012 160); border:1px solid var(--line); border-radius:7px; padding:8px; font-size:12px; line-height:1.35; }
    .fact b { color:var(--muted); font-size:11px; display:block; margin-bottom:3px; }
    .room { margin-top:14px; border-top:1px solid var(--line); padding-top:12px; }
    .room h3 { margin:0 0 4px; font-size:14px; }
    .thread { margin:10px 0; display:flex; flex-direction:column; gap:7px; }
    .msg { background:oklch(15% 0.012 160); border:1px solid var(--line); border-radius:7px; padding:8px; font-size:12px; }
    .msg .who { color:var(--muted); font-size:11px; margin-bottom:3px; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
    .full { grid-column:1 / -1; }
    .empty { color:var(--muted); font-size:12px; padding:10px; }
    /* heartbeat strip */
    .beat { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); font-family:var(--mono); }
    .beat .dot { width:9px; height:9px; border-radius:50%; background:var(--muted); flex:none; }
    .beat.alive .dot { background:var(--accent); box-shadow:0 0 0 0 oklch(74% 0.115 158 / 0.6); animation:beat 2s cubic-bezier(0.25,1,0.5,1) infinite; }
    .beat.stale .dot { background:var(--bad); }
    .beat b { color:var(--accent); font-weight:600; }
    .beat .warn { color:var(--warn); }
    @keyframes beat { 0%{box-shadow:0 0 0 0 oklch(74% 0.115 158 / 0.5)} 70%{box-shadow:0 0 0 8px oklch(74% 0.115 158 / 0)} 100%{box-shadow:0 0 0 0 oklch(74% 0.115 158 / 0)} }
    @media (prefers-reduced-motion: reduce) { .beat.alive .dot { animation:none; } *, *::before, *::after { transition:none !important; } }
    /* activity feed */
    .activity { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:0; margin-bottom:12px; max-height:46vh; overflow:auto; }
    .activity h2 { margin:0; position:sticky; top:0; background:var(--panel); padding:11px; font-size:12px; color:var(--muted); font-weight:650; border-bottom:1px solid var(--line); z-index:1; }
    .ev { display:grid; grid-template-columns:52px 64px 1fr auto; gap:10px; align-items:baseline; padding:7px 11px; border-bottom:1px solid oklch(28% 0.013 160); font-size:12px; line-height:1.3; font-family:var(--mono); transition:background .15s ease; }
    .ev:last-child { border-bottom:0; }
    .ev:hover { background:oklch(25% 0.016 160); }
    .ev .t { color:var(--muted); font-variant-numeric:tabular-nums; font-size:11px; }
    .ev .src { font-size:11px; border:1px solid var(--line); border-radius:999px; padding:1px 7px; color:var(--muted); text-align:center; }
    .ev .src.pulse { color:var(--accent); border-color:oklch(74% 0.115 158 / 0.45); }
    .ev .src.reward { color:var(--warn); border-color:oklch(81% 0.11 80 / 0.45); }
    .ev .src.xp { color:var(--info); border-color:oklch(75% 0.10 240 / 0.45); }
    .ev .src.mission { color:var(--violet); border-color:oklch(73% 0.10 300 / 0.45); }
    .ev .msg { color:var(--text); min-width:0; }
    .ev .msg .d { color:var(--muted); font-size:11px; }
    .ev.bad .msg { color:var(--bad); }
    .ev .rw { font-variant-numeric:tabular-nums; font-size:11px; color:var(--muted); }
    .ev .rw.pos { color:var(--accent); } .ev .rw.neg { color:var(--bad); }
    @media (max-width: 980px) { main { grid-template-columns:1fr; height:auto; } aside { border-right:0; border-bottom:1px solid var(--line); } .grid, .overview { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Atris Task Factory</h1>
      <div class="beat" id="heartbeat"><span class="dot"></span><span>heartbeat: loading…</span></div>
    </div>
    <button id="refresh">Refresh</button>
  </header>
  <main>
    <aside>
      <form id="create">
        <label>New task</label>
        <textarea id="title" placeholder="Need something done..."></textarea>
        <label>Lane</label>
        <input id="tag" value="tasks">
        <button class="primary full" type="submit" style="margin-top:10px;width:100%">Create task</button>
      </form>
      <div class="room" id="room">
        <div class="empty">Select a task to open its room.</div>
      </div>
    </aside>
    <section>
      <div class="overview" id="overview"></div>
      <div class="activity" id="activity"><h2>Live Stream</h2><div class="empty">waiting for the agent…</div></div>
      <div class="streams" id="streams"></div>
      <div class="grid" id="board"></div>
    </section>
  </main>
  <script>
    const columns = [
      ['backlog', 'Backlog'],
      ['open', 'Open'],
      ['doing', 'Doing'],
      ['review', 'Review'],
      ['blocked', 'Blocked'],
      ['done', 'Done']
    ];
    const planTags = new Set(${JSON.stringify(model.planTags)});
    let state = { tasks: [] };
    let selected = null;
    const $ = (id) => document.getElementById(id);

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', 'x-atris-token': new URLSearchParams(location.search).get('t') || '', ...(options.headers || {}) }
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.detail || data.reason || 'request failed');
      return data;
    }

    function taskColumn(task) {
      if (task.status === 'open') {
        const metadata = task.metadata || {};
        const tag = String(task.tag || '').trim().toLowerCase().replace(/\\s+/g, '-');
        const stage = String(metadata.stage || '').trim().toLowerCase().replace(/\\s+/g, '-');
        const planned = planTags.has(tag) || planTags.has(stage) || metadata.verify || metadata.goal || metadata.loop || metadata.cron || metadata.next_run_at;
        return planned ? 'open' : 'backlog';
      }
      if (task.status === 'claimed') return 'doing';
      if (task.status === 'review') return 'review';
      const reviewed = task.latest_event_type === 'reviewed' || !!(task.review && (task.review.reward != null || task.review.proof || task.review.lesson || task.review.next_task));
      if (task.status === 'failed' && reviewed) return 'done';
      if (task.status === 'failed') return 'blocked';
      if (task.status === 'done' && !reviewed) return 'review';
      return 'done';
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function fmtTime(ms) {
      try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
      catch (e) { return ''; }
    }

    function renderHeartbeat(hb) {
      const el = $('heartbeat');
      el.className = 'beat ' + (hb.state || 'idle');
      if (hb.state === 'stale') {
        el.innerHTML = '<span class="dot"></span><span class="warn">stale</span><span>· ' + esc(hb.stale_reason || '') + ' · ' + (hb.total_ticks || 0) + ' ticks</span>';
        return;
      }
      if (!hb.total_ticks) {
        el.innerHTML = '<span class="dot"></span><span>idle · no ticks yet · run: atris pulse tick</span>';
        return;
      }
      const age = hb.last_tick_age_min == null ? '' : (hb.last_tick_age_min === 0 ? 'just now' : hb.last_tick_age_min + 'm ago');
      el.innerHTML = '<span class="dot"></span><b>alive</b>'
        + '<span>· last tick ' + age + '</span>'
        + (hb.last_what ? '<span>· ' + esc(hb.last_what) + '</span>' : '')
        + '<span>· ' + hb.total_ticks + ' ticks, reward ' + (hb.reward_sum || 0) + '</span>';
    }

    function renderActivity(events) {
      const el = $('activity');
      if (!events.length) { el.innerHTML = '<h2>Live Stream</h2><div class="empty">no activity yet, fire a tick: atris pulse tick</div>'; return; }
      let html = '<h2>Live Stream · ' + events.length + ' events</h2>';
      for (const e of events) {
        const rwCls = e.reward == null ? '' : (e.reward > 0 ? 'pos' : (e.reward < 0 ? 'neg' : ''));
        const rw = e.reward == null ? '' : (e.reward > 0 ? '+' + e.reward : '' + e.reward);
        html += '<div class="ev ' + (e.status === 'bad' ? 'bad' : '') + '">'
          + '<span class="t">' + (e.ms ? fmtTime(e.ms) : '') + '</span>'
          + '<span class="src ' + esc(e.source) + '">' + esc(e.source) + '</span>'
          + '<span class="msg">' + esc(e.title) + (e.detail ? ' <span class="d">' + esc(e.detail) + '</span>' : '') + '</span>'
          + '<span class="rw ' + rwCls + '">' + rw + '</span>'
          + '</div>';
      }
      el.innerHTML = html;
    }

    async function loadStream() {
      const data = await api('/api/stream');
      renderHeartbeat(data.heartbeat || {});
      renderActivity(data.events || []);
    }

    async function load() {
      const data = await api('/api/tasks');
      state = data.projection;
      render();
      loadStream().catch(() => {});
    }

    function render() {
      renderOverview();
      renderStreams();
      const board = $('board');
      board.style.setProperty('--board-columns', columns.length);
      board.innerHTML = '';
      for (const [key, label] of columns) {
        const tasks = state.tasks.filter((task) => taskColumn(task) === key);
        const col = document.createElement('div');
        col.className = 'col';
        col.innerHTML = '<h2><span>' + label + '</span><span>' + tasks.length + '</span></h2><div class="cards"></div>';
        const cards = col.querySelector('.cards');
        if (!tasks.length) cards.innerHTML = '<div class="empty">No tasks</div>';
        for (const task of tasks) cards.appendChild(card(task));
        board.appendChild(col);
      }
      renderRoom();
    }

    function taskById(id) {
      return state.tasks.find((task) => task.id === id) || null;
    }

    function renderOverview() {
      const active = state.tasks.filter((task) => task.status !== 'done');
      const reviewed = state.tasks.filter((task) => task.latest_event_type === 'reviewed');
      const goals = state.goals && state.goals.items || [];
      const goalHtml = goals.length
        ? goals.slice(0, 4).map((goal) => '<div class="goalitem"></div>').join('')
        : '<div class="empty">No atris/goals.md found. Add goals to give tasks a north star.</div>';
      const latest = reviewed.slice(0, 3);
      const chainHtml = latest.length
        ? latest.map((task) => '<div class="chainitem"><span>' + (task.display_id || task.id.slice(0, 8)) + '</span><strong></strong></div>').join('')
        : '<div class="empty">Complete a task with proof to start the chain.</div>';
      $('overview').innerHTML = [
        '<div class="goalbox"><h2>Goals</h2>' + goalHtml + '</div>',
        '<div class="chainbox"><h2>Compounding Chain</h2><div class="chainitem"><span>active</span><strong>' + active.length + ' open loops</strong></div>' + chainHtml + '</div>'
      ].join('');
      $('overview').querySelectorAll('.goalitem').forEach((el, i) => { el.textContent = goals[i]; });
      $('overview').querySelectorAll('.chainbox .chainitem strong').forEach((el, i) => {
        if (i === 0) return;
        const task = latest[i - 1];
        const what = task.explanation && task.explanation.what_changes || task.title;
        el.textContent = (task.review && task.review.next_task) ? what + ' -> ' + task.review.next_task : what;
      });
    }

    function renderStreams() {
      const streams = (state.streams || []).filter((stream) => stream.active_count || stream.done_count).slice(0, 6);
      const root = $('streams');
      if (!streams.length) {
        root.innerHTML = '';
        return;
      }
      root.innerHTML = streams.map((stream) => {
        const total = Math.max(1, stream.open_count + stream.doing_count + stream.review_count + stream.blocked_count);
        const widths = {
          open: Math.max(0, Math.round(stream.open_count / total * 100)),
          doing: Math.max(0, Math.round(stream.doing_count / total * 100)),
          review: Math.max(0, Math.round(stream.review_count / total * 100)),
          blocked: Math.max(0, Math.round(stream.blocked_count / total * 100))
        };
        const tasks = stream.tasks.filter((task) => task.status !== 'done').slice(0, 3);
        const taskHtml = tasks.length
          ? tasks.map((task) => '<div class="streamtask"><span>' + (task.display_id || task.id.slice(0, 8)) + '</span><strong></strong></div>').join('')
          : '<div class="empty">No active tasks in this stream.</div>';
        return [
          '<div class="stream">',
          '<h2></h2>',
          '<div class="meta"><span class="pill">' + stream.active_count + ' active</span><span class="pill">' + stream.done_count + ' done</span></div>',
          '<div class="streambar"><span class="seg-open" style="width:' + widths.open + '%"></span><span class="seg-doing" style="width:' + widths.doing + '%"></span><span class="seg-review" style="width:' + widths.review + '%"></span><span class="seg-blocked" style="width:' + widths.blocked + '%"></span></div>',
          taskHtml,
          '</div>'
        ].join('');
      }).join('');
      root.querySelectorAll('.stream h2').forEach((el, i) => { el.textContent = streams[i].objective; });
      root.querySelectorAll('.stream').forEach((streamEl, i) => {
        const tasks = streams[i].tasks.filter((task) => task.status !== 'done').slice(0, 3);
        streamEl.querySelectorAll('.streamtask strong').forEach((el, idx) => {
          el.textContent = tasks[idx].explanation && tasks[idx].explanation.what_changes || tasks[idx].title;
        });
      });
    }

    function card(task) {
      const btn = document.createElement('button');
      btn.className = 'card' + (selected === task.id ? ' active' : '');
      btn.onclick = () => { selected = task.id; render(); };
      const owner = task.claimed_by ? '@' + task.claimed_by : 'unowned';
      btn.innerHTML = '<div class="title"></div><div class="plain"></div>'
        + '<div class="meta"><span class="pill"></span><span class="pill"></span><span class="pill"></span></div><div class="why"></div>';
      const plain = task.explanation || {};
      btn.querySelector('.title').textContent = plain.what_changes || task.title;
      const plainRows = [];
      plainRows.push('Why it matters: ' + (plain.why_it_matters || 'No reason recorded yet.'));
      plainRows.push('Done looks like: ' + (plain.done_looks_like || 'Proof of the work, then review.'));
      const plainBox = btn.querySelector('.plain');
      for (const row of plainRows) {
        const line = document.createElement('div');
        line.textContent = row;
        plainBox.appendChild(line);
      }
      const pills = btn.querySelectorAll('.pill');
      pills[0].textContent = task.display_id || task.id.slice(0, 8);
      pills[1].textContent = owner;
      pills[2].textContent = 'v' + task.current_version;
      btn.querySelector('.why').textContent = 'Technical details: ' + task.title;
      return btn;
    }

    function renderRoom() {
      const task = state.tasks.find((t) => t.id === selected);
      const room = $('room');
      if (!task) {
        room.innerHTML = '<div class="empty">Select a task to open its room.</div>';
        return;
      }
      const messages = task.messages.map((m) => '<div class="msg"><div class="who">' + (m.actor || 'unknown') + ' / v' + m.version + '</div><div></div></div>').join('');
      const parent = task.lineage && task.lineage.parent_title ? task.lineage.parent_title : 'none';
      const children = task.lineage && task.lineage.child_titles && task.lineage.child_titles.length ? task.lineage.child_titles.join(' | ') : (task.review && task.review.next_task || 'none yet');
      room.innerHTML = [
        '<h3></h3>',
        '<div class="meta"><span class="pill">' + task.status + '</span><span class="pill">' + (task.claimed_by || 'unowned') + '</span><span class="pill">v' + task.current_version + '</span></div>',
        '<div class="fact"><b>What changes</b><div id="taskWhatChanges"></div></div>',
        '<div class="fact"><b>Why it matters</b><div id="taskWhyItMatters"></div></div>',
        '<div class="fact"><b>Done looks like</b><div id="taskDoneLooksLike"></div></div>',
        '<div class="fact"><b>Approval</b><div id="taskApproval"></div></div>',
        '<div class="fact"><b>Technical details</b><div id="taskTechnicalDetails"></div></div>',
        '<div class="fact"><b>Goal</b><div id="taskGoal"></div></div>',
        '<div class="fact"><b>Lineage</b><div id="taskLineage"></div></div>',
        '<div class="fact"><b>Result</b><div id="taskHappened"></div></div>',
        '<div class="fact"><b>How I checked</b><div id="taskChecked"></div></div>',
        '<div class="fact"><b>What I tested</b><div id="taskTested"></div></div>',
        '<div class="fact"><b>Decision</b><div id="taskDecision"></div></div>',
        '<div class="fact"><b>Proof / lesson</b><div id="taskProof"></div></div>',
        '<div class="thread">' + (messages || '<div class="empty">No thread yet.</div>') + '</div>',
        '<label>Add context</label><textarea id="note" placeholder="Decision, blocker, context, update..."></textarea>',
        '<label>Proof</label><input id="proof" placeholder="npm test, PR link, screenshot, blocked reason...">',
        '<label>Lesson</label><textarea id="lesson" placeholder="What did this task teach us?"></textarea>',
        '<label>Next task</label><input id="nextTask" placeholder="Optional next sharper task">',
        '<div class="actions"><button id="claim">Claim</button><button id="saveNote">Say</button><button id="requestChange">Ask for a change</button><button id="finish" class="primary full"></button></div>'
      ].join('');
      const plain = task.explanation || {};
      const approval = task.approval || {};
      room.querySelector('h3').textContent = plain.what_changes || task.title;
      $('taskWhatChanges').textContent = plain.what_changes || task.title;
      $('taskWhyItMatters').textContent = plain.why_it_matters || 'No reason recorded yet.';
      $('taskDoneLooksLike').textContent = plain.done_looks_like || 'Proof of the work, then review.';
      $('taskApproval').textContent = approval.approve && approval.approve.enabled
        ? approval.question
        : (approval.approve && approval.approve.blocked_reason) || 'Nothing to approve yet.';
      $('taskTechnicalDetails').textContent = task.title;
      $('taskGoal').textContent = task.objective || 'No matching goal yet.';
      $('taskLineage').textContent = 'parent: ' + parent + ' / next: ' + children;
      const result = task.review && task.review.result || {};
      const landing = task.review && task.review.landing || {
        happened: result.changed,
        checked: result.checked,
        tested: task.review && task.review.proof ? 'Proof is attached below.' : '',
        decision: result.accept,
      };
      $('taskHappened').textContent = landing.happened || (task.review && task.review.summary) || 'No review result yet.';
      $('taskChecked').textContent = landing.checked || 'No check yet.';
      $('taskTested').textContent = landing.tested || 'No test recorded yet.';
      $('taskDecision').textContent = landing.decision || 'No accept action yet.';
      $('taskProof').textContent = task.review && (task.review.proof || task.review.lesson)
        ? ((task.review.proof || 'no proof') + ' / ' + (task.review.lesson || 'no lesson'))
        : 'No proof yet.';
      room.querySelectorAll('.msg div:last-child').forEach((el, i) => { el.textContent = task.messages[i].content; });
      const canApprove = Boolean(approval.approve && approval.approve.enabled);
      const planned = task.metadata && task.metadata.stage === 'plan';
      $('finish').textContent = canApprove
        ? approval.approve.label
        : task.status === 'claimed' ? 'Move to Review' : 'Approval not ready';
      $('finish').disabled = !canApprove && task.status !== 'claimed';
      $('claim').onclick = () => mutate('/api/tasks/' + task.id + '/claim', { owner: 'operator' });
      $('requestChange').disabled = !(approval.request_change && approval.request_change.enabled);
      $('requestChange').textContent = approval.request_change && approval.request_change.label || 'Ask for a change';
      $('requestChange').onclick = () => {
        const note = $('note').value.trim();
        if (!note) { $('note').focus(); return; }
        const action = task.status === 'review' ? 'revise' : planned ? 'backlog' : 'message';
        const body = action === 'message' ? { actor: 'operator', content: note } : { actor: 'operator', note: note, reason: note };
        mutate('/api/tasks/' + task.id + '/' + action, body);
      };
      $('saveNote').onclick = () => mutate('/api/tasks/' + task.id + '/message', { actor: 'operator', content: $('note').value });
      $('finish').onclick = () => {
        const proof = $('proof').value.trim();
        const lesson = $('lesson').value.trim();
        const nextTask = $('nextTask').value.trim();
        const payload = { actor: 'operator' };
        if (proof) payload.proof = proof;
        if (lesson) payload.lesson = lesson;
        if (nextTask) payload.next = nextTask;
        if (task.status === 'review' && canApprove) {
          payload.createNext = Boolean(nextTask || (task.review && task.review.next_task));
          mutate('/api/tasks/' + task.id + '/accept', payload);
        } else if (planned && canApprove) {
          mutate('/api/tasks/' + task.id + '/do', { actor: task.metadata.assigned_to || task.claimed_by || 'operator', first_move: task.metadata.first_move });
        } else {
          mutate('/api/tasks/' + task.id + '/ready', payload);
        }
      };
    }

    async function mutate(path, body) {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
    }

    $('create').onsubmit = async (e) => {
      e.preventDefault();
      const title = $('title').value.trim();
      if (!title) return;
      const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, tag: $('tag').value || 'tasks' }) });
      selected = data.task_id;
      $('title').value = '';
      await load();
    };
    $('refresh').onclick = load;
    load();
    setInterval(load, 2500);
  </script>
</body>
</html>`;
}

function taskBoardHtml() {
  return taskBoardTemplate(taskBoardViewModel());
}

function readJsonBody(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return Promise.reject(Object.assign(new Error('json required'), { statusCode: 415 }));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      if (size > 1_000_000) return;
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > 1_000_000) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body.trim()) return resolve({});
      try {
        const value = JSON.parse(body);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
        resolve(value);
      } catch (e) { reject(Object.assign(e, { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendHtml(res, value) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  res.end(value);
}

module.exports = {
  DEFAULT_OWNER,
  AGENT_CERTIFICATION_REVIEW_PASSES,
  RESULT_SAVED_TEXT_LIMIT,
  REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
  REVIEW_LANE_LOOP_MAX_STEPS,
  REVIEW_LANE_RUN_DEFAULT_MAX_RUNS,
  REVIEW_LANE_RUN_MAX_RUNS,
  PENDING_REVIEW_CHAT_STOP_REASON,
  PROOF_BOUNDARY_BLOCKED_ACTION,
  PROOF_BOUNDARY_BLOCKED_REASON,
  MISSION_XP_END_TO_END_REASON,
  MISSION_XP_END_TO_END_DETAIL,
  READY_RESULT_TEACHING,
  STATUS_PLAN_TAGS,
  TASK_QUEUE_COLUMN_ORDER,
  TASK_QUEUE_COLUMN_LABELS,
  TASK_REVIEW_STATE_LANES,
  TASK_REVIEW_STATE_ALIASES,
  AGENT_ENV_MARKERS,
  WORKER_ENV_MARKERS,
  TASK_BOARD_COLUMNS,
  getTaskDb,
  warnIfTaskTitleNeedsOperatorWhy,
  taskUsageText,
  taskUsageLines,
  help,
  flag,
  taskScopeEverywhere,
  scopedWorkspaceRoot,
  hasEmptyFlagValue,
  wantsJson,
  parseAcceptReward,
  validHumanActorFlag,
  agentProofOnlyMode,
  workerEnvMarker,
  failAgentProofOnly,
  writeStdoutSync,
  printJson,
  refreshCareerXpProjection,
  refreshCareerXpAfterReview,
  compactCareerXpProjection,
  jsonModeActive,
  failTask,
  refuseCandidatePolicyGate,
  proofFlagValue,
  resultSentenceIssue,
  readyResultDetail,
  requireResultSentence,
  weakProofDetail,
  requireMeaningfulTaskProof,
  requireRanNamedProofCommand,
  sendProofIssue,
  textFlag,
  explanationFlags,
  landingFlags,
  readyMergeFlags,
  normalizedLandingSentence,
  defaultLandingSentenceForTitle,
  landingNeedsDayOnePm,
  warnIfLandingNeedsDayOnePm,
  requireExplicitLandingDayOnePm,
  numericFlag,
  meaningfulTaskProofIssue,
  goldenPathMissionXpTask,
  debugUnreadableReceipt,
  receiptTextForProof,
  missionReceiptResultForProof,
  missionXpEndToEndProofIssue,
  missionXpProofBoundaryEvaluation,
  positional,
  taskFromProjection,
  taskRef,
  normalizeTaskLookupRef,
  taskLookupRefs,
  resolveProjectionTaskRef,
  normalizedStatusPart,
  taskIsPlannedOpen,
  taskColumn,
  taskHasReview,
  taskBoardViewModel,
  taskBoardTemplate,
  taskBoardHtml,
  readJsonBody,
  sendJson,
  sendHtml,
};
