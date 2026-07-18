// Orb context — deterministic greeting + suggestion synthesis for the orb surface.
// Pure synthesis lives in buildOrbContext (unit-testable, no fs); collectOrbContext
// does the read-only fs aggregation from a project root. No model calls anywhere:
// 0ms-to-greeting is the contract (atris/features/orb-desktop/PLAN.md).
const fs = require('fs');
const path = require('path');

const MAX_SUGGESTIONS = 12;
const WARM_THREAD_WINDOW_MS = 48 * 60 * 60 * 1000;
const STALLED_TASK_WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKLOG_STATUSES = new Set(['open', 'backlog', 'inbox', 'planned', 'plan', 'todo', 'ready']);

function cleanTitle(value, max = 64) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function todayKey(now) {
  const stamp = normalizeTime(now);
  if (!stamp) return '';
  return new Date(stamp).toISOString().slice(0, 10);
}

function normalizeStatus(value) {
  return String(value || '').toLowerCase().replace(/_/g, '-').trim();
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const metadata = asRecord(t.metadata);
      const review = asRecord(t.review);
      return {
        id: String(t.display_id || t.id || ''),
        title: cleanTitle(t.title),
        status: normalizeStatus(t.status),
        lane: cleanTitle(t.lane || t.task_lane || metadata.lane || t.tag || t.status || 'backlog', 24),
        updatedAt: normalizeTime(t.updated_at || t.updatedAt),
        metadata,
        review,
      };
    })
    .filter((t) => t.title);
}

// Known suggestion action prefixes. Stripped repeatedly (front-anchored) so that
// "review: review: X" or "pick up pick up X" both collapse to the bare title —
// used both to keep labels single-prefixed and to compare titles across sources.
// "atrisbox" is included because Atrisbox threads are titled "Atrisbox: <label>",
// which otherwise shields inner accumulated prefixes from stripping (seen live
// in the burst-tap rig: "pick up Atrisbox: pick up Atrisbox: plan today").
// The atrisbox marker requires its colon so a thread genuinely titled
// "Atrisbox" keeps its name.
const ACTION_PREFIX_RE = /^(?:(?:review|resume|pick up|keep going on)\s*:?|atrisbox\s*:)\s*/i;

function stripActionPrefixes(value) {
  let text = String(value || '').trim();
  let prev;
  do {
    prev = text;
    text = text.replace(ACTION_PREFIX_RE, '').trim();
  } while (text !== prev);
  return text;
}

// Lowercase, prefix-stripped, whitespace-collapsed form used only for equality/
// prefix comparison across sources (tasks vs threads) — never shown to the user.
function normalizeForMatch(value) {
  return stripActionPrefixes(String(value || '').toLowerCase().replace(/\s+/g, ' ').trim());
}

// True when two titles are "the same work" — exact match, or one is a truncated
// prefix of the other (titles get cut at different lengths per source, so a
// straight equality check would miss the common case). Guarded by a minimum
// needle length so short titles ("fix it") don't false-positive against unrelated
// longer ones.
function titlesOverlap(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length < 12) return false;
  return longer.startsWith(shorter);
}

// Background Atrisbox taps write a launch-receipt thread (desk_<project>_
// atrisbox_bg_<slug>) — it's proof a turn ran, not a resumable conversation.
// They self-archive on delivery (App.tsx sendAtrisboxMessage) and main.js
// sweeps stragglers, but excluding them from warm eligibility here too is
// cheap (a string check, no I/O) and keeps the count honest even for threads
// that haven't been swept or archived yet (OBL-1674).
function isAtrisboxBgThread(id) {
  return /_atrisbox_bg_/.test(String(id || ''));
}

function normalizeThreads(threads) {
  if (!Array.isArray(threads)) return [];
  return threads
    .filter((t) => t && typeof t === 'object' && !t.archivedAt && !isAtrisboxBgThread(t.id))
    .map((t) => ({
      id: String(t.id || ''),
      title: cleanTitle(t.title || 'Untitled'),
      updatedAt: Number(t.updatedAt || 0) || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Dedupe by "same work" (titlesOverlap) keeping the newest of each cluster —
// used before counting warm threads so the greeting number reflects distinct
// resumable work, not the same thread title repeated under different ids.
function dedupeByTitle(threads) {
  const kept = [];
  for (const t of threads) {
    if (kept.some((k) => titlesOverlap(k.title, t.title))) continue;
    kept.push(t);
  }
  return kept;
}

function reviewApprovalStatus(task) {
  const metadata = asRecord(task && task.metadata);
  const review = asRecord(task && task.review);
  return normalizeStatus(review.approval_status || metadata.approval_status || metadata.review_status);
}

function reviewPassCount(task) {
  const metadata = asRecord(task && task.metadata);
  const review = asRecord(task && task.review);
  const value = Number(review.agent_review_pass_count ?? metadata.agent_review_pass_count ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function isAgentCertifiedReview(task) {
  const metadata = asRecord(task && task.metadata);
  const review = asRecord(task && task.review);
  const handoff = asRecord(review.handoff);
  return metadata.agent_certified === true
    || metadata.agent_certified === 'true'
    || review.agent_certified === true
    || review.agent_certified === 'true'
    || handoff.native_goal_status === 'agent_certified'
    || reviewPassCount(task) >= 2;
}

function isCertifiedReviewWaiting(task) {
  if (!task || task.status !== 'review' || !isAgentCertifiedReview(task)) return false;
  const approval = reviewApprovalStatus(task);
  return !['accept', 'accepted', 'done', 'complete', 'completed', 'revise', 'rejected'].includes(approval);
}

function isStalledInProgress(task, now) {
  if (!task || !['claimed', 'doing'].includes(task.status) || !task.updatedAt) return false;
  return now - task.updatedAt >= STALLED_TASK_WINDOW_MS;
}

function pluralize(count, one, many = `${one}s`) {
  return count === 1 ? one : many;
}

// Pure. Input: plain data already read from disk. Output: greeting facts, greeting
// beats (typed out by the surface), and ranked suggestions (each launches a real turn).
function buildOrbContext({ nowMd = '', tasks = [], threads = [], memberLoops = [], now = Date.now() } = {}) {
  const cleanTasks = normalizeTasks(tasks);
  const cleanThreads = normalizeThreads(threads);
  const reviewTasks = cleanTasks.filter((t) => t.status === 'review').sort((a, b) => b.updatedAt - a.updatedAt);
  const certifiedReviewTasks = reviewTasks.filter(isCertifiedReviewWaiting).sort((a, b) => b.updatedAt - a.updatedAt);
  const doingTasks = cleanTasks.filter((t) => t.status === 'claimed' || t.status === 'doing').sort((a, b) => b.updatedAt - a.updatedAt);
  const stalledTasks = doingTasks.filter((t) => isStalledInProgress(t, now)).sort((a, b) => a.updatedAt - b.updatedAt);
  const failedTasks = cleanTasks.filter((t) => t.status === 'failed').sort((a, b) => b.updatedAt - a.updatedAt);
  const backlogTasks = cleanTasks.filter((t) => BACKLOG_STATUSES.has(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  const warmThreadsRaw = cleanThreads.filter((t) => now - t.updatedAt < WARM_THREAD_WINDOW_MS);
  // Dedupe BEFORE counting so the greeting number ("N threads are warm") and
  // the resume-suggestion loop below both see the same deduped set.
  const warmThreads = dedupeByTitle(warmThreadsRaw);
  const loops = (Array.isArray(memberLoops) ? memberLoops : [])
    .filter((l) => l && typeof l === 'object' && l.member)
    .map((l) => ({ member: String(l.member), mode: String(l.mode || '') }));
  const hasNow = Boolean(String(nowMd || '').trim());
  const day = todayKey(now);
  const hasJournalToday = Boolean(day && String(nowMd || '').includes(day));
  const journalEmptyToday = Boolean(day && !hasJournalToday);

  const greetingFacts = {
    threadCount: cleanThreads.length,
    warmThreadCount: warmThreads.length,
    reviewCount: reviewTasks.length,
    doingCount: doingTasks.length,
    certifiedReviewCount: certifiedReviewTasks.length,
    stalledDoingCount: stalledTasks.length,
    failedCount: failedTasks.length,
    loopCount: loops.length,
    hasNow,
    hasJournalToday,
  };

  const suggestions = [];
  // Titles already spoken for by a suggestion, used to dedupe across sources
  // (review/resume/continue are built independently but can point at the same
  // underlying work — e.g. a task's warm thread title vs the task's own title).
  const usedTitles = [];

  function pushSuggestion(suggestion, title = '') {
    const key = normalizeForMatch(suggestion.label);
    if (suggestions.some((s) => s.id === suggestion.id || normalizeForMatch(s.label) === key)) return false;
    suggestions.push(suggestion);
    if (title) usedTitles.push(title);
    return true;
  }

  if (certifiedReviewTasks.length) {
    const count = certifiedReviewTasks.length;
    pushSuggestion({
      id: 'review:certified',
      label: `accept ${count} ${pluralize(count, 'review')}`,
      kind: 'review',
      reason: 'Certified proof is waiting on human acceptance.',
      side: count === 1 ? certifiedReviewTasks[0].id || 'certified' : `${count} ready`,
      prompt: `Review the ${count} agent-certified ${pluralize(count, 'task')} waiting on human acceptance. Read the proof, accept only clear wins, and call out anything that needs revision.`,
    });
  }

  const reviewTask = certifiedReviewTasks.length
    ? reviewTasks.find((t) => !isCertifiedReviewWaiting(t))
    : reviewTasks[0];
  if (reviewTask) {
    const alreadyLabeled = /^review\s*:?/i.test(reviewTask.title);
    pushSuggestion({
      id: `review:${reviewTask.id}`,
      label: alreadyLabeled ? reviewTask.title : `review: ${reviewTask.title}`,
      kind: 'review',
      reason: 'A task is waiting for judgment.',
      side: reviewTask.id || 'in review',
      prompt: `Task ${reviewTask.id} ("${reviewTask.title}") is waiting in review. Read its proof and diff, then tell me plainly: accept, or what exactly to fix.`,
    }, reviewTask.title);
  }

  if (failedTasks.length) {
    const count = failedTasks.length;
    pushSuggestion({
      id: 'unblock:failed-tasks',
      label: `unblock ${count} failed ${pluralize(count, 'task')}`,
      kind: 'unblock',
      reason: 'Failed tasks are blocking the queue.',
      side: count === 1 ? failedTasks[0].id || 'failed' : `${count} failed`,
      prompt: `There ${count === 1 ? 'is' : 'are'} ${count} failed ${pluralize(count, 'task')} in this project. Find the failures, group the blockers, and recommend the fastest unblock path before changing anything.`,
    });
  }

  // Explicitly blocked/stalled statuses are their own lane — distinct from the
  // stale-doing "finish" lane below, which infers staleness from the clock.
  const blockedTask = cleanTasks
    .filter((t) => t.status === 'blocked' || t.status === 'stalled')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (blockedTask) {
    pushSuggestion({
      id: `unstick:${blockedTask.id}`,
      label: `unstick: ${cleanTitle(stripActionPrefixes(blockedTask.title), 48)}`,
      kind: 'continue',
      reason: 'This task is marked blocked.',
      side: blockedTask.id || blockedTask.lane || 'stalled',
      prompt: `Run "atris task show ${blockedTask.id}" first. Then unblock one bounded slice of "${blockedTask.title}" and return proof with the files changed and exact verification command plus exit code.`,
    }, blockedTask.title);
  }

  // The claimed/doing task will always be offered if present, so its title counts
  // as "already included" for warm-thread dedupe purposes even though the
  // suggestion itself is pushed after resume (to preserve review > resume > continue
  // ranking).
  const doingTask = doingTasks[0];
  if (doingTask) usedTitles.push(doingTask.title);
  const stalledTask = stalledTasks[0];
  if (stalledTask) usedTitles.push(stalledTask.title);

  if (stalledTask) {
    const alreadyLabeled = /^finish\s*/i.test(stalledTask.title);
    pushSuggestion({
      id: `finish:${stalledTask.id}`,
      label: alreadyLabeled ? stalledTask.title : `finish ${stalledTask.title}`,
      kind: 'finish',
      reason: 'This in-progress task has gone stale.',
      side: stalledTask.id || 'stalled',
      prompt: `Task ${stalledTask.id} ("${stalledTask.title}") is in progress and stale. Inspect its latest state, finish the smallest safe slice, and leave proof of what changed.`,
    }, stalledTask.title);
  }

  let resumeThread = null;
  let resumeLabelTitle = '';
  for (const thread of warmThreads) {
    if (usedTitles.some((title) => titlesOverlap(title, thread.title))) continue;
    // Thread titles inherit message text, so a picked-up thread can arrive as
    // "pick up X: pick up X..." — strip the accumulated prefixes before reusing.
    const threadTitle = cleanTitle(stripActionPrefixes(String(thread.title || '')), 40);
    if (threadTitle.length < 3) continue;
    resumeThread = thread;
    resumeLabelTitle = threadTitle;
    break;
  }
  if (resumeThread) {
    pushSuggestion({
      id: `resume:${resumeThread.id}`,
      label: `pick up ${resumeLabelTitle}`,
      kind: 'resume',
      reason: 'This thread was active recently.',
      side: 'warm thread',
      prompt: `Pick the thread "${resumeThread.title}" back up: read where it left off in this project and continue the work from there.`,
    }, resumeThread.title);
  }

  if (doingTask && (!stalledTask || !titlesOverlap(doingTask.title, stalledTask.title))) {
    const alreadyLabeled = /^keep going on\s*/i.test(doingTask.title);
    pushSuggestion({
      id: `continue:${doingTask.id}`,
      label: alreadyLabeled ? doingTask.title : `keep going on ${doingTask.title}`,
      kind: 'continue',
      reason: 'This task is already claimed.',
      side: doingTask.id || 'claimed',
      prompt: `Task ${doingTask.id} ("${doingTask.title}") is claimed but not done. Check its current state and take the next concrete step.`,
    }, doingTask.title);
  }
  if (journalEmptyToday) {
    pushSuggestion({
      id: 'log-today',
      label: 'log what shipped',
      kind: 'log',
      reason: 'Today has no journal entry yet.',
      side: day || 'today',
      prompt: `Write a short ${day || 'today'} journal entry for this project: what shipped, what is still open, and the next concrete move. Keep it factual and brief.`,
    });
  }
  // Backlog tasks deepen the well without another read: collectOrbContext already
  // loaded the full task projection. Keep them behind urgent/resumable work and
  // ahead of the evergreen tail so the menu survives many in-flight dispatches.
  for (const task of backlogTasks) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (usedTitles.some((title) => titlesOverlap(title, task.title))) continue;
    const shortTitle = cleanTitle(stripActionPrefixes(task.title), 48);
    if (!shortTitle) continue;
    pushSuggestion({
      id: `start:${task.id}`,
      label: `start: ${shortTitle}`,
      kind: task.status === 'planned' || task.status === 'plan' || task.status === 'ready' ? 'continue' : 'plan',
      reason: 'Backlog work ready to begin.',
      side: task.lane || 'backlog',
      prompt: `Run "atris task show ${task.id}" first. Then execute one bounded slice of "${task.title}" and return proof with the files changed and exact verification command plus exit code.`,
    }, task.title);
  }

  // These stay at the tail even when the backlog is full, so orientation and
  // planning never disappear behind the deeper task-fed pool.
  // 'status' is answered locally by the view from gmSnapshot — no model call.
  const staticSuggestions = [{
    id: 'status',
    label: "what's moving",
    kind: 'digest',
    reason: 'Get the live team snapshot first.',
    side: 'instant',
    lane: 'instant',
    prompt: 'Give me a team status: who is working, the latest result, and what needs me.',
  }, {
    id: 'plan-today',
    label: 'plan today',
    kind: 'plan',
    reason: hasNow ? "Use today's notes to pick the move." : 'Start from project context.',
    side: hasNow ? 'from now.md' : 'fresh',
    prompt: hasNow
      ? 'Read now.md and atris/TODO.md in this project, then give me a short plan for today: the one move that matters most, and two backups.'
      : 'Look at this project (README, atris/MAP.md if present) and propose a short plan for today: the one move that matters most, and two backups.',
  }, {
    id: 'look-around',
    label: 'show me around',
    kind: 'plan',
    reason: 'Orientation is always one tap away.',
    side: 'orientation',
    prompt: 'Read this project and tell me in plain words what it is, what state it is in, and the top three next moves.',
  }];

  const workSuggestions = suggestions.slice(0, MAX_SUGGESTIONS - staticSuggestions.length);
  const finalSuggestions = [...workSuggestions, ...staticSuggestions];

  const beats = [];
  const factBits = [];
  if (warmThreads.length) factBits.push(warmThreads.length === 1 ? 'One thread is warm.' : `${warmThreads.length} threads are warm.`);
  if (reviewTasks.length) factBits.push(reviewTasks.length === 1 ? 'One task waits for review.' : `${reviewTasks.length} tasks wait for review.`);
  if (doingTasks.length && factBits.length < 2) factBits.push(doingTasks.length === 1 ? 'One task is mid-flight.' : `${doingTasks.length} tasks are mid-flight.`);
  if (loops.length && factBits.length < 2) factBits.push(loops.length === 1 ? 'One member loop ran recently.' : `${loops.length} member loops ran recently.`);
  if (factBits.length) {
    beats.push(factBits.slice(0, 2).join(' '));
    beats.push('Tap the next move.');
  } else {
    beats.push('Quiet workspace. Nothing is mid-flight.');
    beats.push('Tap a starting move, or say it your way.');
  }

  return {
    schema: 'obelisk.orb_context.v1',
    greeting_facts: greetingFacts,
    beats,
    suggestions: finalSuggestions,
  };
}

async function readTextSafe(filePath, maxBytes = 24000) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  } catch {
    return '';
  }
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Read-only aggregation from a project root. Creates nothing; absent files = empty.
// `threads` come from the caller (main.js owns ~/.obelisk/threads listing).
async function collectOrbContext(root, { threads = [], now = Date.now() } = {}) {
  const safeRoot = typeof root === 'string' && root ? path.resolve(root) : null;
  if (!safeRoot) return buildOrbContext({ threads, now });
  const nowMd = await readTextSafe(path.join(safeRoot, 'now.md'), 8000);
  const projection = await readJsonSafe(path.join(safeRoot, '.atris', 'state', 'tasks.projection.json'));
  const tasks = projection && projection.schema === 'atris.task_projection.v1' && Array.isArray(projection.tasks)
    ? projection.tasks
    : [];
  const memberLoops = [];
  try {
    const loopDir = path.join(safeRoot, '.atris', 'state', 'member-loops');
    const names = (await fs.promises.readdir(loopDir)).filter((n) => n.endsWith('.latest.json')).slice(0, 12);
    for (const name of names) {
      const payload = await readJsonSafe(path.join(loopDir, name));
      if (payload) memberLoops.push(payload);
    }
  } catch {}
  return buildOrbContext({ nowMd, tasks, threads, memberLoops, now });
}

// The accumulate-context flywheel: each chosen option appends one visible line to the
// project's now.md. Append-only; creates now.md on first choice.
async function appendOrbChoice(root, label, when = new Date()) {
  const safeRoot = typeof root === 'string' && root ? path.resolve(root) : null;
  const cleanLabel = cleanTitle(label, 120);
  if (!safeRoot || !cleanLabel) return { ok: false, error: 'invalid root or label' };
  const day = when.toISOString().slice(0, 10);
  const line = `orb: ${cleanLabel} · ${day}\n`;
  try {
    await fs.promises.appendFile(path.join(safeRoot, 'now.md'), line, 'utf8');
    return { ok: true, line: line.trim() };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

module.exports = {
  buildOrbContext,
  collectOrbContext,
  appendOrbChoice,
};
