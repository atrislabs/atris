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

function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

// Every tag a row carries: its own tag (and a mission's lane), each metadata
// tag, and '#tag' tokens in the title. Text is title plus every metadata text
// field, so a protected note in a quiet field still holds the branch.
function protectedLane(row) {
  if (!row || typeof row !== 'object') return 'unreadable';
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const title = String(row.title || '');
  const tags = [
    row.tag,
    row.lane,
    ...asList(metadata.tag),
    ...asList(metadata.tags),
    ...asList(metadata.todo_tags),
    ...(title.match(/#[A-Za-z0-9_-]+/g) || []).map((t) => t.slice(1)),
  ];
  for (const tag of tags) {
    const denied = deniedTagOf({ tag: String(tag ?? '') });
    if (denied) return denied;
  }
  const objective = [
    title,
    row.objective,
    metadata.objective,
    metadata.body,
    metadata.description,
    metadata.details,
    metadata.protected_lane_note,
  ].map((v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))).filter(Boolean).join('\n');
  const view = { title, objective, metadata };
  const declared = declaredProtectedLane(view);
  if (declared) return `declared "${declared.phrase}"`;
  const sniffed = sniffedProtectedLane(view);
  if (sniffed) return sniffed.lane;
  return null;
}

// Every task this mission points at, or null when a link is malformed.
function linkedTaskIds(mission) {
  const ids = [];
  if (mission.task_ids !== undefined) {
    if (!Array.isArray(mission.task_ids)) return null;
    for (const id of mission.task_ids) {
      if (typeof id !== 'string' || !id.trim()) return null;
      ids.push(id.trim());
    }
  }
  const xp = mission.xp_task;
  if (xp !== undefined && xp !== null && (typeof xp !== 'object' || Array.isArray(xp))) return null;
  for (const value of [mission.task_id, mission.task_ref, mission.current_task_id, xp?.task_id, xp?.ref]) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !value.trim()) return null;
    ids.push(value.trim());
  }
  return [...new Set(ids)];
}

function defaultLoadTask(id) {
  try {
    const taskDb = require('./task-db');
    return taskDb.getTask(taskDb.open(), id) || null;
  } catch {
    return null;
  }
}

const RECEIPT_STAMP_RE = /^\d{4}-\d{2}-\d{2}T[0-9-]+Z\.json$/;

// The newest run receipt this mission wrote in its own folder, or null.
function latestRunReceipt(missionId, cwd) {
  if (typeof missionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(missionId)) return null;
  const dir = path.join(cwd, 'atris', 'runs');
  const prefix = `mission-${missionId}-`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const latest = names
    .filter((name) => name.startsWith(prefix) && RECEIPT_STAMP_RE.test(name.slice(prefix.length)))
    .sort((a, b) => (a.slice(prefix.length) < b.slice(prefix.length) ? -1 : 1))
    .pop();
  if (!latest) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8'));
    if (!receipt || typeof receipt !== 'object' || receipt.mission_id !== missionId) return null;
    return receipt;
  } catch {
    return null;
  }
}

function receiptTicks(result) {
  if (Array.isArray(result.ticks)) return result.ticks;
  return result.tick ? [result.tick] : [];
}

function receiptReferees(result) {
  const referees = receiptTicks(result).map((tick) => tick && tick.referee_result).filter(Boolean);
  if (result.referee_result) referees.push(result.referee_result);
  const check = result.verifier_result;
  if (check && typeof check === 'object') {
    if (check.referee) referees.push(check.referee);
    else if (check.mode === 'engine') referees.push(check);
  }
  return referees;
}

// Independent means a reviewer engine other than the member and every engine
// that did the work said pass, on this mission's latest run, about the code
// that is checked out now. Any failing referee on that run holds the branch.
function reviewHold(mission, workerEngine, cwd) {
  const receipt = latestRunReceipt(mission.id, cwd);
  if (!receipt) return 'no run receipt for this mission could be read';
  const result = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
  if (result.passed === false) return 'the latest run did not pass';
  const head = run('git', ['rev-parse', 'HEAD^{tree}'], cwd);
  if (!head.ok || !head.stdout || receipt.git_tree !== head.stdout) {
    return 'the latest review was not recorded on the code that is checked out now';
  }
  const referees = receiptReferees(result);
  if (!referees.length) return 'no second reviewer is recorded on the latest run';
  const tickEngines = receiptTicks(result).map((tick) => tick && tick.engine_id);
  const worker = String(workerEngine || mission.runner || '').trim().toLowerCase();
  if (!worker || worker === 'auto') return 'the engine that did the work is unknown';
  const self = new Set([mission.owner, worker, ...tickEngines].map((v) => String(v || '').trim().toLowerCase()).filter(Boolean));
  for (const referee of referees) {
    if (!referee || typeof referee !== 'object' || referee.mode !== 'engine' || referee.passed !== true) {
      return 'a reviewer on the latest run did not pass it';
    }
    const reviewer = String(referee.engine || '').trim().toLowerCase();
    if (!reviewer || self.has(reviewer)) return 'the latest run was reviewed by the same engine that did the work';
  }
  return null;
}

function held(gate, line) {
  return { merged: false, auto_merge: false, gate, line: `left the branch for you: ${line}` };
}

function autolandMemberRun({ mission, cwd, summary = '', workerEngine = '', loadTask = defaultLoadTask } = {}) {
  if (!mission || typeof mission !== 'object') return held('mission', 'the mission could not be read');
  if (mission.verifier_result?.passed !== true) return held('check', 'the check did not pass');
  if (!policyOn(cwd)) return held('policy', 'self-landing is not switched on in the main checkout');

  const missionLane = protectedLane({ ...mission, title: mission.objective });
  if (missionLane) return held('protected', `this mission sits in a protected area (${missionLane})`);
  const taskIds = linkedTaskIds(mission);
  if (!taskIds) return held('protected', 'the mission\'s linked tasks are not a clean list of ids');
  for (const id of taskIds) {
    let task = null;
    try {
      task = loadTask(id, cwd);
    } catch {
      task = null;
    }
    if (!task || typeof task !== 'object') return held('protected', `a linked task (${id}) could not be read`);
    const lane = protectedLane(task);
    if (lane) return held('protected', `a linked task sits in a protected area (${lane})`);
  }

  const reviewGap = reviewHold(mission, workerEngine, cwd);
  if (reviewGap) return held('review', reviewGap);

  const branchRead = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = String(mission.worktree?.branch || branchRead.stdout || '').trim();
  if (!branch || branch === 'HEAD' || branch === 'master' || branch === 'main') {
    return held('branch', 'the work is not on its own branch');
  }
  const remoteHead = run('git', ['ls-remote', '--symref', 'origin', 'HEAD'], cwd);
  const base = (remoteHead.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m) || [])[1] || '';
  if (!remoteHead.ok || !base) return held('base', 'the main branch on GitHub could not be read');
  if (branch === base) return held('branch', 'the work is not on its own branch');
  const headRead = run('git', ['rev-parse', 'HEAD'], cwd);
  const headSha = headRead.ok ? headRead.stdout : '';
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) return held('branch', 'the latest commit could not be read');

  const push = run('git', ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], cwd);
  if (!push.ok) return held('push', `the branch could not be pushed (${push.stderr.split('\n')[0]})`);

  // Find the open pull request from exactly this branch into the main
  // branch, or open one. Merge is always addressed by number, never by a
  // branch name gh might read as a number, and pinned to the pushed commit.
  const listed = run('gh', [
    'pr', 'list', '--head', branch, '--base', base, '--state', 'open',
    '--json', 'number,headRefName,baseRefName,headRefOid,isCrossRepository',
  ], cwd);
  if (!listed.ok) return held('pull request', `open pull requests could not be read (${listed.stderr.split('\n')[0]})`);
  let rows;
  try {
    rows = JSON.parse(listed.stdout || '[]');
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) return held('pull request', 'open pull requests could not be read');
  const matches = rows.filter((pr) => pr && pr.headRefName === branch && pr.baseRefName === base
    && pr.isCrossRepository === false && Number.isInteger(pr.number) && pr.number > 0);
  if (matches.length > 1) return held('pull request', 'more than one pull request is open for this branch');
  let number = matches.length ? matches[0].number : 0;
  let url = '';
  if (!number) {
    const title = String(mission.objective || branch).replace(/\s+/g, ' ').trim().slice(0, 70);
    const body = String(summary || '').trim() || `Receipt: ${mission.receipt_path || 'none recorded'}`;
    const created = run('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body], cwd);
    url = created.ok ? created.stdout.split('\n').pop().trim() : '';
    number = Number((url.match(/\/pull\/(\d+)$/) || [])[1] || 0);
    if (!created.ok || !number) {
      return held('pull request', `the pull request could not be opened (${(created.stderr || url).split('\n')[0]})`);
    }
  }
  const label = url || `pull request #${number}`;

  const merge = run('gh', ['pr', 'merge', String(number), '--auto', '--merge', '--match-head-commit', headSha], cwd);
  if (!merge.ok) return held('auto-merge', `auto-merge could not be switched on for ${label}`);
  return { merged: false, auto_merge: true, gate: null, url: label, line: `merges on its own once checks pass: ${label}` };
}

module.exports = { autolandMemberRun };
