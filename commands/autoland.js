'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const autoland = require('../lib/autoland');
const { evaluateAutoAccept } = require('../lib/auto-accept-certified');
const { operatorReady, hasAgentJargon, explainResult } = autoland;
const MISSION_AUTO_VERIFY_STATUSES = new Set(['planning', 'paused', 'ready']);
const CLOSED_TASK_STATUSES = new Set(['done', 'archived']);
const MAX_MISSION_AUTO_VERIFY_PER_TICK = 3;

function repoRoot(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return cwd;
  return result.stdout.trim() || cwd;
}

function projectName(root) {
  return path.basename(root);
}

function missionReasonBreakdown(rows, fallback = 'stale') {
  const tally = {};
  for (const row of rows || []) {
    const reason = String(row?.reason || row?.pause_reason || fallback).trim() || fallback;
    tally[reason] = (tally[reason] || 0) + 1;
  }
  return tally;
}

function mergeReasonBreakdown(left = {}, right = {}) {
  const merged = { ...(left && typeof left === 'object' ? left : {}) };
  for (const [reason, count] of Object.entries(right || {})) {
    merged[reason] = (Number(merged[reason]) || 0) + (Number(count) || 0);
  }
  return merged;
}

function mergeHeldMissions(left = {}, held = []) {
  const merged = { ...(left && typeof left === 'object' ? left : {}) };
  for (const row of held || []) {
    if (!row || !row.id) continue;
    merged[row.id] = {
      id: row.id,
      owner: row.owner || null,
      objective: row.objective || '',
      reason: row.reason || 'operator-required',
      resume_command: row.resume_command || `atris mission run ${row.id}`,
    };
  }
  return merged;
}

function recordJanitorState(state, { stopped = [], held = [], worktrees = 0 } = {}) {
  const stoppedCount = Array.isArray(stopped) ? stopped.length : Number(stopped) || 0;
  const heldRows = Array.isArray(held) ? held : [];
  const worktreeCount = Number(worktrees) || 0;
  if (!stoppedCount && !heldRows.length && !worktreeCount) return;
  const prior = state.janitor && typeof state.janitor === 'object' ? state.janitor : {};
  const missionHolds = mergeHeldMissions(prior.mission_holds, heldRows);
  const missionStopReasons = mergeReasonBreakdown(prior.mission_stop_reasons, missionReasonBreakdown(stopped, 'stale'));
  state.janitor = {
    ...prior,
    missions_stopped: (Number(prior.missions_stopped) || 0) + stoppedCount,
    worktrees_reaped: (Number(prior.worktrees_reaped) || 0) + worktreeCount,
    ...(Object.keys(missionStopReasons).length ? { mission_stop_reasons: missionStopReasons } : {}),
    ...(Object.keys(missionHolds).length ? { mission_holds: missionHolds, missions_held: Object.keys(missionHolds).length } : {}),
  };
}

// The digest's "next, if you agree" section: top candidate moves from Atris
// state, each with the member best suited to own it. Moves that can't explain
// themselves are counted, not shown. Never blocks the digest.
function missionHasBudgetRemaining(mission, nowMs = Date.now()) {
  if (mission?.budget_contract?.policy !== 'spend_full_budget') return false;
  const seconds = Number(mission?.budget_contract?.requested_seconds || mission?.max_wall_seconds || 0);
  const startedMs = Date.parse(mission?.started_at || mission?.created_at || mission?.updated_at || '');
  return Number.isFinite(seconds) && seconds > 0
    && Number.isFinite(startedMs) && startedMs + seconds * 1000 > nowMs;
}

function digestNextMoves(root) {
  try {
    const { nextMoves } = require('../lib/next-moves');
    const { resolveFunctionalOwner } = require('../lib/functional-owner');
    const { listMissions } = require('./mission');
    const missions = new Map((listMissions(root) || []).map((mission) => [mission.id, mission]));
    const all = (nextMoves(root, 5) || [])
      .filter((move) => move && move.title)
      .filter((move) => move.kind !== 'mission_ready' || !missionHasBudgetRemaining(missions.get(move.ref)));
    const explainable = all.filter((move) => move.kind === 'mission_ready' || operatorReady(move.title));
    const ready = explainable.slice(0, 3).map((move) => {
      let owner = null;
      const mission = move.kind === 'mission_ready' ? missions.get(move.ref) : null;
      if (mission?.owner) owner = mission.owner;
      else {
        try { owner = resolveFunctionalOwner({ title: move.title, root })?.owner || null; } catch {}
      }
      return { title: move.title, owner, kind: move.kind || null, label: move.label || null };
    });
    return { moves: ready, unexplained: all.length - explainable.length };
  } catch {
    return { moves: [], unexplained: 0 };
  }
}

function flag(args, name, fallback = '') {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

function runOwnCli(root, cliArgs) {
  // Always spawn the bin this module shipped with. Resolving through the
  // target root or a global `atris` breaks whenever the tick runs a project
  // that isn't the CLI repo on a machine without a global install (CI, cron).
  const bin = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const result = spawnSync(process.execPath, [bin, ...cliArgs], { cwd: root, encoding: 'utf8', timeout: 300000 });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function readProjection(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), 'utf8');
    const projection = JSON.parse(raw);
    return Array.isArray(projection.tasks) ? projection.tasks : [];
  } catch (err) {
    return [];
  }
}

function readAcceptedTaskHistory(root, fallbackTasks = [], dbPath = undefined) {
  try {
    const taskDb = require('../lib/task-db');
    const db = taskDb.open(dbPath);
    const rows = taskDb.listTasks(db, { workspaceRoot: root });
    return taskDb.withTaskDisplayRefs(rows);
  } catch {
    return fallbackTasks;
  }
}

function compactId(value) {
  return String(value || '').trim();
}

function taskIdentityRefs(task) {
  return [
    task?.id,
    task?.display_id,
    task?.legacy_ref,
    task?.ref,
    task?.task_id,
    task?.metadata?.task_id,
    task?.metadata?.display_id,
    task?.metadata?.ref,
  ].map(compactId).filter(Boolean);
}

function taskGoalRefs(task) {
  return [
    task?.goal_id,
    task?.goalId,
    task?.mission_id,
    task?.missionId,
    task?.metadata?.goal_id,
    task?.metadata?.goalId,
    task?.metadata?.mission_id,
    task?.metadata?.missionId,
    task?.metadata?.goal?.id,
  ].map(compactId).filter(Boolean);
}

function missionTaskRefs(mission) {
  return [
    ...(Array.isArray(mission?.task_ids) ? mission.task_ids : []),
    mission?.task_id,
    mission?.current_task_id,
    mission?.task_ref,
    mission?.xp_task?.task_id,
    mission?.xp_task?.ref,
  ].map(compactId).filter(Boolean);
}

function attachedTasksForMission(mission, tasks) {
  const missionId = compactId(mission?.id);
  const taskRefs = new Set(missionTaskRefs(mission));
  return (tasks || []).filter((task) => {
    if (missionId && taskGoalRefs(task).includes(missionId)) return true;
    if (taskRefs.size === 0) return false;
    return taskIdentityRefs(task).some((ref) => taskRefs.has(ref));
  });
}

function taskIsClosed(task) {
  return CLOSED_TASK_STATUSES.has(String(task?.status || '').trim().toLowerCase());
}

function missionHasVerifier(mission) {
  return Boolean(String(mission?.verifier || mission?.effective_verifier || '').trim());
}

function missionReadyForClosedTaskVerify(mission, tasks) {
  const status = String(mission?.status || '').trim().toLowerCase();
  if (!MISSION_AUTO_VERIFY_STATUSES.has(status)) return false;
  if (!missionHasVerifier(mission)) return false;
  if (mission?.verifier_result?.passed === true) return false;
  const attached = attachedTasksForMission(mission, tasks);
  return attached.length > 0 && attached.every(taskIsClosed);
}

function parseMissionVerifyResult(id, result) {
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch {}
  const verifier = payload?.verifier_result || null;
  const passed = verifier ? verifier.passed === true : null;
  return {
    id,
    result: passed === true ? 'passed' : passed === false ? 'failed' : (payload?.action || (result.status === 0 ? 'tick_recorded' : 'tick_failed')),
    status: payload?.mission?.status || null,
    receipt_path: payload?.receipt_path || null,
    exit_status: result.status,
  };
}

function verifyClosedTaskMissions(root, tasks, { limit = MAX_MISSION_AUTO_VERIFY_PER_TICK } = {}) {
  const verified = [];
  const errors = [];
  let candidates = [];
  try {
    const { listMissions } = require('./mission');
    candidates = listMissions(root).filter((mission) => missionReadyForClosedTaskVerify(mission, tasks)).slice(0, limit);
  } catch (err) {
    return {
      verified,
      errors: [{ error: String((err && err.message) || err).slice(0, 200) }],
    };
  }

  for (const mission of candidates) {
    const result = runOwnCli(root, [
      'mission',
      'tick',
      mission.id,
      '--verify',
      '--summary',
      'All linked repair tasks are closed; autoland re-ran the mission verifier.',
      '--json',
    ]);
    const outcome = parseMissionVerifyResult(mission.id, result);
    verified.push(outcome);
    if (result.status !== 0 || outcome.result === 'failed' || outcome.result === 'tick_failed') {
      errors.push({
        id: mission.id,
        result: outcome.result,
        status: result.status,
        stderr: String(result.stderr || '').slice(0, 200),
        stdout: String(result.stdout || '').slice(-500),
      });
    }
  }
  return { verified, errors };
}

function landSummarySafe(root) {
  try {
    return require('./land').landSummary(root);
  } catch (err) {
    return null;
  }
}

function refreshLandingRefs(root) {
  const remotes = spawnSync('git', ['remote'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (remotes.status !== 0 || !remotes.stdout.split(/\r?\n/).includes('origin')) return;
  // One round-trip for both; a missing branch doesn't fail the other with a
  // multi-ref fetch on any git that supports it, and fetch errors are ignored
  // here anyway.
  const both = spawnSync('git', ['fetch', 'origin', 'master', 'main'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (both.status === 0) return;
  for (const branch of ['master', 'main']) {
    spawnSync('git', ['fetch', 'origin', branch], { cwd: root, encoding: 'utf8', timeout: 30000 });
  }
}

function sweepLanding(root, { ttlDays, staleHours, now = Date.now() } = {}) {
  refreshLandingRefs(root);
  const { collectBoard, reap } = require('./land');
  // light: this board only feeds .branches staleness + .summary; reap builds
  // its own full board for dirty-count salvage decisions.
  const beforeBoard = collectBoard(root, { ttlDays, staleHours, now, light: true });
  const stale = beforeBoard.branches
    .filter((b) => b.state === 'active' && b.stale)
    .sort((a, b) => b.activityHours - a.activityHours)
    .map((b) => ({
      name: b.name,
      ahead: b.ahead,
      ageHours: b.ageHours,
      activityHours: b.activityHours,
    }));
  const reaped = reap(root, {
    ttlDays,
    staleHours,
    remote: false,
    includeDetached: false,
    now,
  });
  const afterBoard = collectBoard(root, { ttlDays, staleHours, now, light: true });
  const human = [];
  for (const kept of reaped.keptWorktrees || []) {
    if (String(kept).includes('(fresh_worktree_grace)')) continue;
    if (String(kept).includes('(current_checkout)')) continue;
    human.push(String(kept));
  }
  for (const moved of reaped.keptMovedBranches || []) human.push(`${moved} moved during cleanup`);
  if (reaped.bundleError) human.push(`backup failed: ${reaped.bundleError}`);
  return {
    at: new Date(now).toISOString(),
    before: beforeBoard.summary,
    after: afterBoard.summary,
    stale,
    human,
    reaped: {
      branches: reaped.deletedBranches.length,
      worktrees: reaped.removedWorktrees.length,
      bundle: reaped.bundle,
      patches: reaped.patches.length,
      untracked: (reaped.untracked || []).length,
      bundleError: reaped.bundleError || null,
      keptWorktrees: reaped.keptWorktrees || [],
      keptMovedBranches: reaped.keptMovedBranches || [],
    },
  };
}

function recordLandingSweepState(state, sweep, { error = null } = {}) {
  const at = sweep?.at || new Date().toISOString();
  const today = at.slice(0, 10);
  state.last_reap_date = today;
  state.last_reap_at = at;
  if (error) {
    state.last_reap_error = { date: today, error };
    delete state.landing_sweep;
    return;
  }
  delete state.last_reap_error;
  state.landing_sweep = {
    at,
    before: sweep.before,
    after: sweep.after,
    reaped: sweep.reaped,
    stale_count: sweep.stale.length,
    stale: sweep.stale.slice(0, 10),
    human_count: sweep.human.length,
    human: sweep.human.slice(0, 10),
  };
}

function wishSweepSummaryLine(summary, error = null) {
  if (error) return `wishes: sweep failed (${error})`;
  const dispatched = Number(summary?.dispatched) || 0;
  const waiting = Number(summary?.waiting_on_operator) || 0;
  const noExecutor = Number(summary?.skipped_no_executor) || 0;
  const capped = Number(summary?.capped) || 0;
  let line = `wishes: ${dispatched} dispatched, ${waiting} waiting on operator`;
  const notes = [];
  if (noExecutor > 0) notes.push(`${noExecutor} need a working builder`);
  if (capped > 0) notes.push(`${capped} held for the next tick`);
  if (notes.length) line += ` (${notes.join(', ')})`;
  return line;
}

function evaluateQueue(root, { strictVerify, acceptAll }) {
  return readProjection(root)
    .filter((task) => task && task.status === 'review')
    .filter((task) => String(task.review?.approval_status || task.metadata?.approval_status || 'pending') === 'pending')
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .slice(0, 50)
    .map((task) => {
      const evaluation = evaluateAutoAccept(
        { ...task, workspace_root: root },
        { strictVerify, acceptAll, executeVerify: false },
      );
      return {
        ...evaluation,
        action: evaluation.eligible ? 'would_accept' : 'skipped',
      };
    });
}

function plainReason(reason) {
  const map = {
    denied_tag_billing: 'money — yours to approve',
    denied_tag_deploy: 'a deploy — yours to approve',
    denied_tag_security: 'security — yours to approve',
    denied_tag_customer: 'customer-facing — yours to approve',
    denied_tag_external: 'outward-facing — yours to approve',
    denied_tag_feedback: 'customer feedback — yours to approve',
    denied_tag_voice: 'voice/comms — yours to approve',
    needs_second_reviewer_or_third_pass: 'needs one more independent check first',
    needs_independent_reviewer: 'built and judged by the same actor, needs an independent check',
    verifier_is_builder: 'the re-check actor built this row, another actor must re-check',
    judge_equals_worker: 'built and judged by the same actor, hand the review to someone else',
    not_agent_certified: 'not certified yet',
    insufficient_review_passes: 'not enough review passes yet',
    strict_verify_missing: 'no recorded check command to re-run',
    verify_failed: 'its check command failed on re-run',
    proof_unmerged_or_draft_pr_boundary: 'its proof points at an unmerged draft',
  };
  return map[reason] || reason.replace(/_/g, ' ');
}

function showStatus(root, args) {
  const json = args.includes('--json');
  const policy = autoland.readPolicy(root);
  const enabled = Boolean(policy && policy.enabled);
  const strictVerify = policy ? policy.strict_verify !== false : true;
  const acceptAll = Boolean(policy && policy.accept_all);
  const results = evaluateQueue(root, { strictVerify, acceptAll })
    .filter((r) => r.reason !== 'not_in_review');
  const readyForRecheck = results.filter((r) => r.action === 'would_accept');
  const wouldLand = readyForRecheck.filter((r) => r.verification_pending !== true);
  const blocked = results.filter((r) => r.action !== 'would_accept');
  const tasks = readProjection(root);
  const waiting = autoland.waitingOnHuman(tasks);
  const heartbeatInstalled = typeof policy?.heartbeat_installed === 'boolean'
    ? policy.heartbeat_installed
    : null;

  if (json) {
    console.log(JSON.stringify({
      enabled,
      policy,
      heartbeat_installed: heartbeatInstalled,
      would_land: wouldLand,
      ready_for_recheck: readyForRecheck,
      blocked,
      waiting_on_human: waiting,
    }, null, 2));
    return 0;
  }

  console.log('');
  console.log(`autoland — certified work lands itself; you keep the irreversible calls`);
  console.log('');
  const policyOwner = String(policy?.enabled_by || 'unknown').trim() || 'unknown';
  const policyText = enabled
    ? (policy.default
      ? `on by default for this workspace (no policy set; would accept as ${policyOwner}). set it: atris autoland on`
      : `on (flipped by ${policyOwner}${policy.enabled_at ? ` on ${String(policy.enabled_at).slice(0, 10)}` : ''})`)
    : 'off - everything waits for you';
  console.log(`  policy: ${policyText}`);
  if (enabled && acceptAll) console.log('  bar: everything lands except the protected lanes (money, deploys, security, customer, outward)');
  const heartbeatText = heartbeatInstalled === true
    ? 'running hourly'
    : heartbeatInstalled === false
      ? 'not installed'
      : 'unknown - run atris autoland on to check and repair';
  console.log(`  heartbeat: ${heartbeatText}`);
  if (policy && policy.imessage_to) console.log(`  daily message: ${policy.imessage_to} at ${policy.digest_hour ?? autoland.DEFAULT_DIGEST_HOUR}:00`);
  const reapTrouble = autoland.readState(root).last_reap_error;
  if (reapTrouble) console.log(`  cleanup trouble: landing sweep failed on ${reapTrouble.date} (${reapTrouble.error}) - run: atris land --reap`);
  console.log('');
  if (readyForRecheck.length > 0) {
    console.log(`  ready for heartbeat recheck: ${readyForRecheck.length}`);
    for (const r of readyForRecheck.slice(0, 10)) console.log(`    rechecks then lands  ${r.ref}`);
  } else {
    console.log('  nothing is ready to land on its own right now.');
  }
  const humanOnly = blocked.filter((r) => String(r.reason || '').startsWith('denied_tag_'));
  const needsWork = blocked.filter((r) => !String(r.reason || '').startsWith('denied_tag_'));
  if (humanOnly.length > 0) {
    console.log(`  yours to approve (protected lanes): ${humanOnly.length}`);
    for (const r of humanOnly.slice(0, 10)) console.log(`    waits for you  ${r.ref} — ${plainReason(r.reason)}`);
  }
  if (needsWork.length > 0) {
    console.log(`  not ready yet: ${needsWork.length}`);
    for (const r of needsWork.slice(0, 10)) console.log(`    held back      ${r.ref} — ${plainReason(String(r.reason || ''))}`);
  }
  if (waiting.length > 0) {
    console.log('');
    console.log(`  waiting on a human right now: ${waiting.length}, oldest ${waiting[0].hours}h`);
  }
  console.log('');
  if (!enabled) console.log("  flip it on: atris autoland on   (one decision; everything after is receipts)");
  console.log('');
  return 0;
}

function turnOn(root, args) {
  const owner = flag(args, '--as', os.userInfo().username);
  const to = flag(args, '--to', '');
  const digestHour = Number(flag(args, '--digest-hour', autoland.DEFAULT_DIGEST_HOUR));
  const alarmHours = Number(flag(args, '--alarm-hours', autoland.DEFAULT_ALARM_HOURS));
  const acceptAll = args.includes('--all');
  const previous = autoland.readPolicy(root);
  const policy = autoland.writePolicy(root, {
    enabled: true,
    enabled_by: owner,
    enabled_at: new Date().toISOString(),
    imessage_to: to || null,
    digest_hour: Number.isFinite(digestHour) ? digestHour : autoland.DEFAULT_DIGEST_HOUR,
    alarm_hours: Number.isFinite(alarmHours) && alarmHours > 0 ? alarmHours : autoland.DEFAULT_ALARM_HOURS,
    strict_verify: !args.includes('--no-strict-verify'),
    accept_all: acceptAll,
    daily_experiment: previous.daily_experiment !== false,
  });
  const cronOk = autoland.installCron(root);
  autoland.writePolicy(root, {
    ...policy,
    heartbeat_installed: cronOk,
    heartbeat_checked_at: new Date().toISOString(),
  });
  console.log('');
  console.log('autoland is on.');
  if (acceptAll) console.log(`  everything in review now lands itself, accepted as ${owner} — only the protected lanes wait.`);
  else console.log(`  certified, verified, reversible work now lands itself, accepted as ${owner}.`);
  console.log('  protected lanes (money, deploys, security, customer, outward) still wait for you.');
  console.log(`  heartbeat: ${cronOk ? 'installed, runs hourly' : 'could not install cron — run atris autoland tick yourself'}`);
  if (policy.imessage_to) {
    console.log(`  daily message to ${policy.imessage_to} at ${policy.digest_hour}:00; anything waiting on you past ${policy.alarm_hours}h pings you.`);
  } else {
    console.log('  no phone number set — digest goes to the log only. add one: atris autoland on --to <your number>');
  }
  console.log('  turn it off any time: atris autoland off');
  console.log('');
  return 0;
}

function turnOff(root) {
  const policy = autoland.readPolicy(root) || {};
  const disabledPolicy = autoland.writePolicy(root, {
    ...policy,
    enabled: false,
    disabled_at: new Date().toISOString(),
  });
  const cronOk = autoland.uninstallCron(root);
  autoland.writePolicy(root, {
    ...disabledPolicy,
    heartbeat_installed: cronOk ? false : null,
    heartbeat_checked_at: new Date().toISOString(),
  });
  console.log('');
  console.log('autoland is off. everything waits for your accept again.');
  console.log(`  heartbeat ${cronOk ? 'removed' : 'removal failed — check crontab -l'}.`);
  console.log('');
  return 0;
}

function runDigest(root, args, { forceSend = false } = {}) {
  const policy = autoland.readPolicy(root) || {};
  const tasks = readProjection(root);
  const accepted = autoland.acceptedInLastDay(readAcceptedTaskHistory(root, tasks));
  const state = autoland.readState(root);
  let waitingWishes = [];
  try {
    waitingWishes = require('./wish').waitingOperatorWishes(root);
  } catch {}
  const text = autoland.composeDigest({
    accepted,
    waiting: autoland.waitingOnHuman(tasks),
    waitingWishes,
    landed: landSummarySafe(root),
    project: projectName(root),
    nextMoves: digestNextMoves(root),
    acceptAll: Boolean(policy.accept_all),
    reapError: state.last_reap_error?.error || null,
    landingSweep: state.landing_sweep || null,
    fullStory: true,
  });
  console.log(text);
  // the full story: what each piece actually was, in its own words
  const byRef = new Map(tasks.map((t) => [t.display_id || t.legacy_ref || t.id, t]));
  const storied = accepted.auto.filter((item) => {
    const t = byRef.get(item.ref);
    return t && (t.review?.landing?.happened || t.metadata?.landing_happened);
  });
  if (storied.length > 0) {
    let printedStoryHeader = false;
    for (const item of storied) {
      const t = byRef.get(item.ref);
      const happened = autoland.historicalLandingText(t.review?.landing?.happened || t.metadata?.landing_happened || '', 160);
      if (!operatorReady(happened)) continue;
      if (!printedStoryHeader) {
        console.log('');
        printedStoryHeader = true;
      }
      console.log(`  ${item.ref}  ${happened}`);
    }
  }
  const shouldSend = (forceSend || args.includes('--send')) && policy.imessage_to;
  if (shouldSend) {
    const sent = autoland.sendImessage(root, policy.imessage_to, text);
    console.log(sent.ok ? `(sent to ${policy.imessage_to})` : `(send failed: ${sent.output})`);
    return sent.ok ? 0 : 1;
  }
  return 0;
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function runTick(root, args) {
  const json = args.includes('--json');
  const policy = autoland.readPolicy(root);
  const receipt = { at: new Date().toISOString(), landed: [], alarms: 0, digest_due: false, digest_sent: false, enabled: Boolean(policy && policy.enabled) };
  if (!policy || policy.enabled !== true) {
    if (json) console.log(JSON.stringify(receipt));
    else console.log('autoland is off; tick did nothing.');
    return 0;
  }

  // One live tick at a time: verify re-runs can take minutes each, and a
  // second hourly cron firing into the same snapshot double-accepts,
  // double-alarms, and double-digests. A stale lock (dead pid or >55min)
  // never wedges the loop.
  const lockPath = path.join(root, '.atris', 'state', 'autoland.tick.lock');
  try {
    const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const fresh = Date.now() - Number(prev.at || 0) < 55 * 60 * 1000;
    if (fresh && pidAlive(prev.pid)) {
      receipt.skipped_reason = 'tick_already_running';
      if (json) console.log(JSON.stringify(receipt));
      else console.log('autoland tick: another tick is still running; skipped.');
      return 0;
    }
  } catch {}
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {}
  try {
    return runTickBody(root, { json, policy, receipt });
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function persistTickReceipt(root, receipt) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const safeTime = String(receipt.at || new Date().toISOString()).replace(/[:.]/g, '-');
  const receiptPath = path.join(runsDir, `autoland-tick-${safeTime}.json`);
  receipt.receipt_path = path.relative(root, receiptPath);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt.receipt_path;
}

function digestTickStatus(receipt) {
  if (receipt.digest_sent) return 'sent';
  if (receipt.digest_due) return 'saved';
  return 'not due';
}

function runTickBody(root, { json, policy, receipt }) {

  // 1. certify and land in one task process. Keeping both phases together lets
  // the landing gate reuse the live certification verifier result without
  // persisting trust across heartbeats. Denied lanes and check-less proofs wait.
  // No hardcoded --limit here: a fixed low cap (this used to be 12) silently
  // undercounts a real backlog every single tick — 12/hour forever even with
  // 78 certified rows waiting. Let `atris task auto-accept-certified` apply
  // its own default (12 without --all, a high safety cap under --all) so a
  // policy with accept_all:true actually drains the full certified set.
  const cliArgs = ['task', 'auto-accept-certified', '--json', '--certify-first'];
  if (policy.accept_all) cliArgs.push('--all');
  else if (policy.strict_verify === false) cliArgs.push('--no-strict-verify');
  const accept = runOwnCli(root, cliArgs);
  try {
    const parsed = JSON.parse(accept.stdout);
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    // A refused sweep (ok:false — a guard tripped, policy race) carries no
    // summary fields. Name the reason instead of leaving nulls that read as
    // "no work": a blind heartbeat must say WHY it is blind.
    if (parsed.ok === false) {
      receipt.accept_error = String(parsed.reason || 'auto-accept refused');
    }
    receipt.reviews_certified = parsed.certification?.certified ?? 0;
    if (parsed.certification && parsed.certification.ok !== true) {
      receipt.certify_error = 'certify-verified failed';
    }
    receipt.landed = results.filter((r) => r.action === 'accepted').map((r) => r.ref);
    const citationBlocks = results
      .filter((r) => r.action === 'skipped' && r.proof_state === 'suite_green_citation_required')
      .map((r) => ({ ref: r.ref, reason: r.reason }));
    if (citationBlocks.length) receipt.citation_blocks = citationBlocks;
    receipt.certified = parsed.certified ?? null;
    receipt.scanned = parsed.scanned ?? null;
    receipt.revised = parsed.revised ?? null;
    receipt.skipped = parsed.skipped ?? null;
    receipt.undercounted = Boolean(parsed.undercounted);
  } catch (err) {
    receipt.accept_error = accept.stderr.slice(0, 200) || 'auto-accept output unreadable';
  }

  // 2b. tell the operator the moment something lands: one text, one landing
  // sentence per piece (the day-one PM sentence written at finish time),
  // capped at three with the rest counted. Off with live_updates: false.
  const tasksForLive = readProjection(root);
  if (receipt.landed.length > 0 && policy.imessage_to && policy.live_updates !== false) {
    const text = autoland.composeLiveUpdate({
      landedRefs: receipt.landed,
      tasks: tasksForLive,
      project: projectName(root),
    });
    if (text) {
      // Keep the exact operator surface beside the delivery result. The next
      // linguist pass must audit what was sent, not reconstruct today's code.
      receipt.live_update_text = text;
      const sent = autoland.sendImessage(root, policy.imessage_to, text);
      receipt.live_update_sent = sent.ok;
    }
  }

  // 3. alarm on anything waiting on a human past the line
  const state = autoland.readState(root);
  const tasks = readProjection(root);
  const waiting = autoland.waitingOnHuman(tasks);
  const alarmHours = Number(policy.alarm_hours) || autoland.DEFAULT_ALARM_HOURS;
  const due = autoland.dueForAlarm(waiting, state, { alarmHours });
  if (due.length > 0 && policy.imessage_to) {
    const text = autoland.composeAlarm({ waiting: due, project: projectName(root), alarmHours });
    const sent = autoland.sendImessage(root, policy.imessage_to, text);
    if (sent.ok) {
      autoland.markAlerted(state, due);
      receipt.alarms = due.length;
    }
  }

  // 3b. janitor, every tick: a mission left paused past 48h and a worktree
  // already merged into base are the same rot pattern as an unlanded branch —
  // left alone they accumulate until a human runs `mission stop` and
  // `worktree cleanup --apply` by hand, which is exactly the chore autoland
  // exists to remove. Off switch: policy.janitor === false (default on, the
  // same absent-means-on convention as live_updates/strict_verify). Counts
  // accumulate in state so the daily digest reports the day's total, not
  // just the last tick's.
  receipt.missions_stopped = 0;
  receipt.missions_held = 0;
  receipt.worktrees_reaped = 0;
  if (policy.janitor !== false) {
    let stoppedMissions = [];
    let heldMissions = [];
    try {
      const { reapPausedMissions } = require('./mission');
      stoppedMissions = reapPausedMissions(root);
      heldMissions = Array.isArray(stoppedMissions.held) ? stoppedMissions.held : [];
      receipt.missions_stopped = stoppedMissions.length;
      if (stoppedMissions.length > 0) receipt.missions_stopped_refs = stoppedMissions.map((m) => m.id);
      if (stoppedMissions.length > 0) receipt.missions_stopped_reasons = missionReasonBreakdown(stoppedMissions, 'stale');
      receipt.missions_held = heldMissions.length;
      if (heldMissions.length > 0) {
        receipt.missions_held_refs = heldMissions.map((m) => m.id);
        receipt.missions_held_reasons = missionReasonBreakdown(heldMissions, 'operator-required');
      }
    } catch (err) {
      receipt.janitor_mission_error = String((err && err.message) || err).slice(0, 200);
    }
    try {
      const { cleanupWorktrees } = require('./worktree');
      const cleaned = cleanupWorktrees({ root, apply: true });
      receipt.worktrees_reaped = cleaned.removed.length;
      if (cleaned.removed.length > 0) receipt.worktrees_reaped_paths = cleaned.removed.map((w) => w.path);
    } catch (err) {
      receipt.janitor_worktree_error = String((err && err.message) || err).slice(0, 200);
    }
    recordJanitorState(state, { stopped: stoppedMissions, held: heldMissions, worktrees: receipt.worktrees_reaped });
  }

  // 3c. landing sweep, every tick: merged branch residue is cleared,
  // TTL-expired work is salvaged before deletion, and 48h-stale active work
  // is carried into the digest instead of silently aging forever.
  try {
    const landingSweep = sweepLanding(root);
    receipt.reaped = landingSweep.reaped;
    receipt.landing_sweep = {
      before: landingSweep.before,
      after: landingSweep.after,
      stale: landingSweep.stale.length,
      human: landingSweep.human.length,
    };
    if (landingSweep.reaped.bundleError) {
      receipt.reap_error = `backup failed, unlanded work kept in place: ${landingSweep.reaped.bundleError}`;
    }
    recordLandingSweepState(state, landingSweep);
  } catch (err) {
    receipt.reap_error = String((err && err.message) || err).slice(0, 200);
    recordLandingSweepState(state, null, { error: receipt.reap_error });
  }

  // 3d. wish sweep: queued wishes are allowed to wake a mission without a
  // foreground `atris wish` session, but they must never endanger landing.
  try {
    const wishDispatch = require('./wish').sweepWishes(root);
    receipt.wish_dispatch = wishDispatch;
  } catch (err) {
    receipt.wish_dispatch_error = String((err && err.message) || err).slice(0, 200);
  }

  // 4. daily digest at the configured hour
  const today = new Date().toISOString().slice(0, 10);
  const digestHour = Number(policy.digest_hour ?? autoland.DEFAULT_DIGEST_HOUR);
  if (new Date().getHours() === digestHour && state.last_digest_date !== today) {
    receipt.digest_due = true;
    let waitingWishes = [];
    try {
      waitingWishes = require('./wish').waitingOperatorWishes(root);
    } catch {}
    const text = autoland.composeDigest({
      accepted: autoland.acceptedInLastDay(readAcceptedTaskHistory(root, tasks)),
      waiting,
      waitingWishes,
      landed: landSummarySafe(root),
      project: projectName(root),
      nextMoves: digestNextMoves(root),
      acceptAll: Boolean(policy.accept_all),
      reapError: state.last_reap_error?.error || null,
      janitor: state.janitor || null,
      landingSweep: state.landing_sweep || null,
    });
    if (policy.imessage_to) {
      const sent = autoland.sendImessage(root, policy.imessage_to, text);
      receipt.digest_sent = sent.ok;
    }
    receipt.digest_text = text;
    state.last_digest_date = today;
    delete state.janitor;

    // 5. once a day, keep the receipt shelf lean: compress old run receipts
    // into the manifest and drop unreferenced clutter, newest 200 kept.
    const prune = runOwnCli(root, ['mission', 'prune-runs', '--apply', '--days', '14', '--keep-newest', '200', '--json']);
    try {
      const pruned = JSON.parse(prune.stdout);
      receipt.receipts_pruned = pruned.pruned_count ?? pruned.pruned ?? pruned.removed ?? 0;
    } catch {
      receipt.receipts_pruned = null;
    }
  }

  // 5b. daily keep/revert experiment — self-gated inside experiments daily;
  // hourly ticks are harmless no-ops after the first run each day.
  if (policy.daily_experiment !== false) {
    const daily = runOwnCli(root, ['experiments', 'daily', '--json']);
    receipt.daily_experiment = {
      status: daily.status,
      stdout: daily.stdout.trim(),
      stderr: daily.stderr.slice(0, 200) || null,
    };
    try {
      receipt.daily_experiment.result = JSON.parse(daily.stdout.trim());
    } catch {
      receipt.daily_experiment.result = null;
    }
  } else {
    receipt.daily_experiment_skipped = true;
  }

  // 6. once a day, do slower mission cleanup. Landing cleanup runs hourly
  // above, outside this date gate, so limbo cannot silently accumulate.
  if (state.last_mission_cleanup_date !== today) {
    // Missions rot the same way branches do: paused/planning/ready and
    // untouched for a week means abandoned. Age them out under the same
    // daily gate so `mission list` shows work, not archaeology.
    try {
      const { expireStaleMissions } = require('./mission');
      const expiredMissions = expireStaleMissions(root);
      const heldMissions = Array.isArray(expiredMissions.held) ? expiredMissions.held : [];
      if (expiredMissions.length > 0) receipt.expired_missions = expiredMissions.length;
      if (expiredMissions.length > 0) receipt.expired_mission_reasons = missionReasonBreakdown(expiredMissions, 'stale');
      if (expiredMissions.length > 0) recordJanitorState(state, { stopped: expiredMissions });
      if (heldMissions.length > 0) {
        receipt.expired_missions_held = heldMissions.length;
        receipt.expired_missions_held_refs = heldMissions.map((m) => m.id);
        receipt.expired_missions_held_reasons = missionReasonBreakdown(heldMissions, 'operator-required');
        recordJanitorState(state, { held: heldMissions });
      }
    } catch (err) {
      receipt.mission_expiry_error = String((err && err.message) || err).slice(0, 200);
    }
    try {
      const missionVerify = verifyClosedTaskMissions(root, readProjection(root));
      if (missionVerify.verified.length > 0) receipt.verified_missions = missionVerify.verified;
      if (missionVerify.errors.length > 0) receipt.mission_verify_errors = missionVerify.errors;
    } catch (err) {
      receipt.mission_verify_errors = [{ error: String((err && err.message) || err).slice(0, 200) }];
    }
    state.last_mission_cleanup_date = today;
  }
  autoland.writeState(root, state);

  try {
    persistTickReceipt(root, receipt);
  } catch (err) {
    receipt.receipt_error = String((err && err.message) || err).slice(0, 200);
  }

  if (json) console.log(JSON.stringify(receipt));
  else {
    const reapedTotal = Number(receipt.reaped?.branches || 0) + Number(receipt.reaped?.worktrees || 0);
    const reapNote = reapedTotal > 0 ? `, reaped ${receipt.reaped.branches} landed/overdue branches` : '';
    const janitorNote = `, janitor stopped ${receipt.missions_stopped} mission${receipt.missions_stopped === 1 ? '' : 's'} + reaped ${receipt.worktrees_reaped} worktree${receipt.worktrees_reaped === 1 ? '' : 's'}`;
    const heldNote = receipt.missions_held ? `, held ${receipt.missions_held} human-blocked mission${receipt.missions_held === 1 ? '' : 's'}` : '';
    const wishNote = `, ${wishSweepSummaryLine(receipt.wish_dispatch, receipt.wish_dispatch_error)}`;
    const receiptNote = receipt.receipt_path ? `, receipt ${receipt.receipt_path}` : '';
    console.log(`autoland tick: ${receipt.reviews_certified ?? 0} reviews certified, ${receipt.landed.length} landed${receipt.landed.length ? ` (${receipt.landed.join(', ')})` : ''}, ${receipt.alarms} alarms, digest ${digestTickStatus(receipt)}${reapNote}${janitorNote}${heldNote}${wishNote}${receiptNote}`);
  }
  return 0;
}

function showHelp() {
  console.log('');
  console.log('atris autoland — you approve the policy once; certified work lands itself');
  console.log('');
  console.log('finished work that passed its checks and two independent reviews lands');
  console.log('automatically with a receipt. money, deploys, security, customer, and');
  console.log('outward-facing work always waits for you.');
  console.log('');
  console.log('recommended agent flight verify: npm run test:fast && node --test <focused files>');
  console.log('autoland still trusts the recorded verifier and full-suite checks when named.');
  console.log('');
  console.log('  atris autoland                     what would land, what waits for you');
  console.log('  atris autoland on [--to <phone>]   flip it on: hourly heartbeat, daily');
  console.log('                                     message, ping when something waits');
  console.log('                                     on you past 24h');
  console.log('  atris autoland on --all            lower the bar: everything lands except');
  console.log('                                     the protected lanes; a failing recorded');
  console.log('                                     check still blocks');
  console.log('  atris autoland off                 back to approving every item');
  console.log('  atris autoland digest [--send]     the daily message, now');
  console.log('  atris autoland tick [--json]       one heartbeat (what the hourly cron runs)');
  console.log('');
  console.log('help is always read-only: atris autoland tick --help never lands work.');
  console.log('');
  return 0;
}

function wantsHelp(args = []) {
  return args.some((arg) => arg === 'help' || arg === '--help' || arg === '-h');
}

function autolandCommand(args = []) {
  const [sub, ...rest] = args;
  if (wantsHelp(args)) return showHelp();
  if (!sub || sub.startsWith('--')) return showStatus(repoRoot(), args);
  const root = repoRoot();
  if (sub === 'on') return turnOn(root, rest);
  if (sub === 'off') return turnOff(root);
  if (sub === 'tick') return runTick(root, rest);
  if (sub === 'digest') return runDigest(root, rest);
  if (sub === 'status') return showStatus(root, rest);
  console.error(`atris autoland: unknown subcommand '${sub}' (try: atris autoland help)`);
  return 1;
}

module.exports = {
  autolandCommand,
  attachedTasksForMission,
  digestNextMoves,
  digestTickStatus,
  explainResult,
  missionReadyForClosedTaskVerify,
  operatorReady,
  readAcceptedTaskHistory,
  hasAgentJargon,
  runTickBody,
  persistTickReceipt,
  sweepLanding,
  verifyClosedTaskMissions,
  wishSweepSummaryLine,
};
