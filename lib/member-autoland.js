'use strict';

// After an ignited member run ends with its check passing, hand the branch to
// GitHub auto-merge. Every local gate fails closed: the branch stays put and
// one plain line says which gate held it. GitHub then waits for the branch to
// be up to date and CI green; this never merges, rebases, or polls itself.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  deniedTagOf,
  declaredProtectedLane,
  sniffedProtectedLane,
} = require('./auto-accept-certified');

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000 });
  return {
    ok: res.status === 0,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || res.error?.message || '').trim(),
  };
}

// The policy lives in the main checkout, not the mission's worktree copy.
function mainCheckoutRoot(cwd) {
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common.ok || !common.stdout) return null;
  return path.dirname(common.stdout);
}

function policyOn(cwd) {
  const root = mainCheckoutRoot(cwd);
  if (!root) return false;
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'policy', 'autoland.json'), 'utf8'));
    return Boolean(policy) && typeof policy === 'object' && policy.enabled === true;
  } catch {
    return false;
  }
}

function protectedLane(row) {
  const metadata = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const view = {
    ...row,
    tag: row.tag || metadata.tag || '',
    objective: row.objective || metadata.objective || '',
    metadata,
  };
  const denied = deniedTagOf(view);
  if (denied) return denied;
  const declared = declaredProtectedLane(view);
  if (declared) return `declared "${declared.phrase}"`;
  const sniffed = sniffedProtectedLane(view);
  if (sniffed) return sniffed.lane;
  return null;
}

function linkedTaskIds(mission) {
  const ids = Array.isArray(mission.task_ids) ? mission.task_ids : [];
  return [...new Set([...ids, mission.current_task_id].filter(Boolean).map(String))];
}

function defaultLoadTask(id) {
  try {
    const taskDb = require('./task-db');
    return taskDb.getTask(taskDb.open(), id) || null;
  } catch {
    return null;
  }
}

// Independent means someone other than the member and the engine that did
// the work said pass. A run's cross-engine referee is saved on the mission's
// check result; an explicit review_verdict counts the same way. When the
// worker engine is unknown, independence cannot be shown, so it holds.
function recordedReview(mission) {
  const verdict = mission.review_verdict;
  if (verdict && typeof verdict === 'object') return { passed: verdict.passed, reviewer: verdict.reviewer };
  const check = mission.verifier_result || {};
  const referee = check.referee || (check.mode === 'engine' ? check : null);
  if (referee && typeof referee === 'object' && referee.mode === 'engine') {
    return { passed: referee.passed, reviewer: referee.engine };
  }
  return null;
}

function reviewPassed(mission, workerEngine) {
  const review = recordedReview(mission);
  if (!review || review.passed !== true) return false;
  const reviewer = String(review.reviewer || '').trim().toLowerCase();
  const worker = String(workerEngine || mission.runner || '').trim().toLowerCase();
  if (!reviewer || !worker || worker === 'auto') return false;
  const self = [mission.owner, worker].map((v) => String(v || '').trim().toLowerCase());
  return !self.includes(reviewer);
}

function held(gate, line) {
  return { merged: false, auto_merge: false, gate, line: `left the branch for you: ${line}` };
}

function autolandMemberRun({ mission, cwd, summary = '', workerEngine = '', loadTask = defaultLoadTask } = {}) {
  if (!mission || typeof mission !== 'object') return held('mission', 'the mission could not be read');
  if (mission.verifier_result?.passed !== true) return held('check', 'the check did not pass');
  if (!policyOn(cwd)) return held('policy', 'self-landing is not switched on in the main checkout');

  const missionLane = protectedLane({
    title: mission.objective,
    objective: mission.objective,
    tag: mission.tag || mission.lane || '',
    metadata: mission.metadata,
  });
  if (missionLane) return held('protected', `this mission sits in a protected area (${missionLane})`);
  for (const id of linkedTaskIds(mission)) {
    const task = loadTask(id, cwd);
    if (!task) return held('protected', `a linked task (${id}) could not be read`);
    const lane = protectedLane(task);
    if (lane) return held('protected', `a linked task sits in a protected area (${lane})`);
  }

  if (!reviewPassed(mission, workerEngine)) return held('review', 'no passing review from a second reviewer is recorded');

  const branchRead = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = String(mission.worktree?.branch || branchRead.stdout || '').trim();
  if (!branch || branch === 'HEAD' || branch === 'master' || branch === 'main') {
    return held('branch', 'the work is not on its own branch');
  }

  const push = run('git', ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], cwd);
  if (!push.ok) return held('push', `the branch could not be pushed (${push.stderr.split('\n')[0]})`);

  const title = String(mission.objective || branch).replace(/\s+/g, ' ').trim().slice(0, 70);
  const body = String(summary || '').trim() || `Receipt: ${mission.receipt_path || 'none recorded'}`;
  const created = run('gh', ['pr', 'create', '--head', branch, '--title', title, '--body', body], cwd);
  let url = created.ok ? created.stdout.split('\n').pop() : '';
  if (!created.ok) {
    const existing = run('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], cwd);
    if (!existing.ok) return held('pull request', `the pull request could not be opened (${created.stderr.split('\n')[0]})`);
    url = existing.stdout;
  }

  const merge = run('gh', ['pr', 'merge', branch, '--auto', '--merge'], cwd);
  if (!merge.ok) return held('auto-merge', `auto-merge could not be switched on for ${url}`);
  return { merged: false, auto_merge: true, gate: null, url, line: `merges on its own once checks pass: ${url}` };
}

module.exports = { autolandMemberRun };
