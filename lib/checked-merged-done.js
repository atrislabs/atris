'use strict';

// Checked work that is already on the main branch counts as done, every
// hour, when it sits in a quiet lane.
//
// On 2026-11-16 five atrisos-web jobs (WEB-659, WEB-657, WEB-660, WEB-651,
// WEB-635) sat in review although each had passed the builder's check and
// the second check, and each was already merged into master. The hourly pass
// took 656 seconds and marked none of them done: the accept step re-ran
// every check and ran out of time, and the merged-work close
// (lib/merged-review-close.js) could not see them, because each was squash
// merged straight onto the main line and named its commit only in its proof
// ("Merged as commit 9b7cb4d5c (PR 1000)").
//
// This pass closes a review job only when all of these hold:
//
// One. It passed both checks: certified, with at least two review passes,
// and no check recorded as failing since.
//
// Two. Every commit its proof or row names is on the main branch, at least
// one of them is new since the job started, that new commit names the job
// or touches the files the job names, no other review job names it, and no
// later commit reverted it.
//
// Three. It is in a quiet lane. Sign-in, money, security, release, deploy,
// customer and decision work is protected, read from the tags, the title,
// and the changed files and lines of the merged commits. A diff that cannot
// be read counts as protected.
//
// Protected jobs that pass one and two stay in review and go on one morning
// list for the owner. Everything else is left exactly as it was, with a
// reason.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHA_FULL = /^[0-9a-f]{40,64}$/;
const SHORT_SHA = /^[0-9a-f]{7,64}$/;
// "commit 9b7cb4d5c", "Merged as 9b7cb4d5c", "merge commit: 9b7cb4d", "sha 9b7c...".
const COMMIT_IN_TEXT = /\b(?:commit|merged as|landed as|sha)\s*[:#]?\s*`?([0-9a-f]{7,64})\b/gi;
const JOB_PATH = /^[\w.@+-]+(?:\/[\w.@+-]+)+$/;
const MIN_PASSES = 2;
const UNDO_REASON = 'not done after all';

// Release work: the words people use, and the files a release touches.
const RELEASE_WORDS = /\b(releases?|released|releasing|publish(?:es|ed|ing)?|version bump|changelog)\b/;
const RELEASE_PATHS = /(?:^|\/)(?:releases?|changelog(?:\.md)?|scripts\/(?:publish|release)[\w.-]*)(?:[/_.-]|$)/i;

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: res.status === 0 && !res.error, status: res.status, out: String(res.stdout || '').trim() };
}

function refOf(task) {
  return String((task && (task.display_id || task.legacy_ref || task.id)) || '');
}

function metadataOf(task) {
  return task && task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata) ? task.metadata : {};
}

function proofTexts(task) {
  const metadata = metadataOf(task);
  const review = (task && task.review) || {};
  return [metadata.latest_agent_proof, review.proof].map((v) => String(v || '')).filter(Boolean);
}

// The commits a job names: its own recorded commit, its pull request's merge
// commit, and every "commit <sha>" its proof writes.
function namedCommits(task) {
  const metadata = metadataOf(task);
  const out = new Set();
  const work = String(metadata.work_commit || '').trim().toLowerCase();
  const start = String(metadata.start_commit || '').trim().toLowerCase();
  if (SHORT_SHA.test(work) && work !== start) out.add(work);
  const pr = metadata.pull_request && typeof metadata.pull_request === 'object' ? metadata.pull_request : null;
  const merge = String((pr && pr.merge_commit) || '').trim().toLowerCase();
  if (SHORT_SHA.test(merge)) out.add(merge);
  for (const text of proofTexts(task)) {
    for (const match of text.matchAll(COMMIT_IN_TEXT)) out.add(match[1].toLowerCase());
  }
  return [...out];
}

// Paths the job names: its check, its declared files, and any path its proof
// writes. Directory filters such as app/dashboard/orb count.
function jobPaths(task) {
  const metadata = metadataOf(task);
  const raw = [metadata.verify, metadata.latest_agent_verify, ...proofTexts(task)];
  for (const key of ['files', 'changed_files', 'declared_files']) {
    const value = metadata[key];
    if (Array.isArray(value)) raw.push(value.join(' '));
    else if (typeof value === 'string') raw.push(value);
  }
  const paths = new Set();
  for (const text of raw) {
    for (const token of String(text || '').replace(/[`'"(),;]/g, ' ').split(/\s+/)) {
      const clean = token.replace(/[.:]+$/, '');
      if (JOB_PATH.test(clean) && !clean.includes('..') && !/^https?:/.test(clean)) paths.add(clean);
    }
  }
  return [...paths];
}

function pathsOverlap(changed, named) {
  return changed.some((file) => named.some((p) => file === p || file.startsWith(`${p}/`) || file.endsWith(`/${p}`)));
}

function passCount(task) {
  const metadata = metadataOf(task);
  const review = (task && task.review) || {};
  return Math.max(Number(metadata.agent_review_pass_count) || 0, Number(review.agent_review_pass_count) || 0);
}

// Both checks passed: certified, two passes, nothing failing since.
function bothChecksPassed(task) {
  const metadata = metadataOf(task);
  const review = (task && task.review) || {};
  const certified = metadata.agent_certified === true || review.agent_certified === true;
  if (!certified) return { ok: false, reason: 'not_certified' };
  if (passCount(task) < MIN_PASSES) return { ok: false, reason: 'one_check_only' };
  const cache = metadata.verify_cache;
  if (cache && typeof cache === 'object' && cache.ok === false) return { ok: false, reason: 'check_failed_since' };
  return { ok: true };
}

function pendingReview(task) {
  if (!task || task.status !== 'review') return false;
  const metadata = metadataOf(task);
  const review = task.review || {};
  const approval = String(review.approval_status || metadata.approval_status || 'pending').toLowerCase();
  return approval === 'pending' && !metadata.auto_accepted_at;
}

// One reader per pass, against the main branch.
function createReader(root, base) {
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const resolve = (sha) => memo(`r:${sha}`, () => {
    const res = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], root);
    return res.ok && SHA_FULL.test(res.out) ? res.out : null;
  });
  const ancestor = (sha, of) => memo(`a:${sha}:${of}`, () => git(['merge-base', '--is-ancestor', sha, of], root).status === 0);
  const onBase = (sha) => ancestor(sha, base);
  const message = (sha) => memo(`m:${sha}`, () => git(['log', '-1', '--format=%B', sha], root).out);
  const commitTime = (sha) => memo(`t:${sha}`, () => Number(git(['log', '-1', '--format=%ct', sha], root).out) * 1000);
  const reverted = (sha) => memo(`v:${sha}`, () => git(['log', base, '--format=%H', '-F', `--grep=This reverts commit ${sha}`], root).out.length > 0);
  // The change a commit brought in: for a merge, against its first parent.
  const diff = (sha) => memo(`d:${sha}`, () => {
    const parents = git(['rev-list', '--parents', '-n', '1', sha], root);
    if (!parents.ok) return null;
    const list = parents.out.split(/\s+/).filter(Boolean);
    const res = list.length > 2
      ? git(['diff', '--no-color', '--no-ext-diff', `${sha}^1`, sha], root)
      : git(['show', '--no-color', '--no-ext-diff', '--format=', sha], root);
    return res.ok ? res.out : null;
  });
  return { resolve, ancestor, onBase, message, commitTime, reverted, diff };
}

function changedFilesOf(diffText) {
  const files = new Set();
  for (const line of String(diffText || '').split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) { files.add(header[1]); files.add(header[2]); }
  }
  return [...files];
}

function createdMs(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

const mentionsRef = (text, ref) => Boolean(ref) && new RegExp(`(^|[^A-Za-z0-9-])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(String(text || ''));

// Why the job's change is on the main branch, or a reason it cannot say.
function mergedProof(task, reader, sharedCommits = new Set()) {
  const metadata = metadataOf(task);
  const named = namedCommits(task);
  if (!named.length) return { ok: false, reason: 'no_commit_named' };
  const resolved = [];
  for (const sha of named) {
    const full = reader.resolve(sha);
    // A commit this repository does not know may live elsewhere: unsure.
    if (!full) return { ok: false, reason: 'named_commit_unknown', commit: sha };
    if (!resolved.includes(full)) resolved.push(full);
  }
  const notMerged = resolved.find((sha) => !reader.onBase(sha));
  if (notMerged) return { ok: false, reason: 'not_merged', commit: notMerged };
  const startRaw = String(metadata.start_commit || '').trim();
  const start = SHORT_SHA.test(startRaw) ? reader.resolve(startRaw) : null;
  const created = createdMs(task.created_at);
  // New work: past the commit the job started on, or made after the job was
  // written. A builder that claims a job after its change merged records the
  // start at the merged code (WEB-660, 2026-11-11), so either fact counts.
  const fresh = resolved.filter((sha) => {
    if (start && sha !== start && !reader.ancestor(sha, start)) return true;
    return created ? reader.commitTime(sha) >= Math.floor(created / 1000) * 1000 : false;
  });
  if (!fresh.length) return { ok: false, reason: 'no_new_commit' };
  const ref = refOf(task);
  const paths = jobPaths(task);
  const tied = fresh.filter((sha) => {
    if (sharedCommits.has(sha) || reader.reverted(sha)) return false;
    if (mentionsRef(reader.message(sha), ref)) return true;
    const text = reader.diff(sha);
    return text != null && paths.length > 0 && pathsOverlap(changedFilesOf(text), paths);
  });
  if (!tied.length) return { ok: false, reason: 'commit_not_tied_to_job' };
  return { ok: true, commits: resolved, fresh, tied };
}

function laneFromWords(text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack.trim()) return null;
  const { PR_LANE_WORDS } = require('./pr-sweep');
  for (const [lane, pattern] of PR_LANE_WORDS) {
    const hit = haystack.match(pattern);
    if (hit) return { lane, why: `its text says "${hit[0]}"` };
  }
  const release = haystack.match(RELEASE_WORDS);
  if (release) return { lane: 'release', why: `its text says "${release[0]}"` };
  return null;
}

function tagWords(task) {
  const metadata = metadataOf(task);
  const list = [task.tag, task.lane, metadata.lane, ...(Array.isArray(task.tags) ? task.tags : []), ...(Array.isArray(metadata.tags) ? metadata.tags : [])];
  return list.map((t) => String(t || '').trim().toLowerCase().replace(/[-_]+/g, ' ')).filter(Boolean);
}

// The protected lane a checked, merged job sits in, or null for a quiet one.
// Reuses every lane reader the codebase already has, then adds sign-in and
// release, which the older lists do not name.
function protectedLaneOfJob(task, diffs = []) {
  const { protectedLaneOf } = require('./protected-lane');
  const lane = protectedLaneOf(task);
  if (lane) return { lane, why: `it sits in the ${lane} lane` };
  let held = '';
  try {
    held = require('./member-task-pick').heldForPerson(task);
  } catch {
    held = 'unreadable';
  }
  if (held) return { lane: held === 'needs_human' ? 'decision' : held, why: 'it is held for a person' };
  for (const tag of tagWords(task)) {
    const hit = laneFromWords(tag);
    if (hit) return { lane: hit.lane, why: `it is tagged ${tag}` };
  }
  const metadata = metadataOf(task);
  const words = laneFromWords([task.title, task.objective || metadata.objective].join('\n'));
  if (words) return words;
  const { PR_PATH_WORDS } = require('./pr-sweep');
  const { matchProtectedMissionDiff } = require('./mission-protected-lane');
  for (const diff of diffs) {
    if (diff == null) return { lane: 'unknown', why: 'its changed files could not be read' };
    for (const file of changedFilesOf(diff)) {
      for (const [name, pattern] of PR_PATH_WORDS) {
        if (pattern.test(file)) return { lane: name, why: `it changes ${file}` };
      }
      if (RELEASE_PATHS.test(file)) return { lane: 'release', why: `it changes ${file}` };
    }
    const verdict = matchProtectedMissionDiff(diff, { tags: tagWords(task) });
    if (verdict.protected) {
      const match = verdict.matches[0];
      return { lane: match.surface, why: match.signal === 'path' ? `it changes ${match.detail}` : `it changes ${match.surface} code` };
    }
  }
  return null;
}

function undoCommand(ref) {
  return `atris task reopen ${ref} --reason "${UNDO_REASON}"`;
}

function shortSha(sha) {
  return String(sha || '').slice(0, 10);
}

function writeUndoReceipt(root, row) {
  const dir = path.join(root, 'atris', 'runs', 'auto-done');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = String(row.at).replace(/[:.]/g, '-');
  const safeRef = String(row.ref).replace(/[^A-Za-z0-9_-]/g, '_');
  const file = path.join(dir, `${safeRef}-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    ref: row.ref,
    task_id: row.id,
    title: row.title,
    at: row.at,
    by: 'autoland',
    what: 'marked done: passed both checks, already on the main branch, quiet lane',
    commits: row.commits,
    base: row.base,
    undo: row.undo,
  }, null, 2)}\n`, 'utf8');
  return path.relative(root, file);
}

// The write. The row must still be the one the scan read; the accept is the
// same one autoland's landing step uses, as the autoland actor.
function defaultMarkDone(task, { proof, landing, receiptPath, undo }) {
  const taskDb = require('./task-db');
  const db = taskDb.open();
  const row = taskDb.getTask(db, task.id);
  if (!row || row.status !== 'review') return { updated: false, reason: 'not_in_review' };
  if (task.updated_at != null && Number(row.updated_at) !== Number(task.updated_at)) return { updated: false, reason: 'changed_since_read' };
  const metadata = metadataOf(row);
  const accepted = require('../commands/task').acceptReviewTask(taskDb, db, task.id, {
    actor: 'autoland',
    proof,
    // The default reward every accept carries (lib/task-core.js parseAcceptReward).
    reward: 1,
    lesson: String(metadata.latest_agent_lesson || ''),
    nextTask: String(metadata.latest_agent_next_task || ''),
    autoAccepted: true,
  });
  if (!accepted.ok) return { updated: false, reason: accepted.reason || 'accept_failed' };
  try {
    require('./task-core').refreshCareerXpAfterReview(accepted.reviewed);
  } catch {
    // The XP view catches up on its next rebuild.
  }
  const at = new Date().toISOString();
  taskDb.updateTaskMetadata(db, task.id, (m) => {
    m.auto_accepted_at = at;
    m.auto_accepted_by = 'autoland';
    m.auto_accept_policy = 'checked_and_merged';
    m.landing = { ...landing, checked_at: at };
    m.auto_done = { at, receipt: receiptPath, undo };
  }, { touch: false });
  return { updated: true };
}

// Every review job in `tasks` that passed both checks and is merged: quiet
// ones are marked done, protected ones are listed for the owner.
function closeCheckedMergedJobs({ root, tasks = [], base = null, dryRun = false, markDone = defaultMarkDone, now = Date.now() } = {}) {
  const out = { base: null, checked: 0, done: [], would_done: [], protected: [], skipped: [] };
  const mainRef = base || require('./merged-review-close').mainBranchRef(root);
  out.base = mainRef;
  if (!mainRef) return { ...out, error: 'no_main_branch' };
  const reader = createReader(root, mainRef);
  const review = tasks.filter((t) => t && t.status === 'review');
  // A commit two review jobs both name says nothing about which one it was.
  const counts = new Map();
  for (const task of review) {
    for (const sha of namedCommits(task)) {
      const full = reader.resolve(sha);
      if (full) counts.set(full, (counts.get(full) || 0) + 1);
    }
  }
  const shared = new Set([...counts].filter(([, n]) => n > 1).map(([sha]) => sha));
  for (const task of review.filter(pendingReview)) {
    const ref = refOf(task);
    const checks = bothChecksPassed(task);
    if (!checks.ok) continue;
    out.checked += 1;
    let merged;
    try {
      merged = mergedProof(task, reader, shared);
    } catch (err) {
      merged = { ok: false, reason: 'git_unreadable' };
    }
    let lane;
    try {
      lane = protectedLaneOfJob(task, merged.ok ? merged.fresh.map((sha) => reader.diff(sha)) : []);
    } catch {
      lane = { lane: 'unknown', why: 'its lane could not be read' };
    }
    const row = {
      id: task.id,
      ref,
      title: String(task.title || '').slice(0, 160),
      commits: merged.ok ? merged.commits : [],
      base: mainRef,
    };
    // Protected work that passed both checks waits for the owner's one tap,
    // merged or not; the list says which.
    if (lane) {
      out.protected.push({ ...row, lane: lane.lane, why: lane.why, merged: merged.ok, accept: `atris task accept ${ref}` });
      continue;
    }
    if (!merged.ok) {
      out.skipped.push({ id: task.id, ref, reason: merged.reason });
      continue;
    }
    row.undo = undoCommand(ref);
    if (dryRun) {
      out.would_done.push(row);
      continue;
    }
    row.at = new Date(now).toISOString();
    const commitsLine = merged.tied.map(shortSha).join(', ');
    const proof = `checked twice and already on ${mainRef} (${commitsLine}); a quiet lane, so autoland marked it done. undo: ${row.undo}`;
    let receiptPath = null;
    try {
      receiptPath = writeUndoReceipt(root, row);
    } catch {
      receiptPath = null;
    }
    const landing = { status: 'landed', reason: 'checked_and_merged', base: mainRef, commits: merged.tied };
    let result;
    try {
      result = markDone(task, { proof, landing, receiptPath, undo: row.undo });
    } catch (err) {
      result = { updated: false, reason: String((err && err.message) || err).slice(0, 120) };
    }
    if (result && result.updated) {
      out.done.push({ ...row, receipt: receiptPath });
    } else {
      if (receiptPath) { try { fs.rmSync(path.join(root, receiptPath), { force: true }); } catch {} }
      out.skipped.push({ id: task.id, ref, reason: (result && result.reason) || 'not_written' });
    }
  }
  return out;
}

module.exports = {
  bothChecksPassed,
  closeCheckedMergedJobs,
  createReader,
  jobPaths,
  mergedProof,
  namedCommits,
  protectedLaneOfJob,
  undoCommand,
};
