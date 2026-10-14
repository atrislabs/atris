'use strict';

// Finished member work lands itself when the owner turned self-landing on.
//
// `atris member run ... --ignite` ends with the work committed on the
// mission's own branch and the mission complete. Before this module a human
// merged that branch by hand. Now it can land itself, but only when every one
// of these holds, and anything short of that leaves the branch where it is
// with one plain line saying why:
//
// - the main checkout's autoland policy says `enabled: true` (missing,
//   unreadable, or anything else means off), read again right before merging;
// - neither the mission nor any task it links sits in a protected lane;
// - an independent reviewer ended its pass with VERDICT: PASS;
// - under one shared lock, the branch rebases on the latest origin default
//   branch, its check passes, and the base has not moved since. A moved base
//   gets one more rebase and check; a second move leaves the branch.
// - the merge names the exact commit that was checked.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const LOCK_STALE_MS = 15 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

function git(args, cwd, env) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env, maxBuffer: MAX_BUFFER });
  return { ok: result.status === 0, out: String(result.stdout || '').trim(), err: String(result.stderr || '').trim() };
}

// The primary checkout that owns this repository, found from the git common
// dir so a linked checkout's own files never count as the owner's policy.
function mainCheckout(dir, env) {
  if (!dir) return null;
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir, env);
  if (!common.ok || path.basename(common.out) !== '.git') return null;
  return path.dirname(common.out);
}

function policyOn(main) {
  if (!main) return false;
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), 'utf8'));
    return Boolean(policy) && typeof policy === 'object' && policy.enabled === true;
  } catch {
    return false;
  }
}

// The cross-engine referee's verdict recorded on the mission's last check.
function independentReviewPassed(mission) {
  const result = mission.verifier_result;
  if (!result || result.passed !== true) return false;
  const review = result.mode === 'engine' ? result : result.referee;
  if (!review || review.mode !== 'engine' || review.passed !== true) return false;
  return String(review.output || '').trim().split(/\r?\n/).pop() === 'VERDICT: PASS';
}

function protectedReason(item, label) {
  const {
    deniedTagOf,
    declaredProtectedLane,
    sniffedProtectedLane,
  } = require('./auto-accept-certified');
  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const todoTags = Array.isArray(metadata.todo_tags) ? metadata.todo_tags : [];
  const view = {
    ...item,
    title: item.title || metadata.title || '',
    objective: item.objective || metadata.objective || '',
    tag: [item.tag, item.lane, ...todoTags].filter(Boolean).join(' '),
    metadata,
  };
  const denied = deniedTagOf(view);
  if (denied) return `${label} sits in the protected ${denied} lane, so a human lands it`;
  const declared = declaredProtectedLane(view);
  if (declared) return `${label} says "${declared.phrase}", so a human lands it`;
  const sniffed = sniffedProtectedLane(view);
  if (sniffed) return `${label} mentions ${sniffed.term}, which belongs to the protected ${sniffed.lane} lane, so a human lands it`;
  return null;
}

function linkedTaskRefs(mission) {
  const ids = Array.isArray(mission.task_ids) ? mission.task_ids : [];
  const xp = mission.xp_task || {};
  return [...new Set([...ids, mission.task_ref, mission.task_id, mission.current_task_id, xp.task_id, xp.ref]
    .filter(Boolean).map(String))];
}

// Every task the mission links, read from the task store. A link that cannot
// be read counts as protected: nobody can say it is safe.
function linkedTasks(mission, main, env) {
  const refs = linkedTaskRefs(mission);
  if (!refs.length) return { tasks: [] };
  try {
    const taskDb = require('./task-db');
    const db = taskDb.open(env.ATRIS_TASKS_DB || undefined);
    let rows = null;
    const tasks = [];
    for (const ref of refs) {
      let task = taskDb.getTask(db, ref);
      if (!task) {
        rows = rows || taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot: taskDb.workspaceRoot(main) }));
        const want = taskDb.normalizeTaskRef(ref);
        task = rows.find((row) => [row.id, row.display_id, row.legacy_ref]
          .some((value) => value && taskDb.normalizeTaskRef(value) === want)) || null;
      }
      if (!task) return { missing: ref };
      tasks.push(task);
    }
    return { tasks };
  } catch {
    return { missing: refs[0] };
  }
}

function takeLock(main) {
  const file = path.join(main, '.atris', 'state', 'member-autoland.lock');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return file;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return null;
      let age;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (age < LOCK_STALE_MS) return null;
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return null;
}

function shipMessage(mission) {
  const words = String(mission.objective || mission.title || 'member work').replace(/\s+/g, ' ').trim();
  const short = words.length > 80 ? `${words.slice(0, 80).replace(/\s+\S*$/, '')}...` : words;
  return `${mission.owner || 'member'}: ${short}`;
}

function rebaseReason(rebased, base) {
  if (rebased.stage === 'rebase_conflict') {
    const files = (rebased.conflicts || []).slice(0, 3).join(', ');
    return `it conflicts with the latest ${base}${files ? ` in ${files}` : ''}`;
  }
  if (rebased.stage === 'dirty_worktree') return 'its checkout has uncommitted changes';
  if (rebased.stage === 'fetch') return `could not fetch the latest ${base}`;
  return `the rebase on ${base} failed`;
}

function shipReason(shipped) {
  const err = String(shipped.stderr || '').replace(/^\s*✗ Error:\s*/m, '').trim();
  const blocked = err.split(/\r?\n/).find((line) => /^blocked: /.test(line.trim()));
  if (blocked) return blocked.trim().replace(/^blocked: /, '');
  const first = err.split(/\r?\n/).find(Boolean);
  return first ? `the merge failed: ${first.trim().slice(0, 160)}` : 'the merge did not finish';
}

// Rebase, check, compare the base, merge. Runs only while holding the lock.
function landUnderLock({ main, mission, worktreePath, check, targetRef, base, env, held }) {
  const { landArrival } = require('./fleet');
  for (let round = 0; round < 2; round += 1) {
    const rebased = landArrival({ worktreePath, targetRef });
    if (!rebased.ok) return held(rebased.stage || 'rebase_failed', rebaseReason(rebased, base));
    const baseSha = git(['rev-parse', targetRef], worktreePath, env);
    const head = git(['rev-parse', 'HEAD'], worktreePath, env);
    if (!baseSha.ok || !head.ok) return held('no_base', `could not read the latest ${base}`);

    const before = git(['status', '--porcelain=v1', '--untracked-files=all'], worktreePath, env);
    const ran = spawnSync(check, { cwd: worktreePath, shell: true, encoding: 'utf8', env, maxBuffer: MAX_BUFFER });
    if (ran.status !== 0) return held('check_failed', 'its check failed after the rebase');
    const after = git(['status', '--porcelain=v1', '--untracked-files=all'], worktreePath, env);
    if (!before.ok || !after.ok || before.out !== after.out) return held('check_dirtied', 'its check changed files in the checkout');
    if (git(['rev-parse', 'HEAD'], worktreePath, env).out !== head.out) {
      return held('head_moved', 'the branch changed while its check ran');
    }

    // Right before merging: has the base moved since the rebase?
    if (!git(['fetch', 'origin', base], worktreePath, env).ok) return held('fetch', `could not fetch the latest ${base}`);
    if (git(['rev-parse', targetRef], worktreePath, env).out !== baseSha.out) continue;
    if (!policyOn(main)) return held('policy_off', 'the autoland switch was turned off before it merged');

    const shipped = spawnSync(process.execPath, [
      CLI, 'worktree', 'ship',
      '--message', shipMessage(mission),
      '--target', targetRef,
      '--match-head-commit', head.out,
      '--expect-base', baseSha.out,
      '--merge',
    ], { cwd: worktreePath, encoding: 'utf8', env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, maxBuffer: MAX_BUFFER });
    if (shipped.status === 4 && /^blocked: base moved:/m.test(String(shipped.stderr || ''))) continue;
    if (shipped.status !== 0 || !/^merge: merged/m.test(String(shipped.stdout || ''))) {
      return held('ship_failed', shipReason(shipped));
    }
    return { attempted: true, landed: true, reason: 'landed', line: `landed: merged into ${base} after its check passed again` };
  }
  return held('base_moved', `${base} kept moving while its check ran, so it was not merged`);
}

// Returns { attempted, landed, reason, line }. `attempted: false` means the
// policy is not explicitly on and the run behaves exactly as before.
function landFinishedMemberRun({ mission, env = process.env } = {}) {
  const worktreePath = mission && mission.worktree && mission.worktree.path;
  const main = mainCheckout(worktreePath || process.cwd(), env);
  if (!policyOn(main)) return { attempted: false, landed: false, reason: 'policy_off', line: '' };
  const held = (reason, why) => ({ attempted: true, landed: false, reason, line: `left on its branch: ${why}` });
  if (!mission || mission.status !== 'complete') return held('check_not_passed', 'its check has not passed');
  if (!worktreePath) {
    return { attempted: true, landed: false, reason: 'no_branch', line: 'not landed: it ran in the main checkout, not on its own branch' };
  }
  const check = String(mission.verifier || '').trim();
  if (!check) return held('no_check', 'it has no check to rerun after the rebase');
  if (!independentReviewPassed(mission)) return held('no_review', 'no independent review passed it');

  const lane = protectedReason(mission, 'it');
  if (lane) return held('protected_lane', lane);
  const linked = linkedTasks(mission, main, env);
  if (linked.missing) return held('protected_lane', `its linked task ${linked.missing} could not be read, so a human lands it`);
  for (const task of linked.tasks) {
    const taskLane = protectedReason(task, `its linked task "${task.title || task.id}"`);
    if (taskLane) return held('protected_lane', taskLane);
  }

  let targetRef;
  try {
    targetRef = require('../commands/worktree').defaultMainlineBase(worktreePath);
  } catch (error) {
    return held('no_base', String(error && error.message || error));
  }
  if (!targetRef || targetRef === 'HEAD' || !targetRef.startsWith('origin/')) {
    return held('no_base', 'there is no origin default branch to land on');
  }
  const base = targetRef.replace(/^origin\//, '');

  const lock = takeLock(main);
  if (!lock) return held('locked', 'another member run is landing right now');
  try {
    return landUnderLock({ main, mission, worktreePath, check, targetRef, base, env, held });
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

module.exports = {
  landFinishedMemberRun,
};
