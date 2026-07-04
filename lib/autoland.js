'use strict';

// Autoland: the owner approves the policy once, then certified work lands
// itself. Humans keep the genuinely irreversible lanes (the denied tags in
// lib/auto-accept-certified.js); everything else is verified, reversible,
// and receipted, so waiting for a human click adds latency, not safety.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const DEFAULT_DIGEST_HOUR = 9;
const DEFAULT_ALARM_HOURS = 24;
const OPERATOR_WHY = /\b(sav(?:e|es|ing)|burn(?:s|ing)?|wast(?:e|es|ing)|cost(?:s|ing)?|prevent\w*|stop(?:s|ping)?|break(?:s|ing)?|fail(?:s|ing)?|slow(?:s|er)?|faster|cheaper|easier|clearer|safer|simpler|trust|revenue|users?|customers?|so that|because)\b/i;
const AGENT_JARGON = /[a-z0-9]_[a-z0-9]|\b[a-z]+[A-Z]\w*|--[a-z]|\bCLI-\d+/;

function policyPath(root) {
  return path.join(root, '.atris', 'policy', 'autoland.json');
}

function statePath(root) {
  return path.join(root, '.atris', 'state', 'autoland.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Default is ON: agents are good enough that a growing review queue is
// latency, not safety — the denied tags keep the irreversible lanes human.
// A missing policy file means "on, owner inferred"; only an explicit
// `atris autoland off` (enabled: false) turns it off.
function inferOwner(root) {
  const git = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' });
  const name = git.status === 0 ? String(git.stdout || '').trim() : '';
  return name || os.userInfo().username;
}

function defaultPolicy(root) {
  return { enabled: true, enabled_by: inferOwner(root), enabled_at: null, default: true };
}

function readPolicy(root) {
  const policy = readJson(policyPath(root), null);
  if (!policy || typeof policy !== 'object') return defaultPolicy(root);
  return policy;
}

function writePolicy(root, policy) {
  writeJson(policyPath(root), policy);
  return policy;
}

function readState(root) {
  const state = readJson(statePath(root), {});
  if (!state.alerts || typeof state.alerts !== 'object') state.alerts = {};
  return state;
}

function writeState(root, state) {
  writeJson(statePath(root), state);
}

// The standing authorization cmdAutoAcceptCertified consults: live accepts
// are allowed without a per-run human confirmation only when the owner has
// flipped the policy on for this workspace.
function liveAcceptAuthorization(root = process.cwd()) {
  const policy = readPolicy(root);
  if (!policy || policy.enabled !== true) return { ok: false, reason: 'autoland_policy_off' };
  const actor = String(policy.enabled_by || '').trim();
  if (!actor) return { ok: false, reason: 'autoland_policy_missing_owner' };
  return { ok: true, actor, policy: 'autoland', strictVerify: policy.strict_verify !== false };
}

function cronMarker(root) {
  const slug = path.basename(root).replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  return `ATRIS_AUTOLAND_${slug}`;
}

function buildCronLine(root) {
  const node = process.execPath;
  const bin = path.join(root, 'bin', 'atris.js');
  const cliBin = fs.existsSync(bin) ? bin : 'atris';
  const logDir = path.join(os.homedir(), '.atris', 'overnight');
  const logFile = path.join(logDir, `autoland-${path.basename(root)}.log`);
  const invoke = cliBin.endsWith('.js') ? `${node} ${cliBin}` : cliBin;
  return `14 * * * * cd ${root} && ${invoke} autoland tick >> ${logFile} 2>&1 # ${cronMarker(root)}`;
}

function readCrontab() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
  return result.status === 0 ? String(result.stdout || '') : '';
}

function applyCrontab(content) {
  const result = spawnSync('crontab', ['-'], { input: content, encoding: 'utf8', timeout: 10000 });
  return result.status === 0;
}

function cronInstalled(root) {
  return readCrontab().includes(cronMarker(root));
}

function installCron(root) {
  fs.mkdirSync(path.join(os.homedir(), '.atris', 'overnight'), { recursive: true });
  const marker = cronMarker(root);
  const kept = readCrontab().split(/\r?\n/).filter((line) => line.trim() && !line.includes(marker));
  const next = `${kept.join('\n')}${kept.length ? '\n' : ''}${buildCronLine(root)}\n`;
  return applyCrontab(next);
}

function uninstallCron(root) {
  const marker = cronMarker(root);
  const kept = readCrontab().split(/\r?\n/).filter((line) => line.trim() && !line.includes(marker));
  return applyCrontab(kept.length ? `${kept.join('\n')}\n` : '');
}

function certifiedAtMs(task) {
  const iso = task.metadata?.agent_certified_at;
  if (iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  return Number(task.updated_at) || Date.now();
}

function waitingHours(task, now = Date.now()) {
  return Math.floor((now - certifiedAtMs(task)) / 3600000);
}

// Tasks that are certified and pending — i.e. finished work sitting on the
// human side of the fence, whatever the reason.
function waitingOnHuman(tasks, now = Date.now()) {
  return (tasks || [])
    .filter((t) => t.status === 'review')
    .filter((t) => String(t.review?.approval_status || t.metadata?.approval_status || 'pending') === 'pending')
    .filter((t) => t.review?.agent_certified === true || t.metadata?.agent_certified === true)
    .map((t) => ({
      ref: t.display_id || t.legacy_ref || t.id,
      title: String(t.title || '').slice(0, 200),
      tag: String(t.tag || ''),
      hours: waitingHours(t, now),
    }))
    .sort((a, b) => b.hours - a.hours);
}

function acceptedInLastDay(tasks, now = Date.now()) {
  const auto = [];
  const human = [];
  for (const t of tasks || []) {
    const acceptedAt = Date.parse(t.metadata?.accepted_at || '') || 0;
    if (!acceptedAt || now - acceptedAt > 24 * 3600000) continue;
    const entry = {
      ref: t.display_id || t.legacy_ref || t.id,
      title: String(t.title || '').slice(0, 120),
      happened: String(t.review?.landing?.happened || t.metadata?.landing_happened || '').slice(0, 300),
      member: String(t.claimed_by || t.assigned_to || '').trim(),
    };
    if (t.metadata?.auto_accepted_at) auto.push(entry);
    else human.push(entry);
  }
  return { auto, human };
}

function plur(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function cutAtWord(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}...`;
}

// A line ends where a thought ends. Long lines close at their last complete
// clause inside the budget and read whole: no ellipsis, nothing dangling.
// Only when a line has no clause boundary at all does a word cut remain.
function finishThought(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().replace(/[,;:\s]+$/, '');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > max * 0.3) return cut.slice(0, sentence + 1);
  const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' ('), cut.lastIndexOf(': '));
  if (clause > max * 0.45) return cut.slice(0, clause);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > max * 0.6 ? space : max)}...`;
}

function operatorReady(text) {
  const value = String(text || '');
  return OPERATOR_WHY.test(value) && !AGENT_JARGON.test(value);
}

function hasAgentJargon(text) {
  return AGENT_JARGON.test(String(text || ''));
}

// One line per piece, in the work's own words: the landing sentence beats
// the task title, because titles are written for the queue, not for a text.
// The cut is generous on purpose: a specific sentence the reader trusts
// (what happened + how big + how we know) beats a short one they must chase.
function digestLine(item) {
  const happened = String(item.happened || '').replace(/^completed:\s*/i, '').split(/(?<=[.!?])\s+/)[0] || '';
  const title = String(item.title || '').replace(/^Mission XP:\s*/i, '');
  const source = happened.length >= 12 ? happened : title;
  const line = finishThought(source.replace(/[.\s]+$/, ''), 160);
  return line.charAt(0).toLowerCase() + line.slice(1);
}

// A rough sentence still beats a count: when a landing sentence carries agent
// vocabulary, strip what a reader can't use (flag dashes, ids, underscores)
// and show it anyway. Content always ships; the gate only changes how it reads.
function dejargon(line) {
  return String(line || '')
    .replace(/--([a-z][a-z-]*)/g, '$1')
    .replace(/\bCLI-\d+\b/g, '')
    .replace(/([a-z0-9])_([a-z0-9])/gi, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// The clarity gate in one call: strip what an operator can't act on (flag
// dashes, task ids, snake_case) and close the sentence on a whole clause, so
// any title or line borrowed from the queue reaches a human actionable at a
// glance. One sentence in, one operator-ready sentence out — content always
// ships, the gate only changes how it reads.
function clarify(text, max = 160) {
  return finishThought(dejargon(text), max);
}

// The mission loop files a check-off every time it stops instead of
// inventing work; those all say the same thing, so they collapse into one line.
function isCleanStop(item) {
  return /no concrete follow-up|did not start fake work|stopped with reason/i.test(String(item.happened || ''))
    || /^(Mission XP:\s*)?Decide and start the next useful mission/i.test(String(item.title || ''));
}

// Short enough for one iMessage, plain enough to read walking to the car.
// Every line answers: what happened, how big, how we know. It names the work
// because "7 things landed" tells the score, not the story — and it always
// ends with what's waiting and what to do next, because those are the only
// lines that ask anything of the reader.
function composeDigest({ accepted, waiting, landed, project, nextMoves = [], acceptAll = false, reapError = null }) {
  const lines = [];
  lines.push(`atris ${project}: yesterday`);
  const autoCount = accepted.auto.length;
  const humanCount = accepted.human.length;
  if (autoCount > 0) {
    // Three results, air between them, the rest on ask: the whole message
    // fits a laptop screen with no scrolling. Reading it is one glance.
    const stops = accepted.auto.filter(isCleanStop);
    const work = accepted.auto
      .filter((item) => !isCleanStop(item))
      .map((item) => ({ item, line: digestLine(item) }));
    // Operator-ready sentences lead; rough ones get de-jargoned and still
    // shown. An empty report is the one thing a report must never be.
    const ready = work.filter(({ line }) => operatorReady(line));
    const rough = work.filter(({ line }) => !operatorReady(line))
      .map(({ item, line }) => ({ item, line: dejargon(line) }));
    const visibleWork = [...ready, ...rough].slice(0, 3);
    const held = Math.max(0, work.length - visibleWork.length) + (stops.length > 0 ? 1 : 0);
    if (visibleWork.length > 0) {
      // The header states the actual bar: under accept-all the claim
      // "verified twice" would be a lie the operator builds trust on.
      lines.push(acceptAll
        ? 'landed on their own (protected lanes held back for you):'
        : 'landed on their own (verified twice, proof on file):');
      for (const { item, line } of visibleWork) {
        lines.push('');
        lines.push(`- ${line || item.ref}${item.member ? ` (${item.member})` : ''}`);
      }
      lines.push('');
      if (held > 0) lines.push(`${plur(held, 'more result')} when you want them: atris autoland digest`);
    }
  }
  if (autoCount + humanCount === 0) lines.push('nothing finished in the last day');
  if (waiting.length > 0) {
    // The only lines that ask the reader to act, so they name what's asking.
    lines.push(`waiting on you (approve or bounce: atris task reviews):`);
    for (const item of waiting.slice(0, 2)) {
      lines.push(`- ${finishThought(dejargon(item.title), 140)}${item.hours >= 12 ? ` (${item.hours}h)` : ''}`);
    }
    if (waiting.length > 2) lines.push(`- and ${waiting.length - 2} more`);
  } else {
    lines.push('waiting on you: nothing');
  }
  if (landed && landed.branches > 0) {
    lines.push(`in the air: ${plur(landed.branches, 'piece')}${landed.due > 0 ? `, ${landed.due} overdue` : ', all fresh'} (atris land)`);
  }
  if (reapError) lines.push(`cleanup trouble: the daily sweep failed (${reapError}) — run: atris land --reap`);
  // nextMoves: array of {title, owner}, or {moves, unexplained} where
  // unexplained counts queue items whose sentence carries no operator why.
  // Those are counted, not shown — a raw title the reader can't act on is
  // noise here and a writing bug at its source.
  const nextInfo = Array.isArray(nextMoves)
    ? { moves: nextMoves, unexplained: 0 }
    : (nextMoves || { moves: [], unexplained: 0 });
  const moves = (nextInfo.moves || []).filter((move) => move && move.title).slice(0, 3);
  const unexplained = Number(nextInfo.unexplained || 0);
  if (moves.length > 0) {
    lines.push('next, if you agree:');
    for (const move of moves) {
      lines.push(`- ${finishThought(move.title, 140)}${move.owner ? ` (best fit: ${move.owner})` : ''}`);
    }
    if (unexplained > 0) lines.push(`- ${plur(unexplained, 'more idea')} that can't explain themselves yet (atris now)`);
  } else if (unexplained > 0) {
    lines.push(`${plur(unexplained, 'idea')} in the queue can't explain themselves yet (atris now)`);
  }
  if (!lines.some((line) => line.includes('atris autoland digest'))) {
    lines.push('the full story: atris autoland digest');
  }
  return lines.join('\n');
}

// The moment something lands, the operator hears it in one glance: the
// landing sentence each piece wrote for a day-one PM at finish time, its
// author, nothing else. Rough sentences get de-jargoned, never hidden.
function composeLiveUpdate({ landedRefs, tasks, project }) {
  const byRef = new Map((tasks || []).map((t) => [String(t.display_id || t.legacy_ref || t.id), t]));
  const items = (landedRefs || []).map((ref) => {
    const t = byRef.get(String(ref));
    if (!t) return { title: String(ref) };
    return {
      ref: String(ref),
      title: String(t.title || '').slice(0, 200),
      happened: String(t.review?.landing?.happened || t.metadata?.landing_happened || '').slice(0, 300),
      member: String(t.claimed_by || t.assigned_to || '').trim(),
    };
  }).filter((item) => !isCleanStop(item));
  if (!items.length) return '';
  const lines = [`atris ${project}: just landed`];
  for (const item of items.slice(0, 3)) {
    const raw = digestLine(item);
    const line = operatorReady(raw) ? raw : dejargon(raw);
    lines.push('');
    lines.push(`- ${finishThought(line, 160)}${item.member ? ` (${item.member})` : ''}`);
  }
  if (items.length > 3) {
    lines.push('');
    lines.push(`and ${plur(items.length - 3, 'more piece')}: atris autoland digest`);
  }
  return lines.join('\n');
}

function composeAlarm({ waiting, project, alarmHours }) {
  const worst = waiting[0];
  return [
    `atris ${project}: ${plur(waiting.length, 'piece')} of finished work ${waiting.length === 1 ? 'has' : 'have'} been waiting on you for over ${alarmHours}h`,
    `oldest: ${worst.ref} (${worst.hours}h) — ${worst.title}`,
    'approve or bounce: atris task reviews',
  ].join('\n');
}

// Alarm dedupe: a task pings at most once per alarm window.
function dueForAlarm(waiting, state, { alarmHours = DEFAULT_ALARM_HOURS, now = Date.now() } = {}) {
  const due = [];
  for (const item of waiting) {
    if (item.hours < alarmHours) continue;
    const lastAlert = Date.parse(state.alerts[item.ref] || '') || 0;
    if (now - lastAlert < alarmHours * 3600000) continue;
    due.push(item);
  }
  return due;
}

function markAlerted(state, items, now = Date.now()) {
  for (const item of items) state.alerts[item.ref] = new Date(now).toISOString();
  return state;
}

function sendImessage(root, to, text) {
  const bin = path.join(root, 'bin', 'atris.js');
  const argv = fs.existsSync(bin)
    ? [process.execPath, [bin, 'imessage', 'send', '--to', to, '--text', text, '--approved']]
    : ['atris', ['imessage', 'send', '--to', to, '--text', text, '--approved']];
  const result = spawnSync(argv[0], argv[1], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return { ok: result.status === 0, output: String(result.stdout || result.stderr || '').trim().slice(0, 300) };
}

module.exports = {
  DEFAULT_ALARM_HOURS,
  DEFAULT_DIGEST_HOUR,
  acceptedInLastDay,
  buildCronLine,
  clarify,
  composeAlarm,
  composeDigest,
  composeLiveUpdate,
  cronInstalled,
  cronMarker,
  dueForAlarm,
  installCron,
  liveAcceptAuthorization,
  markAlerted,
  operatorReady,
  hasAgentJargon,
  policyPath,
  readPolicy,
  readState,
  sendImessage,
  statePath,
  uninstallCron,
  waitingHours,
  waitingOnHuman,
  writePolicy,
  writeState,
};
