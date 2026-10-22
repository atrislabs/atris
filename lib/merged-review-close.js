'use strict';

// Jobs whose change is already on the main branch close themselves, every
// hour, with no person and no team loop.
//
// On 2026-10-22 four jobs in this repo sat in review for a week after their
// change merged. Two were still on the autoland list (#1318, #1319); two had
// left it, so only the code itself could say they landed. This pass reads
// git, never GitHub, and closes a review job only on one of two exact facts:
//
// One. The commit the builder recorded for the job (work_commit, different
// from the commit it started on) is on the main branch, and it came in from
// a side branch. A commit on the main line itself proves nothing: a builder
// working in the main folder records whatever the main branch was at.
//
// Two. The job has no commit of its own, and every test file its check names
// was first added to the main branch after the job was written, did not exist
// where the job started, is still there, and no other review job names it.
//
// Either way, work a later commit reverted stays open, and so does a job
// whose row changed after the scan read it.
//
// A merge more than a day old still closes the job, but records it as
// merged earlier, so last week's work never counts as this week's landing.

const { spawnSync } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;
const TEST_FILE = /^(?!\/)(?!.*\.\.)[\w.@+-]+(?:\/[\w.@+-]+)+\.(?:c|m)?[jt]s$|^(?!\/)(?!.*\.\.)[\w.@+-]+(?:\/[\w.@+-]+)+\.py$/;

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: res.status === 0, status: res.status, out: String(res.stdout || '').trim() };
}

// The branch merged work lands on: origin's default first, then the usual
// names, then a local branch for a project with no remote.
function mainBranchRef(root) {
  const head = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root);
  const candidates = [head.ok ? head.out.replace(/^refs\/remotes\//, '') : '', 'origin/master', 'origin/main', 'master', 'main'];
  for (const ref of candidates.filter(Boolean)) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root).ok) return ref;
  }
  return null;
}

function createdMs(value) {
  if (typeof value === 'number') return value;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function verifyTestFiles(verify) {
  return [...new Set(String(verify || '').replace(/[`'"]/g, ' ').split(/\s+/).filter((t) => TEST_FILE.test(t)))];
}

// One reader per pass: the main line is read once, and each answer is kept.
function createReader(root, base) {
  const line = git(['log', '--first-parent', '--format=%H %ct', base], root).out
    .split('\n').filter(Boolean).map((row) => {
      const [sha, ct] = row.split(' ');
      return { sha, at: Number(ct) * 1000 };
    }).reverse();
  const onLine = new Map(line.map((c, i) => [c.sha, i]));
  const ancestor = (sha, of) => git(['merge-base', '--is-ancestor', sha, of], root).status === 0;
  const commitExists = (sha) => SHA.test(sha) && git(['cat-file', '-e', `${sha}^{commit}`], root).ok;

  // The main-line commit that brought `sha` in, and whether `sha` is itself
  // on the main line. The main line is ordered, so a binary search holds.
  function landing(sha) {
    if (!commitExists(sha) || !line.length || !ancestor(sha, line[line.length - 1].sha)) return null;
    if (onLine.has(sha)) return { sha, at: line[onLine.get(sha)].at, mainLine: true };
    let lo = 0;
    let hi = line.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ancestor(sha, line[mid].sha)) hi = mid;
      else lo = mid + 1;
    }
    return { sha: line[lo].sha, at: line[lo].at, mainLine: false };
  }

  function firstAdded(file) {
    const rows = git(['log', base, '--diff-filter=A', '--format=%H', '--', file], root).out.split('\n').filter(Boolean);
    return rows.length ? rows[rows.length - 1] : null;
  }

  const existsAt = (sha, file) => git(['cat-file', '-e', `${sha}:${file}`], root).ok;
  const commitTime = (sha) => Number(git(['log', '-1', '--format=%ct', sha], root).out) * 1000;
  // Taken back out: git's own revert message names the commit it reverts.
  const reverted = (...shas) => shas.filter(Boolean).some((sha) => git(['log', base, '--format=%H', '-F',
    `--grep=This reverts commit ${sha}`], root).out.length > 0);
  const onBase = (file) => existsAt(base, file);
  return { landing, firstAdded, existsAt, commitExists, commitTime, reverted, onBase };
}

// Commit times are whole seconds, so compare at that grain.
const notBefore = (ms, created) => ms >= Math.floor(created / 1000) * 1000;

// Why this review job's change is on the main branch, or null. `shared`
// holds test files named by more than one review job: a new file two jobs
// both point at says nothing about which one landed it.
function mergedProof(task, reader, shared = new Set()) {
  const metadata = (task && task.metadata) || {};
  const work = String(metadata.work_commit || '').trim();
  const start = String(metadata.start_commit || '').trim();
  const created = createdMs(task.created_at);
  if (SHA.test(work) && work !== start) {
    // The job has code of its own: only that code can say it landed. A test
    // file someone else merged does not close a redo that never merged.
    const landed = reader.landing(work);
    if (!landed || landed.mainLine) return null;
    // A commit older than the job is not the job's work.
    if (created && !notBefore(reader.commitTime(work), created)) return null;
    if (reader.reverted(work, landed.sha)) return null;
    return { how: 'work_commit', commit: work, landed_sha: landed.sha, landed_at: landed.at };
  }
  // A check run from another folder names paths relative to that folder.
  if (/(^|[\s;&|(])cd\s/.test(String(metadata.verify || ''))) return null;
  const files = verifyTestFiles(metadata.verify);
  if (!files.length || !created || files.some((file) => shared.has(file))) return null;
  let latest = null;
  for (const file of files) {
    const added = reader.firstAdded(file);
    if (!added || !reader.onBase(file)) return null;
    if (SHA.test(start) && reader.commitExists(start) && reader.existsAt(start, file)) return null;
    const landed = reader.landing(added);
    if (!landed) return null;
    // Added before the job existed: the test belongs to earlier work.
    if (!notBefore(reader.commitTime(added), created)) return null;
    if (reader.reverted(added, landed.sha)) return null;
    if (!latest || landed.at > latest.landed_at) latest = { commit: added, landed_sha: landed.sha, landed_at: landed.at, file };
  }
  return latest ? { how: 'verify_test', files, ...latest } : null;
}

function heldForPerson(row) {
  if (!row || typeof row !== 'object') return true;
  return Boolean(require('./member-task-pick').heldForPerson(row));
}

// The row must still be the one the scan read: new proof since then (a newer
// updated_at) means newer work the old read knows nothing about.
function defaultClose(id, { action, proof, updatedAt }) {
  const taskDb = require('./task-db');
  const db = taskDb.open();
  const row = taskDb.getTask(db, id);
  if (!row || row.status !== 'review' || heldForPerson(row)) return { updated: false };
  if (updatedAt != null && Number(row.updated_at) !== Number(updatedAt)) return { updated: false };
  return taskDb.doneTask(db, { id, actor: 'autoland', allowReview: true, autoAccepted: true, action, proof });
}

function proofLine(found) {
  const short = (sha) => String(sha || '').slice(0, 10);
  const when = new Date(found.landed_at).toISOString().slice(0, 16).replace('T', ' ');
  return found.how === 'work_commit'
    ? `its own commit ${short(found.commit)} is on the main branch, merged ${when} UTC (${short(found.landed_sha)})`
    : `its check ${found.files.join(', ')} was added to the main branch after the job was written, merged ${when} UTC (${short(found.landed_sha)})`;
}

// Close every review job in `tasks` whose change is on the main branch.
// dryRun reports what would close and writes nothing.
function closeMergedReviewJobs({ root, tasks = [], now = Date.now(), dryRun = false, close = defaultClose } = {}) {
  const base = mainBranchRef(root);
  if (!base) return { base: null, checked: 0, matched: [], closed: [] };
  const reader = createReader(root, base);
  const candidates = tasks.filter((t) => t && t.status === 'review' && !heldForPerson(t)
    && String((t.review && t.review.approval_status) || (t.metadata && t.metadata.approval_status) || 'pending') === 'pending');
  const named = new Map();
  for (const task of tasks.filter((t) => t && t.status === 'review')) {
    for (const file of verifyTestFiles(task.metadata && task.metadata.verify)) named.set(file, (named.get(file) || 0) + 1);
  }
  const shared = new Set([...named].filter(([, n]) => n > 1).map(([file]) => file));
  const matched = [];
  const closed = [];
  for (const task of candidates) {
    let found = null;
    try {
      found = mergedProof(task, reader, shared);
    } catch {
      found = null;
    }
    if (!found) continue;
    const fresh = now - found.landed_at <= DAY_MS;
    const action = fresh ? 'merged' : 'merged_earlier';
    const proof = fresh ? `merged: ${proofLine(found)}` : `merged earlier, closed without counting it as a new landing: ${proofLine(found)}`;
    const row = { id: task.id, ref: task.display_id || task.id, title: task.title, how: found.how, action, landed_at: new Date(found.landed_at).toISOString(), proof };
    matched.push(row);
    if (dryRun) continue;
    let out = null;
    try {
      out = close(task.id, { action, proof, updatedAt: task.updated_at });
    } catch {
      out = null;
    }
    if (out && out.updated) closed.push(row);
  }
  return { base, checked: candidates.length, matched, closed };
}

module.exports = {
  closeMergedReviewJobs,
};
