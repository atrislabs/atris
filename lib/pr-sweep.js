'use strict';

// The landing contract for pull requests: every open pull request is merged,
// caught up, closed, handed to its owner, or left alone on purpose, each with
// a reason. `atris land --prs` prints the sort (a dry run); `--apply` carries
// it out. Branches are never deleted, a closed pull request can be reopened.

const { spawnSync } = require('node:child_process');
const { sleepSync } = require('./sleep-sync');
const { deniedTagOf, declaredProtectedLane, sniffedProtectedLane } = require('./protected-lane');
const { isDecisionHoldTag } = require('./task-decision');
const { latestChecks, isFailingCheck, isPassingCheck, isPendingCheck } = require('../commands/caretaker');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LIVE_HOURS = 48;
const CLOSE_DAYS = 7;
const CATCH_UP_DAYS = 14;
const MERGED_SAMPLE = 200;
const MIN_MERGES_FOR_OURS = 2;
const MERGEABLE_ASKS = 3;
const CATCH_UP_LABEL = 'catch-up';
const BUCKETS = ['merge', 'catch-up', 'close', 'owner', 'leave'];
const LIST_FIELDS = [
  'number', 'title', 'url', 'author', 'isDraft', 'mergeable', 'mergeStateStatus',
  'updatedAt', 'createdAt', 'headRefName', 'headRefOid', 'baseRefName', 'labels',
  'statusCheckRollup', 'body', 'files', 'changedFiles',
].join(',');
// GitHub states that mean the merge button would work right now.
const READY_MERGE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);

function defaultRun(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function firstLine(result, fallback) {
  const text = String((result && (result.stderr || result.stdout)) || (result && result.error && result.error.message) || fallback).trim();
  return text.split(/\r?\n/).find(Boolean) || fallback;
}

function gh(ctx, args) {
  const full = ctx.repo ? [...args, '--repo', ctx.repo] : args;
  const result = ctx.run('gh', full, { cwd: ctx.cwd, encoding: 'utf8' });
  if (!result || result.error || result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${firstLine(result, 'no output')}`);
  }
  return String(result.stdout || '');
}

function ghJson(ctx, args) {
  const raw = gh(ctx, args).trim();
  return raw ? JSON.parse(raw) : null;
}

function login(author) {
  return String((author && author.login) || '').trim();
}

// Our accounts are whoever keeps landing work here: authors of the last 200
// merged pull requests with at least two merges, so one outside contributor
// who landed a single fix does not get their other pull requests swept.
function deriveOurs(merged, { minMerges = MIN_MERGES_FOR_OURS } = {}) {
  const counts = new Map();
  for (const pr of Array.isArray(merged) ? merged : []) {
    const name = login(pr.author);
    if (!name) continue;
    const prev = counts.get(name) || { login: name, merges: 0, bot: false };
    prev.merges += 1;
    prev.bot = prev.bot || Boolean(pr.author && pr.author.is_bot);
    counts.set(name, prev);
  }
  const all = [...counts.values()].sort((a, b) => b.merges - a.merges || a.login.localeCompare(b.login));
  return {
    sampled: Array.isArray(merged) ? merged.length : 0,
    minMerges,
    ours: all.filter((a) => a.merges >= minMerges),
    skipped: all.filter((a) => a.merges < minMerges),
  };
}

// A deploy preview (the Vercel status and its comment bot) proves the build
// published, not that anything was tested. atrisos-web runs no hosted tests on
// most pull requests, so "every check passed" there meant only "it deployed".
const PREVIEW_CHECK = /\b(vercel|netlify|preview|deploy(ment)?s?)\b/i;

function isPreviewCheck(check) {
  return PREVIEW_CHECK.test([check && check.name, check && check.context, check && check.workflowName].map((v) => String(v || '')).join(' '));
}

function ranAndPassed(check) {
  return String((check && (check.conclusion || check.state)) || '').toUpperCase() === 'SUCCESS';
}

function checksState(pr) {
  const checks = latestChecks(pr && pr.statusCheckRollup);
  if (!checks.length) return { state: 'none', name: '' };
  const failing = checks.find(isFailingCheck);
  if (failing) return { state: 'failing', name: String(failing.name || failing.context || 'a check') };
  if (checks.some(isPendingCheck)) return { state: 'pending', name: '' };
  if (!checks.every(isPassingCheck)) return { state: 'pending', name: '' };
  // Green only when at least one real test ran to success: skipped checks and
  // deploy previews pass without testing anything.
  return checks.some((c) => !isPreviewCheck(c) && ranAndPassed(c)) ? { state: 'green', name: '' } : { state: 'untested', name: '' };
}

// A pull request names its lane in its title, branch or labels. The task
// sniffer skips the lane words themselves (a task that says "security" is
// often just about it), but a pull request titled "billing page" or
// "security holes" changes that lane, so the words count here too, along with
// the plain words people use for money and signing in.
const PR_LANE_WORDS = [
  ['billing', /\b(billing|stripe|checkout|invoic\w*|subscriptions?|pricing|prices?|paywall)\b/],
  ['money', /\b(money|refund\w*|payments?|payouts?|treasury|wallets?|spending|paid|pay|pays|fees?|bank\w*|tax|taxes|cash|credit card|credits?|charges?|charged|purchases?|buys?|earn\w*|reimburs\w*)\b/],
  ['security', /\b(security|secrets?|credentials?|vulnerabilit\w*|oauth|auth|sign[ -]?in|log[ -]?in|login|passwords?|sessions?|csrf|cors|api key|permissions?)\b/],
  ['deploy', /\b(deploy\w*|migrations?)\b/],
  ['customer', /\b(customers?|outreach)\b/],
];
// Changed files in a protected lane, read from the file path. The mission
// guard's path surfaces (auth, session, cookie, middleware and the rest) apply
// too, the same check `atris land` runs on a branch diff.
const PR_PATH_WORDS = [
  ['billing', /(?:^|[/_.-])(billing|stripe|checkout|invoices?|subscriptions?|pricing|paywall)(?:[/_.-]|$)/i],
  ['money', /(?:^|[/_.-])(money|refunds?|payments?|payouts?|treasury|wallets?|credits?|pay)(?:[/_.-]|$)/i],
  ['security', /(?:^|[/_.-])(secrets?|credentials?|oauth|login|signin|sign-in)(?:[/_.-]|$)/i],
  ['deploy', /(?:^|\/)(migrations?|alembic|\.github\/workflows|render\.ya?ml|vercel\.json|dockerfile|deploy\w*)(?:[/_.-]|$)/i],
];
// Titles or labels that ask a person to decide before anything lands.
const HELD_FOR_A_PERSON = /^\s*(hold|wip|do not merge|don't merge|decision needed)\b|\b(do not merge|don't merge|needs? your review|for owner|for review by)\b/i;
// The hold labels the repos really carry: jev-hold ("held this for the owner"),
// needs-human ("a person has to read it"), codex-reject, needs-review.
const HELD_LABELS = /^(hold|on-hold|wip|do-not-merge|dont-merge|don't-merge|needs-decision|needs-human|needs-review|needs-owner|blocked|decision|codex-reject|rejected|[a-z0-9]+-hold|hold-[a-z0-9-]+)$/;

function labelNames(pr) {
  return (Array.isArray(pr.labels) ? pr.labels : []).map((l) => String((l && l.name) || l || '').trim()).filter(Boolean);
}

function filePaths(pr) {
  return (Array.isArray(pr.files) ? pr.files : []).map((f) => String((f && f.path) || f || '').trim()).filter(Boolean);
}

// GitHub lists at most 100 files per pull request on the list call; past that
// the rest are unseen, so no lane check on files can clear it.
function filesComplete(pr) {
  if (!Array.isArray(pr.files)) return false;
  const total = Number(pr.changedFiles);
  return !Number.isFinite(total) || total <= pr.files.length;
}

function protectedFileOf(pr) {
  const paths = filePaths(pr);
  if (!paths.length) return null;
  let matcher = null;
  try {
    ({ matchProtectedMissionDiff: matcher } = require('./mission-protected-lane'));
  } catch {
    matcher = null;
  }
  for (const file of paths) {
    for (const [lane, pattern] of PR_PATH_WORDS) {
      if (pattern.test(file)) return { lane, file };
    }
    if (matcher) {
      const verdict = matcher(`diff --git a/${file} b/${file}\n`);
      if (verdict.protected) return { lane: verdict.surfaces[0] || 'protected', file };
    }
  }
  return null;
}

// Every label is read on its own as a lane tag, and the lane words are read
// every time, labeled or not: a label such as "enhancement" never switches the
// word check off (the autoland gate in lib/member-autoland.js reads the same way).
function protectedLaneOfPr(pr) {
  const labels = labelNames(pr);
  for (const label of labels) {
    const denied = deniedTagOf({ tag: label });
    if (denied) return { lane: denied, why: `sits in the ${denied} lane` };
  }
  const branch = String(pr.headRefName || '').replace(/[-_/.]+/g, ' ');
  if (declaredProtectedLane({ title: pr.title, objective: branch, metadata: { protected_lane_note: pr.body } })) {
    return { lane: 'protected', why: 'sits in the protected lane' };
  }
  const sniffed = sniffedProtectedLane({ title: pr.title, objective: branch });
  if (sniffed) return { lane: sniffed.lane, why: `sits in the ${sniffed.lane} lane` };
  if (/\$\s?\d/.test(String(pr.title || ''))) return { lane: 'money', why: 'sits in the money lane' };
  const haystack = [pr.title, branch, ...labels].join('\n').toLowerCase();
  for (const [name, pattern] of PR_LANE_WORDS) {
    if (pattern.test(haystack)) return { lane: name, why: `sits in the ${name} lane` };
  }
  const file = protectedFileOf(pr);
  if (file) return { lane: file.lane, why: `changes ${file.lane} files (${file.file})` };
  return null;
}

function heldForAPerson(pr) {
  if (HELD_FOR_A_PERSON.test(String(pr.title || ''))) return 'its title asks a person to decide first';
  const held = labelNames(pr).find((l) => {
    const norm = l.toLowerCase().replace(/[_\s]+/g, '-');
    return HELD_LABELS.test(norm) || isDecisionHoldTag(norm);
  });
  return held ? `labeled ${held.toLowerCase()}` : '';
}

function touchedMs(pr) {
  const ms = Date.parse(pr.updatedAt || pr.createdAt || '');
  return Number.isFinite(ms) ? ms : 0;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function isUnknown(pr) {
  return String(pr.mergeable || '').toUpperCase() === 'UNKNOWN'
    || String(pr.mergeStateStatus || '').toUpperCase() === 'UNKNOWN'
    || !pr.mergeable;
}

// Sort one pull request into exactly one bucket. Pure: every input it needs is
// on the pull request or in opts, so the rules can be tested on real gh output.
function classifyPr(pr, { now = Date.now(), ours = new Set(), defaultBranch = 'master' } = {}) {
  const author = login(pr.author);
  if (!ours.has(author)) {
    return { bucket: 'owner', reason: `opened by ${author || 'an unknown account'}, not one of our accounts` };
  }
  const lane = protectedLaneOfPr(pr);
  if (lane) return { bucket: 'owner', reason: `${lane.why}, a person decides` };
  const held = heldForAPerson(pr);
  if (held) return { bucket: 'owner', reason: `${held}, a person decides` };

  const ageMs = Math.max(0, now - touchedMs(pr));
  const hours = Math.floor(ageMs / HOUR_MS);
  const days = Math.floor(ageMs / DAY_MS);
  if (ageMs < LIVE_HOURS * HOUR_MS) return { bucket: 'leave', reason: `touched ${plural(hours, 'hour')} ago, may be live work` };

  if (!filesComplete(pr)) {
    const seen = Array.isArray(pr.files) ? `only ${pr.files.length}` : 'none';
    return { bucket: 'leave', reason: `saw ${seen} of its changed files, so no lane check clears it` };
  }

  const idle = `no activity for ${plural(days, 'day')}`;
  if (pr.isDraft) {
    if (ageMs > CLOSE_DAYS * DAY_MS) return { bucket: 'close', reason: `a draft with ${idle}`, why: 'it is a draft' };
    return { bucket: 'leave', reason: `a draft touched ${plural(days, 'day')} ago, inside the ${CLOSE_DAYS} day window` };
  }

  const mergeable = String(pr.mergeable || '').toUpperCase();
  const mergeState = String(pr.mergeStateStatus || '').toUpperCase();
  const unknown = isUnknown(pr);
  const conflict = mergeable === 'CONFLICTING' || mergeState === 'DIRTY';
  const behind = !conflict && mergeState === 'BEHIND';
  const checks = checksState(pr);
  const base = String(pr.baseRefName || '');

  if (!unknown && !conflict && !behind && mergeable === 'MERGEABLE' && READY_MERGE_STATES.has(mergeState)
    && checks.state === 'green' && base === defaultBranch) {
    return { bucket: 'merge', reason: 'checks green on the current head and it merges clean' };
  }
  if ((conflict || behind) && ageMs <= CATCH_UP_DAYS * DAY_MS) {
    return { bucket: 'catch-up', reason: conflict ? `conflicts with ${base || defaultBranch}, touched ${plural(days, 'day')} ago` : `behind ${base || defaultBranch}, touched ${plural(days, 'day')} ago` };
  }
  if (ageMs > CLOSE_DAYS * DAY_MS && (conflict || checks.state === 'failing')) {
    const why = conflict ? `it has merge conflicts with ${base || defaultBranch}` : `its ${checks.name} check failed`;
    return { bucket: 'close', reason: `${idle} and ${why}`, why };
  }
  if (unknown) return { bucket: 'leave', reason: `github has not worked out whether it merges clean, asked ${MERGEABLE_ASKS} times` };
  if (behind) return { bucket: 'leave', reason: `behind ${base || defaultBranch} with ${idle}` };
  if (checks.state === 'failing') return { bucket: 'leave', reason: `its ${checks.name} check failed, still inside the ${CLOSE_DAYS} day window` };
  if (checks.state === 'pending') return { bucket: 'leave', reason: 'checks are still running' };
  if (checks.state === 'none') return { bucket: 'leave', reason: 'no hosted checks ran on its head, so nothing proves it green' };
  if (checks.state === 'untested') return { bucket: 'leave', reason: 'only a deploy preview or skipped checks ran, no hosted tests prove it green' };
  if (base !== defaultBranch) return { bucket: 'leave', reason: `targets ${base}, not ${defaultBranch}` };
  return { bucket: 'leave', reason: `github says the merge is held (${mergeState.toLowerCase() || 'no state'})` };
}

// GitHub answers "UNKNOWN" until something asks it to work out a merge; the
// list call never does. Ask the single pull request again, a few times, and
// never read a lazy answer as clean.
function refreshMergeable(ctx, pr) {
  let current = pr;
  for (let ask = 1; ask <= MERGEABLE_ASKS && isUnknown(current); ask += 1) {
    if (ask > 1) ctx.wait(1500 * (ask - 1));
    let fresh = null;
    try {
      fresh = ghJson(ctx, ['pr', 'view', String(pr.number), '--json', 'mergeable,mergeStateStatus,headRefOid']);
    } catch {
      fresh = null;
    }
    if (!fresh) continue;
    // A new push since the list means the check results are for an old head.
    if (fresh.headRefOid && pr.headRefOid && fresh.headRefOid !== pr.headRefOid) {
      return { ...current, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', headMoved: true };
    }
    current = { ...current, mergeable: fresh.mergeable, mergeStateStatus: fresh.mergeStateStatus };
  }
  return current;
}

// Only ask again when the answer can change the bucket: ours, not protected,
// not live, not a draft.
function needsMergeable(pr, { now, ours }) {
  if (!isUnknown(pr) || pr.isDraft || !ours.has(login(pr.author))) return false;
  if (protectedLaneOfPr(pr) || heldForAPerson(pr)) return false;
  return now - touchedMs(pr) >= LIVE_HOURS * HOUR_MS;
}

function closeComment(entry) {
  return `closing this because it has had no activity for ${plural(entry.idleDays, 'day')} and ${entry.why}. `
    + 'the branch is kept, so it can be reopened or picked up again at any time.';
}

function sweepRepo({ repo = '', cwd = process.cwd(), run = defaultRun, wait = sleepSync, now = Date.now(), oursOverride = null } = {}) {
  const ctx = { repo, cwd, run, wait };
  // gh repo view takes the repo as an argument, not --repo.
  const info = ghJson({ ...ctx, repo: '' }, ['repo', 'view', ...(repo ? [repo] : []), '--json', 'nameWithOwner,defaultBranchRef']) || {};
  const name = info.nameWithOwner || repo;
  const defaultBranch = (info.defaultBranchRef && info.defaultBranchRef.name) || 'master';
  ctx.repo = name || repo;

  let accounts;
  if (Array.isArray(oursOverride) && oursOverride.length) {
    accounts = { sampled: 0, minMerges: 0, ours: oursOverride.map((l) => ({ login: l, merges: 0, bot: false })), skipped: [], override: true };
  } else {
    const merged = ghJson(ctx, ['pr', 'list', '--state', 'merged', '--limit', String(MERGED_SAMPLE), '--json', 'author']) || [];
    accounts = deriveOurs(merged);
  }
  const ours = new Set(accounts.ours.map((a) => a.login));

  const open = ghJson(ctx, ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', LIST_FIELDS]) || [];
  const entries = open.map((raw) => {
    const pr = needsMergeable(raw, { now, ours }) ? refreshMergeable(ctx, raw) : raw;
    const verdict = classifyPr(pr, { now, ours, defaultBranch });
    if (pr.headMoved) verdict.reason = 'a new push landed while sorting, sort it again next run';
    if (pr.headMoved) verdict.bucket = 'leave';
    const idleMs = Math.max(0, now - touchedMs(pr));
    return {
      number: pr.number,
      title: String(pr.title || ''),
      url: pr.url || '',
      author: login(pr.author),
      draft: Boolean(pr.isDraft),
      head: pr.headRefOid || '',
      branch: pr.headRefName || '',
      updatedAt: pr.updatedAt || '',
      idleDays: Math.floor(idleMs / DAY_MS),
      labels: (Array.isArray(pr.labels) ? pr.labels : []).map((l) => String((l && l.name) || '')),
      mergeable: pr.mergeable || '',
      mergeStateStatus: pr.mergeStateStatus || '',
      bucket: verdict.bucket,
      reason: verdict.reason,
      why: verdict.why || '',
    };
  });
  // Oldest first inside each bucket: the longest wait is the first to clear.
  entries.sort((a, b) => Date.parse(a.updatedAt || 0) - Date.parse(b.updatedAt || 0) || a.number - b.number);
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, entries.filter((e) => e.bucket === b).length]));
  return { repo: ctx.repo, defaultBranch, checkedAt: new Date(now).toISOString(), accounts, counts, total: entries.length, entries, applied: false, actions: [] };
}

function ensureCatchUpLabel(ctx) {
  const result = ctx.run('gh', ['label', 'create', CATCH_UP_LABEL, '--repo', ctx.repo, '--color', 'fbca04',
    '--description', 'behind or conflicting, needs catching up with the main branch'], { cwd: ctx.cwd, encoding: 'utf8' });
  // "already exists" is fine: the label is what we wanted.
  return result && (result.status === 0 || /already exists/i.test(`${result.stderr || ''}${result.stdout || ''}`));
}

function applyEntry(ctx, entry) {
  if (entry.bucket === 'merge') {
    // Loaded here so a dry run never pays for the worktree helpers.
    const { mergePrWithRetry } = require('./worktree-core');
    const merged = mergePrWithRetry(['pr', 'merge', String(entry.number), '--repo', ctx.repo, '--merge', '--match-head-commit', entry.head], ctx.cwd, { run: ctx.run, wait: ctx.wait });
    if (!merged || merged.status !== 0) return { number: entry.number, action: 'merge', ok: false, detail: firstLine(merged, 'gh pr merge failed') };
    let state = '';
    try { state = String((ghJson(ctx, ['pr', 'view', String(entry.number), '--json', 'state']) || {}).state || ''); } catch { state = ''; }
    return { number: entry.number, action: 'merge', ok: true, detail: state === 'MERGED' ? 'merged' : 'sent to the merge line, github finishes it' };
  }
  if (entry.bucket === 'catch-up') {
    if (entry.labels.includes(CATCH_UP_LABEL)) return { number: entry.number, action: 'label', ok: true, detail: 'already labeled' };
    if (!ctx.labelReady) ctx.labelReady = ensureCatchUpLabel(ctx);
    try {
      gh(ctx, ['pr', 'edit', String(entry.number), '--add-label', CATCH_UP_LABEL]);
      return { number: entry.number, action: 'label', ok: true, detail: `labeled ${CATCH_UP_LABEL}` };
    } catch (err) {
      return { number: entry.number, action: 'label', ok: false, detail: String(err.message || err) };
    }
  }
  if (entry.bucket === 'close') {
    // No --delete-branch, ever: the branch stays so the work can come back.
    try {
      gh(ctx, ['pr', 'close', String(entry.number), '--comment', closeComment(entry)]);
      return { number: entry.number, action: 'close', ok: true, detail: 'closed, branch kept' };
    } catch (err) {
      return { number: entry.number, action: 'close', ok: false, detail: String(err.message || err) };
    }
  }
  return null;
}

function applySweep(report, { cwd = process.cwd(), run = defaultRun, wait = sleepSync } = {}) {
  const ctx = { repo: report.repo, cwd, run, wait, labelReady: false };
  const actions = [];
  for (const entry of report.entries) {
    const done = applyEntry(ctx, entry);
    if (done) actions.push(done);
  }
  return { ...report, applied: true, actions };
}

function shortTitle(title, max = 60) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function formatSweep(report, { show = 10 } = {}) {
  const lines = [];
  lines.push(`pull request sweep: ${report.repo}, ${report.applied ? 'applied' : 'dry run, nothing changes'}`);
  const a = report.accounts;
  const who = a.ours.map((o) => (a.override ? o.login : `${o.login} (${o.merges})`)).join(', ') || 'none';
  lines.push(a.override
    ? `our accounts (given by --ours): ${who}`
    : `our accounts (${a.minMerges} or more of the last ${a.sampled} merged pull requests): ${who}`);
  if (a.skipped && a.skipped.length) lines.push(`not counted as ours (fewer merges): ${a.skipped.map((o) => `${o.login} (${o.merges})`).join(', ')}`);
  lines.push(`${report.total} open: ${BUCKETS.map((b) => `${b} ${report.counts[b]}`).join(', ')}`);
  for (const bucket of BUCKETS) {
    const rows = report.entries.filter((e) => e.bucket === bucket);
    if (!rows.length) continue;
    lines.push('');
    lines.push(`${bucket} (${rows.length}, oldest first)`);
    const shown = show > 0 ? rows.slice(0, show) : rows;
    for (const e of shown) lines.push(`  #${e.number}  ${e.idleDays}d  ${shortTitle(e.title)}  : ${e.reason}`);
    if (rows.length > shown.length) lines.push(`  and ${rows.length - shown.length} more (--all shows every row)`);
  }
  if (report.applied) {
    lines.push('');
    const ok = report.actions.filter((x) => x.ok).length;
    lines.push(`done: ${ok} of ${report.actions.length} actions worked`);
    for (const x of report.actions.filter((y) => !y.ok)) lines.push(`  #${x.number} ${x.action} failed: ${x.detail}`);
  } else if (report.counts.merge + report.counts['catch-up'] + report.counts.close > 0) {
    lines.push('');
    lines.push(`next: atris land --prs --repo ${report.repo} --apply`);
  }
  return lines;
}

module.exports = {
  PR_LANE_WORDS,
  PR_PATH_WORDS,
  CATCH_UP_LABEL,
  applySweep,
  classifyPr,
  deriveOurs,
  formatSweep,
  sweepRepo,
};
