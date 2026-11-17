'use strict';

// Every member run ends in one of two recorded states:
//   landed   its work is in the main branch, or autoland handed it to the
//            merge line (pull request open with auto-merge on)
//   dropped  it made no change; its copy and branch are removed
// A run that stopped without either is unfinished, and its member finishes it
// before it may start another step. On the desktop app on 2026-11-14, 118
// member runs ended by just stopping: 91 never reached a pull request, later
// runs redid or stacked on unlanded ones, and 44 copies (6.8 GB) stayed on disk.
//
// Finishing a run: try to land it with autoland; fetch the main branch and try
// once more; if it still does not land, it waits for the owner (a feed
// question: keep or drop?) and the member may move on. Its branch stays.
//
// The record lives in the main checkout at .atris/state/member-runs.json, one
// entry per branch. A member run is a registered copy whose own mission record
// (mission start --worktree writes it there) names that copy and an owner.
// States: running (its process is alive), landed, dropped, owner (waits for
// the owner), unfinished (anything else, including copies older than this
// record).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LEDGER = 'member-runs.json';
// A wake finishes at most this many old runs, so a backlog is worked down a
// few at a time instead of in one very long wake.
const MAX_PER_WAKE = 3;

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function git(args, cwd) {
  const res = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  return { ok: res.status === 0, stdout: String(res.stdout || '').trim(), stderr: String(res.stderr || res.error?.message || '').trim() };
}

function canonical(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(String(value || ''));
  }
}

function mainRoot(cwd) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return common.ok && common.stdout ? path.dirname(common.stdout) : null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function ledgerFile(main) {
  return path.join(main, '.atris', 'state', LEDGER);
}

function readLedger(main) {
  try {
    const data = JSON.parse(fs.readFileSync(ledgerFile(main), 'utf8'));
    if (data && data.runs && typeof data.runs === 'object' && !Array.isArray(data.runs)) return data.runs;
  } catch {}
  return {};
}

// Several members end runs at once, so each write holds a lock file.
function noteRun(main, branch, fields) {
  const file = ledgerFile(main);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = () => {
    const runs = readLedger(main);
    const entry = { ...(runs[branch] || {}), ...fields, branch, at: new Date().toISOString() };
    runs[branch] = entry;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ schema: 'atris.member_runs.v1', runs }, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return entry;
  };
  return require('./handoff-wake').withFileLock(`${file}.lock`, write, { waitMs: 30000 });
}

// The newest mission record in a copy that names that copy and an owner.
function missionForCopy(copy) {
  let text;
  try {
    text = fs.readFileSync(path.join(copy, '.atris', 'state', 'missions.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const want = canonical(copy);
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && record.id) byId.set(record.id, record);
    } catch {}
  }
  let found = null;
  for (const mission of byId.values()) {
    const where = mission.worktree && mission.worktree.path;
    if (!mission.owner || !where || canonical(where) !== want) continue;
    if (!found || String(mission.updated_at || '') > String(found.updated_at || '')) found = mission;
  }
  return found;
}

function stateOf(entry, alive) {
  if (['landed', 'dropped', 'owner'].includes(entry.state)) return entry.state;
  if (entry.state === 'running' && alive(entry.pid)) return 'running';
  return 'unfinished';
}

// Every member run in this project, from its copies and the record.
function listMemberRuns(cwd = process.cwd(), { alive = pidAlive } = {}) {
  const main = mainRoot(cwd);
  if (!main) return { main: null, runs: [] };
  let copies = [];
  try {
    copies = require('./worktree-core').listWorktrees(main).slice(1);
  } catch {
    copies = [];
  }
  const ledger = readLedger(main);
  const runs = [];
  const seen = new Set();
  for (const wt of copies) {
    if (!wt.branch || wt.branch === 'detached' || wt.prunable) continue;
    const entry = ledger[wt.branch] || {};
    // A copy whose record already moved out is still known by its entry.
    const mission = missionForCopy(wt.path)
      || (entry.member ? { owner: entry.member, id: entry.mission_id, objective: entry.title } : null);
    if (!mission) continue;
    seen.add(wt.branch);
    runs.push({
      member: mission.owner,
      branch: wt.branch,
      path: wt.path,
      mission_id: mission.id || null,
      title: oneLine(mission.objective).slice(0, 160),
      started_at: mission.created_at || entry.started_at || null,
      state: stateOf(entry, alive),
      why: entry.why || '',
      copy_kept: entry.copy_kept || null,
    });
  }
  // A run held for the owner whose copy is already gone still waits on them.
  for (const [branch, entry] of Object.entries(ledger)) {
    if (seen.has(branch) || !entry || entry.state !== 'owner') continue;
    runs.push({
      member: entry.member || '', branch, path: null, mission_id: entry.mission_id || null,
      title: entry.title || '', started_at: null, state: 'owner', why: entry.why || '', copy_kept: null,
    });
  }
  return { main, runs };
}

// The branch a run lands in: the main checkout's ship target, or its own
// branch when the project has no remote.
function targetRef(main) {
  const core = require('./worktree-core');
  const target = core.normalizeTargetRef(main, core.defaultShipTarget(main));
  if (target && target !== 'HEAD') return target;
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], main);
  return branch.ok && branch.stdout ? branch.stdout : 'HEAD';
}

// The branch still points where its copy was cut: the run made no commit.
function madeNoCommit(main, branch, tip) {
  const log = git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], main);
  const lines = log.ok ? log.stdout.split('\n').filter(Boolean) : [];
  return lines.length > 0 && lines[lines.length - 1] === tip;
}

function copyIsClean(copy) {
  const autoland = require('./member-autoland');
  return autoland.codeStatus(autoland.gitCodeState(copy)) === '';
}

// Files a run writes for itself in its copy: its mission state, receipts and
// status pages, and the node_modules link mission start made to the main
// checkout. Git ignores them, so the usual removal keeps every member copy
// for them; that is how 44 copies piled up. They move to the main checkout's
// record first, so nothing is lost.
const RUN_RECORD = /^(?:\.atris|atris\/runs|atris\/status)\//;

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

// Move the run's own files out of a clean, idle copy. Returns '' when done,
// or the reason the copy stays (then nothing was moved).
function moveRunRecord({ main, copy, branch, scan }) {
  const core = require('./worktree-core');
  const counts = core.statusCounts(copy);
  if (!counts) return 'unreadable';
  if (counts.staged || counts.unstaged || counts.untracked) {
    return `it still has ${counts.staged + counts.unstaged + counts.untracked} unsaved changes`;
  }
  const ignored = core.ignoredFilesToKeep(copy);
  if (!ignored) return 'could not check the files git ignores';
  const isRecord = (rel) => RUN_RECORD.test(rel) || (rel === 'node_modules' && isLink(path.join(copy, rel)));
  const others = ignored.filter((rel) => !isRecord(rel));
  if (others.length) return `it holds ignored files atris cannot rebuild: ${others.slice(0, 3).join(', ')}`;
  if (!ignored.length) return '';
  const active = scan();
  if (!Array.isArray(active)) return 'could not list running programs';
  if (core.worktreeHasActiveProcess(copy, active)) return 'a program is still working in it';
  const archive = path.join(main, '.atris', 'state', 'member-runs', branch.replace(/[^A-Za-z0-9._-]+/g, '_'));
  for (const rel of ignored) {
    const from = path.join(copy, rel);
    if (rel === 'node_modules') {
      fs.unlinkSync(from);
      continue;
    }
    const to = path.join(archive, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    }
  }
  return '';
}

// Remove a finished run's copy through the usual checks (unsaved changes,
// kept files, a lock, a program inside, work not safe anywhere).
// activePaths lists paths open in running programs; one scan serves both checks.
function defaultRemoveCopy({ root, primary, branch, landedOn, activePaths }) {
  const core = require('./worktree-core');
  let scanned;
  const scan = () => {
    if (scanned === undefined) scanned = (activePaths || core.listActiveProcessPaths)();
    return scanned;
  };
  const held = moveRunRecord({ main: primary, copy: root, branch, scan });
  if (held) return { removed: false, reason: held };
  return core.removeShippedCopyNow({ root, primary, branch, landedOn, activePaths: scan });
}

// Decide whether a run has ended, from what autoland said (if it ran) and
// where its branch is. landed and dropped remove the copy (the usual checks
// keep a copy with unsaved changes, kept files, a lock, or a program inside),
// and dropped removes the branch too. Anything else is unfinished.
function settleRun({ main, copy, branch, mission, landing = null, target, removeCopy = defaultRemoveCopy }) {
  let state = '';
  let why = '';
  let landedOn = '';
  if (landing && landing.merged) {
    state = 'landed';
    why = oneLine(landing.line);
    landedOn = landing.base || target;
  } else if (landing && landing.auto_merge) {
    state = 'landed';
    why = oneLine(landing.line);
    landedOn = `origin/${branch}`;
  } else {
    const tip = git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], main).stdout;
    const inTarget = Boolean(tip) && git(['merge-base', '--is-ancestor', tip, target], main).ok;
    if (inTarget && copyIsClean(copy)) {
      landedOn = target;
      if (madeNoCommit(main, branch, tip)) {
        state = 'dropped';
        why = 'it made no change';
      } else {
        state = 'landed';
        why = `its work is already in ${require('./worktree-core').baseBranchName(target)}`;
      }
    }
  }
  const base = {
    member: mission.owner, mission_id: mission.id || null, title: oneLine(mission.objective).slice(0, 160), path: copy,
    started_at: mission.created_at || null,
  };
  if (!state) {
    return { ...base, branch, state: 'unfinished', why: landing ? oneLine(landing.line) : 'it stopped without landing' };
  }
  let removal;
  try {
    removal = removeCopy({ root: copy, primary: main, branch, landedOn });
  } catch (error) {
    removal = { removed: false, reason: oneLine(error && error.message) };
  }
  // Only a branch whose tip is already in the main branch is deleted, so no
  // commit is lost; git refuses while a copy still has it checked out.
  const branchRemoved = state === 'dropped' && removal.removed === true && git(['branch', '-D', branch], main).ok;
  const entry = noteRun(main, branch, {
    ...base, state, why, copy_removed: removal.removed === true,
    copy_kept: removal.removed ? null : oneLine(removal.reason) || 'not removed', branch_removed: branchRemoved,
  });
  return { ...entry, state, why };
}

function defaultAutoland({ mission, cwd }) {
  const autoland = require('./member-autoland');
  const receipt = autoland.latestRunReceipt(mission.id, cwd);
  const ticks = receipt && receipt.result && Array.isArray(receipt.result.ticks) ? receipt.result.ticks : [];
  const workerEngine = ticks.map((tick) => tick && tick.engine_id).filter(Boolean).pop() || '';
  return autoland.autolandMemberRun({ mission, cwd, workerEngine });
}

function defaultRefreshTarget(main, target) {
  if (String(target).startsWith('origin/')) require('./worktree-core').refreshRemoteRef(main, target);
}

// One plain question in the feed: keep or drop. The step's own words go in
// the title when the feed takes them as plain words; otherwise a shorter title.
function defaultAsk(main, { member, step, why, branch, copy }) {
  const { emit } = require('./feed-team');
  const short = oneLine(step).replace(/^next step toward:\s*/i, '');
  const clip = short.length > 90 ? `${short.slice(0, 87).trim()}...` : short;
  const titles = [
    ...(clip ? [`${member}'s step "${clip}" did not land after two tries. Keep or drop?`] : []),
    `${member}'s latest step did not land after two tries. Keep or drop?`,
  ];
  let last = null;
  for (const title of titles) {
    try {
      const out = emit(main, {
        as: member, type: 'question', title,
        why: 'Its work is saved but is not in the project yet, and only you can keep it or drop it.',
        detail: `Held because: ${why}\nBranch: ${branch}\nCopy: ${copy || 'removed'}`,
        source: 'a team member run',
      });
      return { card_id: (out && out.card && out.card.id) || null };
    } catch (error) {
      last = error;
    }
  }
  return { error: oneLine(last && last.message).slice(0, 200) || 'the question could not be posted' };
}

const DEFAULTS = {
  autoland: defaultAutoland,
  ask: defaultAsk,
  removeCopy: defaultRemoveCopy,
  refreshTarget: defaultRefreshTarget,
  alive: pidAlive,
  max: MAX_PER_WAKE,
};

function finishRun({ main, run, target, d }) {
  const mission = missionForCopy(run.path) || { owner: run.member, id: run.mission_id, objective: run.title };
  const settle = (landing) => settleRun({ main, copy: run.path, branch: run.branch, mission, landing, target, removeCopy: d.removeCopy });
  let out = settle(null);
  if (out.state !== 'unfinished') return out;
  const tries = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt === 2) d.refreshTarget(main, target);
    let landing;
    try {
      landing = d.autoland({ mission, cwd: run.path });
    } catch (error) {
      landing = { merged: false, auto_merge: false, line: `landing failed: ${oneLine(error && error.message)}` };
    }
    tries.push(oneLine(landing && landing.line));
    out = settle(landing);
    if (out.state !== 'unfinished') return { ...out, tries: attempt };
  }
  const why = tries[tries.length - 1] || 'it did not land';
  const asked = d.ask(main, { member: mission.owner, step: mission.objective, why, branch: run.branch, copy: run.path }) || {};
  // The branch stays for the owner and holds every commit, so the copy goes
  // through the usual checks; one with unsaved work stays, with its reason.
  let removal;
  try {
    removal = d.removeCopy({ root: run.path, primary: main, branch: run.branch, landedOn: `refs/heads/${run.branch}` });
  } catch (error) {
    removal = { removed: false, reason: oneLine(error && error.message) };
  }
  const entry = noteRun(main, run.branch, {
    member: mission.owner, mission_id: mission.id || null, title: oneLine(mission.objective).slice(0, 160), path: run.path,
    state: 'owner', why, tries: 2, card_id: asked.card_id || null, card_error: asked.error || null,
    copy_removed: removal.removed === true, copy_kept: removal.removed ? null : oneLine(removal.reason) || 'not removed',
  });
  return { ...entry, state: 'owner' };
}

// Before a member starts a new step: finish its unfinished runs, oldest first,
// at most d.max per wake. blocked is true while any is left unfinished.
function finishMemberRuns({ cwd = process.cwd(), member, deps = {} } = {}) {
  const d = { ...DEFAULTS, ...deps };
  if (!deps.removeCopy) d.removeCopy = (options) => defaultRemoveCopy({ ...options, activePaths: d.activePaths });
  const { main, runs } = listMemberRuns(cwd, { alive: d.alive });
  const mine = runs.filter((run) => run.member === member && run.state === 'unfinished' && run.path)
    .sort((a, b) => String(a.started_at || a.branch).localeCompare(String(b.started_at || b.branch)));
  if (!main || !mine.length) return { blocked: false, finished: [], left: 0, line: '' };
  const target = targetRef(main);
  d.refreshTarget(main, target);
  const finished = mine.slice(0, d.max).map((run) => finishRun({ main, run, target, d }));
  const left = mine.length - finished.filter((run) => run.state !== 'unfinished').length;
  const counts = ['landed', 'dropped', 'owner'].map((state) => [state, finished.filter((run) => run.state === state).length])
    .filter(([, n]) => n).map(([state, n]) => `${n} ${state === 'owner' ? 'waiting on you' : state}`);
  const done = counts.length ? `finished earlier runs: ${counts.join(', ')}` : '';
  const line = left ? `${member} is finishing ${left} earlier ${left === 1 ? 'run' : 'runs'} before starting a new step${done ? `; ${done}` : ''}` : done;
  return { blocked: left > 0, finished, left, line };
}

// A member run in a copy is starting: note it, so the record knows it is live.
function noteRunStart(mission) {
  const copy = mission && mission.worktree && mission.worktree.path;
  const branch = mission && mission.worktree && mission.worktree.branch;
  if (!copy || !branch || !mission.owner) return null;
  const main = mainRoot(copy);
  if (!main || canonical(main) === canonical(copy)) return null;
  return noteRun(main, branch, {
    member: mission.owner, mission_id: mission.id || null, title: oneLine(mission.objective).slice(0, 160),
    path: copy, started_at: mission.created_at || null, state: 'running', pid: process.pid,
  });
}

// A member run in a copy just stopped: record it landed, dropped or unfinished.
function settleRunEnd({ mission, landing = null, activePaths, removeCopy = (options) => defaultRemoveCopy({ ...options, activePaths }) } = {}) {
  const copy = mission && mission.worktree && mission.worktree.path;
  const branch = mission && mission.worktree && mission.worktree.branch;
  if (!copy || !branch || !mission.owner) return null;
  const main = mainRoot(copy);
  if (!main || canonical(main) === canonical(copy)) return null;
  const out = settleRun({ main, copy, branch, mission, landing, target: targetRef(main), removeCopy });
  if (out.state !== 'unfinished') return out;
  return noteRun(main, branch, {
    member: out.member, mission_id: out.mission_id, title: out.title, path: copy, started_at: out.started_at,
    state: 'unfinished', why: out.why, pid: null,
  });
}

module.exports = {
  finishMemberRuns,
  listMemberRuns,
  noteRunStart,
  settleRunEnd,
};
