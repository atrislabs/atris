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
const { isDecisionHoldTag, isDecisionTask } = require('./task-decision');

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

const TAG_KEYS = new Set(['tag', 'tags', 'todo_tags', 'lane']);
const METADATA_DEPTH_LIMIT = 6;
const METADATA_TEXT_CAP = 64 * 1024;

// Every string anywhere in metadata, and the ones anywhere below a tag key.
// Metadata too deep or too large to read whole returns null, which holds.
function metadataStrings(metadata) {
  const texts = [];
  const tags = [];
  let size = 0;
  const walk = (value, depth, tagged) => {
    if (typeof value === 'string') {
      size += value.length;
      texts.push(value);
      if (tagged) tags.push(value);
      return size <= METADATA_TEXT_CAP;
    }
    if (!value || typeof value !== 'object') return true;
    if (depth >= METADATA_DEPTH_LIMIT) return false;
    if (Array.isArray(value)) return value.every((item) => walk(item, depth + 1, tagged));
    return Object.entries(value).every(([key, item]) => walk(item, depth + 1, tagged || TAG_KEYS.has(key)));
  };
  return walk(metadata, 0, false) ? { texts, tags } : null;
}

// A row's protected lane, or null. Tags are its own tag and lane, every
// string under a tag key anywhere in metadata, and '#tag' words in the title.
// Text is the title, objective, and every string in metadata.
function protectedLane(row) {
  if (!row || typeof row !== 'object') return 'unreadable';
  // Metadata is a plain object or absent; anything else, including stored
  // text that would not parse, cannot be checked.
  const meta = row.metadata;
  if (row.metadata_unreadable || (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta)))) {
    return 'metadata could not be read';
  }
  const found = metadataStrings(meta);
  if (!found) return 'metadata too large to check';
  const title = String(row.title || '');
  const tags = [
    row.tag,
    row.lane,
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...found.tags,
    ...(title.match(/#[A-Za-z0-9_-]+/g) || []).map((t) => t.slice(1)),
  ];
  // Decision rows wait for a person; the same rule member go's picker uses.
  if (isDecisionTask(row)) return 'needs a human decision';
  for (const tag of tags) {
    const text = String(tag ?? '');
    if ([text, ...text.split(/[\s,]+/)].some(isDecisionHoldTag)) return 'needs a human decision';
    const denied = deniedTagOf({ tag: text });
    if (denied) return denied;
  }
  const objective = [title, typeof row.objective === 'string' ? row.objective : '', ...found.texts].filter(Boolean).join('\n');
  const view = { title, objective, metadata: {} };
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

// Review must cover the final code of the final run. The newest receipt for
// this mission must be a finished run's summary, recorded on a clean folder
// whose code tree is the one checked out now, with nothing newer in the
// mission's own state and no commit made after it. Every tick in that run
// must have passed its check and a verdict from a reviewer engine other than
// the member and every engine that did the work.
function reviewHold(mission, workerEngine, cwd, pin = {}) {
  const receipt = latestRunReceipt(mission.id, cwd);
  if (!receipt) return 'no run receipt for this mission could be read';
  const result = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
  if (result.kind !== 'mission_run_summary') return 'the latest run has not finished';
  const receiptAt = Date.parse(receipt.at || '');
  if (!Number.isFinite(receiptAt)) return 'the latest run receipt has no time';
  if (receipt.clean !== true) return 'the latest run ended with unsaved changes';
  const head = run('git', ['rev-parse', 'HEAD^{tree}'], cwd);
  if (!head.ok || !head.stdout || receipt.git_tree !== head.stdout) {
    return 'the latest review was not recorded on the code that is checked out now';
  }
  const commitTime = run('git', ['log', '-1', '--format=%ct', 'HEAD'], cwd);
  const committedAt = Number(commitTime.stdout) * 1000;
  if (!commitTime.ok || !Number.isFinite(committedAt) || committedAt <= 0 || committedAt > receiptAt) {
    return 'the code was committed after the latest review';
  }

  const ticks = Array.isArray(result.ticks) ? result.ticks : [];
  if (!ticks.length || result.tick_count !== ticks.length) return 'no reviewed work is recorded on the latest run';
  const lastTick = ticks[ticks.length - 1] || {};
  const lastTickAt = Date.parse(mission.last_tick_at || '');
  if (!Number.isFinite(lastTickAt) || lastTickAt > receiptAt) return 'the mission ran again after the latest receipt';
  if (mission.last_tick_status !== 'ran') return 'the mission\'s last step did not finish cleanly';
  if (mission.last_tick_index !== undefined && mission.last_tick_index !== lastTick.tick_index) {
    return 'the mission ran again after the latest receipt';
  }

  const worker = String(workerEngine || mission.runner || '').trim().toLowerCase();
  if (!worker || worker === 'auto') return 'the engine that did the work is unknown';
  const self = new Set([mission.owner, worker, ...ticks.map((tick) => tick && tick.engine_id)]
    .map((v) => String(v || '').trim().toLowerCase()).filter(Boolean));
  for (const tick of ticks) {
    if (!tick || typeof tick !== 'object' || tick.status !== 'ran' || tick.verifier_passed !== true) {
      return 'a step on the latest run did not pass its check';
    }
    const referee = tick.referee_result;
    if (!referee || typeof referee !== 'object' || referee.mode !== 'engine' || referee.passed !== true) {
      return 'a reviewer on the latest run did not pass it';
    }
    const reviewer = String(referee.engine || '').trim().toLowerCase();
    if (!reviewer || self.has(reviewer)) return 'the latest run was reviewed by the same engine that did the work';
  }
  if (lastTick.reviewed_git_tree !== head.stdout) return 'the review did not see the code that is checked out now';
  pin.tree = head.stdout;
  return null;
}

// The checked-out code as git sees it with config tricks switched off: every
// untracked file listed, submodules compared, no file monitor, and no index
// entry marked assume-unchanged or skip-worktree (anything but an 'H' tag).
function gitCodeState(cwd) {
  const status = run('git', [
    '-c', 'status.showUntrackedFiles=all', '-c', 'core.fsmonitor=false',
    'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none',
  ], cwd);
  const index = run('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-v'], cwd);
  const hidden = !index.ok || index.stdout.split('\n').some((line) => line && !line.startsWith('H '));
  const tree = run('git', ['rev-parse', 'HEAD^{tree}'], cwd);
  return {
    clean: status.ok && !status.stdout && !hidden,
    status: status.ok ? status.stdout : null,
    tree: tree.ok && tree.stdout ? tree.stdout : null,
  };
}

function unsavedHold(cwd) {
  if (!gitCodeState(cwd).clean) return 'unsaved changes; the check may not match what would merge';
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

  const unsaved = unsavedHold(cwd);
  if (unsaved) return held('unsaved', unsaved);
  const pin = {};
  const reviewGap = reviewHold(mission, workerEngine, cwd, pin);
  if (reviewGap) return held('review', reviewGap);
  // Pin the commit the review passed on. Only this commit is pushed and
  // merged, so a commit made after this point never rides along.
  const headRead = run('git', ['rev-parse', 'HEAD'], cwd);
  const headSha = headRead.ok ? headRead.stdout : '';
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) return held('branch', 'the latest commit could not be read');
  const pinnedTree = () => {
    const tree = run('git', ['rev-parse', `${headSha}^{tree}`], cwd);
    return tree.ok && tree.stdout === pin.tree;
  };
  if (!pin.tree || !pinnedTree()) return held('review', 'the code moved while the review was being checked');

  const branchRead = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = String(mission.worktree?.branch || branchRead.stdout || '').trim();
  if (!branch || branch === 'HEAD' || branch === 'master' || branch === 'main') {
    return held('branch', 'the work is not on its own branch');
  }
  const remoteHead = run('git', ['ls-remote', '--symref', 'origin', 'HEAD'], cwd);
  const base = (remoteHead.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m) || [])[1] || '';
  if (!remoteHead.ok || !base) return held('base', 'the main branch on GitHub could not be read');
  if (branch === base) return held('branch', 'the work is not on its own branch');

  if (!pinnedTree()) return held('review', 'the reviewed commit no longer holds the reviewed code');
  const push = run('git', ['push', 'origin', `${headSha}:refs/heads/${branch}`], cwd);
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

module.exports = { autolandMemberRun, gitCodeState };
