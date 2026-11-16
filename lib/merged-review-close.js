'use strict';

// Jobs whose change is already on the main branch close themselves, every
// hour, with no person and no team loop.
//
// On 2026-10-22 four jobs in this repo sat in review for a week after their
// change merged. Two were still on the autoland list (#1318, #1319); two had
// left it, so only the code itself could say they landed. This pass reads
// git first, then GitHub, and closes a review job only on one of three exact
// facts:
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
// Three, from GitHub, is below at recordedPullRequestOf.
//
// For one and two, work a later commit reverted stays open. For all three, a
// job whose row changed after the scan read it stays open.
//
// A merge more than a day old still closes the job, but records it as
// merged earlier, so last week's work never counts as this week's landing.

const { spawnSync } = require('child_process');
const { pullRequestOfLink } = require('./pull-request-link');

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

// Three. The job names one pull request, and GitHub says that exact pull
// request merged. git alone cannot see this: on 2026-11-15, 23 backend jobs
// sat in review after their pull requests merged, because the pull request
// was squashed (no side branch to find) or lived in another repository. The
// pull request is the one on the row (metadata.pull_request), or else the one
// link the job's latest proof names. Two links, or a link another review job
// also names, say nothing about which job it was, so nothing closes. The
// merge must be into that repository's default branch, after the job was
// written, and no other job may already have landed with it.
//
// A link in a proof is only a lead. GitHub's answer must tie the pull request
// to this one job before anything is written: its head branch, in the pull
// request's own repository (not a fork), carries this job's id, or is named
// from this job's title the way builders name the branch they open it from.
// A proof that only mentions a pull request it waits on, or links a comment
// on one, ties nothing. A row that records its pull request on itself
// (metadata.pull_request) is a held job: it is settled only on the held
// sweep's own proofs, never on weaker ones here.
//
// A pull request closed without merging never counts as done. The job goes
// back on the list with the reason, the same rule the held-job sweep follows
// (lib/held-pull-requests.js): its proof no longer stands, so it is redone or
// a person marks it not needed. The same tie is required first.

// A link that names a pull request itself: /pull/<n>, or one of its own
// tabs. A fragment (#issuecomment-...) points at a conversation on it.
const OWN_PULL_REQUEST_LINK = /\/pull\/\d+(?:\/(?:files|commits|checks))?\/?$/i;

// The pull request the job points at, as { url, repo, number, repoLink, held }, or null.
function recordedPullRequestOf(task) {
  const metadata = (task && task.metadata) || {};
  const own = metadata.pull_request && typeof metadata.pull_request === 'object' ? metadata.pull_request : null;
  if (own) {
    const named = pullRequestOfLink(own.url);
    return named ? { url: String(own.url).trim(), ...named, held: true } : null;
  }
  const links = String(metadata.latest_agent_proof || '').match(/https?:\/\/\S+\/pull\/\d+\S*/g) || [];
  const found = new Map();
  for (const raw of links) {
    const link = raw.replace(/[).,;:'"`\]]+$/, '');
    const named = pullRequestOfLink(link);
    if (!named) continue;
    // A comment link still names the pull request, so two jobs naming it,
    // or a proof naming two, stay ambiguous; it just ties nothing on its own.
    const key = `${named.repo}#${named.number}`;
    const prior = found.get(key);
    const bare = OWN_PULL_REQUEST_LINK.test(link);
    if (!prior || (bare && !prior.bare)) found.set(key, { url: link, ...named, held: false, bare });
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

// A job title, or a branch name, as the words builders put in branch names.
const slugOf = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// The branch's last part, less the day, time and random tail a builder adds.
const BRANCH_TAIL = /-\d{8}(?:-\d{4,6})?(?:-[0-9a-f]{4})?(?:-[a-z0-9]{1,2})?$/;
const MIN_SLUG = 16;

// Whether GitHub's answer ties the pull request to this job, from a proof link.
function namedForJob(task, answer) {
  if (!answer.repo || !answer.head_repo || answer.head_repo !== answer.repo) return false;
  const held = require('./held-pull-requests');
  if (held.branchNamesJob(answer.head_ref, task.id)) return true;
  if (held.jobIdsIn(answer.head_ref).length) return false;
  const last = String(answer.head_ref || '').split('/').pop();
  const branch = slugOf(last.replace(BRANCH_TAIL, ''));
  const title = slugOf(task.title);
  const who = slugOf(task.claimed_by);
  const forms = [branch, who && branch.startsWith(`${who}-`) ? branch.slice(who.length + 1) : null].filter(Boolean);
  return forms.some((b) => Math.min(b.length, title.length) >= MIN_SLUG
    && (title.startsWith(b) || (b.startsWith(title) && b[title.length] === '-')));
}

// Why GitHub's answer is not this job's own pull request, or null when it is.
function notOwnReason(task, pr, answer, root, originOf) {
  const held = require('./held-pull-requests');
  if (pr.held) {
    const notBuild = held.notBuildReason(task, answer, originOf(task.workspace_root || root));
    if (notBuild) return notBuild;
    return answer.state === 'merged' ? held.mergeBeforeClaimReason(task, answer) : null;
  }
  if (!pr.bare) return 'the proof links a comment on it, not the pull request';
  return namedForJob(task, answer) ? null : 'GitHub does not tie its branch to this job';
}

const prKey = (pr) => `${pr.repo}#${pr.number}`;

function defaultTaken(pr, id) {
  const taskDb = require('./task-db');
  return taskDb.pullRequestTakenBy(taskDb.open(), { repo: pr.repo, number: pr.number, exceptId: id });
}

// The row must still be the one the scan read. The merge is written onto the
// row, so no later job can land with the same pull request.
function defaultClosePullRequest(id, { action, proof, updatedAt, merge }) {
  const taskDb = require('./task-db');
  const db = taskDb.open();
  const row = taskDb.getTask(db, id);
  if (!row || row.status !== 'review' || heldForPerson(row)) return { updated: false };
  if (updatedAt != null && Number(row.updated_at) !== Number(updatedAt)) return { updated: false };
  const out = taskDb.doneTask(db, { id, actor: 'autoland', allowReview: true, autoAccepted: true, action, proof });
  if (out && out.updated) {
    taskDb.updateTaskMetadata(db, id, (metadata) => ({ ...metadata, pull_request: { ...(metadata.pull_request || {}), ...merge } }), { touch: false });
  }
  return out;
}

function defaultSendBackClosed(id, { reason, updatedAt }) {
  const taskDb = require('./task-db');
  const db = taskDb.open();
  const row = taskDb.getTask(db, id);
  if (!row || row.status !== 'review' || heldForPerson(row)) return { reopened: false };
  if (updatedAt != null && Number(row.updated_at) !== Number(updatedAt)) return { reopened: false };
  return taskDb.reopenTask(db, { id, actor: 'autoland', fromReview: true, reason });
}

// Ask GitHub about each candidate's pull request and close or send back.
// GitHub down or gh missing stops the asking; nothing more is written.
function settleByPullRequest(candidates, allReview, { root, now, dryRun, ask, askBranch, askOrigin, taken, close, sendBack, rememberAsked, limit }) {
  const named = new Map();
  for (const task of allReview) {
    const pr = recordedPullRequestOf(task);
    if (pr) named.set(prKey(pr), (named.get(prKey(pr)) || 0) + 1);
  }
  const out = { asked: 0, waiting: 0, matched: [], closed: [], would_send_back: [], sent_back: [], not_own: [], outage: null };
  const branches = new Map();
  const origins = new Map();
  const originOf = (folder) => {
    if (!origins.has(folder)) origins.set(folder, askOrigin(folder));
    return origins.get(folder);
  };
  for (const task of candidates) {
    const pr = recordedPullRequestOf(task);
    if (!pr || named.get(prKey(pr)) > 1) continue;
    if (out.outage) continue;
    if (out.asked >= limit) { out.waiting += 1; continue; }
    out.asked += 1;
    const asked = ask(pr.url);
    if (asked.outage) { out.outage = asked.outage.detail || 'github could not be reached'; continue; }
    // The place is kept: the next pass asks first about jobs not asked lately.
    if (!dryRun) { try { rememberAsked(task.id, now); } catch { /* the order only */ } }
    const answer = asked.answer;
    if (!answer || answer.repo !== pr.repo || answer.number !== pr.number) continue;
    const ref = task.display_id || task.id;
    if (answer.state === 'closed' || answer.state === 'merged') {
      const why = notOwnReason(task, pr, answer, root, originOf);
      if (why) { out.not_own.push({ id: task.id, ref, number: pr.number, url: pr.url, state: answer.state, why }); continue; }
    }
    if (answer.state === 'closed') {
      const reason = `pull request closed without landing: ${pr.url}`;
      const row = { id: task.id, ref, title: task.title, how: 'pull_request', number: pr.number, url: pr.url, reason };
      if (dryRun) { out.would_send_back.push(row); continue; }
      let sent = null;
      try { sent = sendBack(task.id, { reason, updatedAt: task.updated_at }); } catch { sent = null; }
      if (sent && sent.reopened) out.sent_back.push(row);
      continue;
    }
    if (answer.state !== 'merged' || !answer.merge_commit || !answer.merged_at) continue;
    const mergedAt = Date.parse(answer.merged_at);
    const created = createdMs(task.created_at);
    if (!Number.isFinite(mergedAt) || !created || mergedAt < created) continue;
    if (!branches.has(pr.repo)) {
      const b = askBranch(pr.repoLink);
      if (b.outage) { out.outage = b.outage.detail || 'github could not be reached'; continue; }
      branches.set(pr.repo, b.branch || null);
    }
    if (!answer.base_ref || answer.base_ref !== branches.get(pr.repo)) continue;
    let other = null;
    try { other = taken(pr, task.id); } catch { other = { id: null, how: 'unreadable' }; }
    if (other) continue;
    const fresh = now - mergedAt <= DAY_MS;
    const action = fresh ? 'merged' : 'merged_earlier';
    const when = new Date(mergedAt).toISOString().slice(0, 16).replace('T', ' ');
    const line = `its pull request ${pr.url} merged into ${answer.base_ref} ${when} UTC (${String(answer.merge_commit).slice(0, 10)}), as GitHub says`;
    const proof = fresh ? `merged: ${line}` : `merged earlier, closed without counting it as a new landing: ${line}`;
    const row = { id: task.id, ref, title: task.title, how: 'pull_request', number: pr.number, url: pr.url, action, landed_at: new Date(mergedAt).toISOString(), proof };
    out.matched.push(row);
    if (dryRun) continue;
    const merge = { state: 'merged', url: pr.url, number: pr.number, merge_commit: answer.merge_commit, merged_at: answer.merged_at };
    let done = null;
    try { done = close(task.id, { action, proof, updatedAt: task.updated_at, merge }); } catch { done = null; }
    if (done && done.updated) out.closed.push(row);
  }
  return out;
}

// GitHub asks per pass. Each is about a second; an hour has room. Jobs never
// asked come first, then the ones asked longest ago, so a long list of open
// pull requests cannot keep a merged one behind it from ever being asked.
const MAX_PULL_REQUEST_ASKS = 60;

const askedAtMs = (task) => {
  const at = Date.parse(String((task && task.metadata && task.metadata.pull_request_asked_at) || ''));
  return Number.isFinite(at) ? at : -Infinity;
};

// Not a touch: updated_at is the job's own news, and the scan's guard.
function defaultRememberAsked(id, at) {
  const taskDb = require('./task-db');
  taskDb.updateTaskMetadata(taskDb.open(), id, (metadata) => {
    metadata.pull_request_asked_at = new Date(at).toISOString();
  }, { touch: false });
}

// Close every review job in `tasks` whose change is on the main branch.
// dryRun reports what would close and writes nothing.
function closeMergedReviewJobs({
  root, tasks = [], now = Date.now(), dryRun = false, close = defaultClose,
  ask = (url) => require('./held-pull-requests').askGitHub(url),
  askBranch = (link) => require('./held-pull-requests').askDefaultBranch(link),
  askOrigin = (folder) => require('./held-pull-requests').originRepoOf(folder),
  taken = defaultTaken, closePullRequest = defaultClosePullRequest, sendBack = defaultSendBackClosed,
  rememberAsked = defaultRememberAsked, pullRequestLimit = MAX_PULL_REQUEST_ASKS,
} = {}) {
  const candidates = tasks.filter((t) => t && t.status === 'review' && !heldForPerson(t)
    && String((t.review && t.review.approval_status) || (t.metadata && t.metadata.approval_status) || 'pending') === 'pending');
  const allReview = tasks.filter((t) => t && t.status === 'review');
  const base = mainBranchRef(root);
  const viaGit = base ? closeByGit({ root, base, tasks, candidates, now, dryRun, close }) : { matched: [], closed: [] };
  const left = candidates.filter((t) => !viaGit.matched.some((m) => m.id === t.id))
    .sort((a, b) => (askedAtMs(a) - askedAtMs(b)) || ((createdMs(a.created_at) || 0) - (createdMs(b.created_at) || 0)));
  const viaPr = settleByPullRequest(left, allReview, {
    root, now, dryRun, ask, askBranch, askOrigin, taken, close: closePullRequest, sendBack, rememberAsked, limit: pullRequestLimit,
  });
  return {
    base,
    checked: candidates.length,
    matched: [...viaGit.matched, ...viaPr.matched],
    closed: [...viaGit.closed, ...viaPr.closed],
    sent_back: viaPr.sent_back,
    would_send_back: viaPr.would_send_back,
    pull_requests_asked: viaPr.asked,
    pull_requests_waiting: viaPr.waiting,
    ...(viaPr.not_own.length ? { not_own_pull_requests: viaPr.not_own } : {}),
    ...(viaPr.outage ? { github_outage: viaPr.outage } : {}),
  };
}

function closeByGit({ root, base, tasks, candidates, now, dryRun, close }) {
  const reader = createReader(root, base);
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
  return { matched, closed };
}

module.exports = {
  closeMergedReviewJobs,
  mainBranchRef,
};
