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

function readPolicy(root) {
  const policy = readJson(policyPath(root), null);
  if (!policy || typeof policy !== 'object') return null;
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
      title: String(t.title || '').slice(0, 90),
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
  const happened = String(item.happened || '').split(/(?<=[.!?])\s+/)[0] || '';
  const title = String(item.title || '').replace(/^Mission XP:\s*/i, '');
  const source = happened.length >= 12 ? happened : title;
  const line = cutAtWord(source.replace(/[.\s]+$/, ''), 110);
  return line.charAt(0).toLowerCase() + line.slice(1);
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
function composeDigest({ accepted, waiting, landed, project, nextMoves = [] }) {
  const lines = [];
  lines.push(`atris ${project}: yesterday`);
  const autoCount = accepted.auto.length;
  const humanCount = accepted.human.length;
  if (autoCount > 0) {
    // Three results, air between them, the rest on ask: the whole message
    // fits a laptop screen with no scrolling. Reading it is one glance.
    lines.push('landed on their own (verified twice, proof on file):');
    const stops = accepted.auto.filter(isCleanStop);
    const work = accepted.auto
      .filter((item) => !isCleanStop(item))
      .map((item) => ({ item, line: digestLine(item) }));
    const visibleWork = work.filter(({ line }) => operatorReady(line));
    for (const { item, line } of visibleWork.slice(0, 3)) {
      lines.push('');
      lines.push(`- ${line || item.ref}`);
    }
    const held = Math.max(0, visibleWork.length - 3) + (work.length - visibleWork.length) + (stops.length > 0 ? 1 : 0);
    lines.push('');
    if (held > 0) lines.push(`${plur(held, 'more result')} when you want them: atris autoland digest`);
  }
  if (humanCount > 0) lines.push(`you approved ${plur(humanCount, 'piece')} yourself`);
  if (autoCount + humanCount === 0) lines.push('nothing finished in the last day');
  const byMember = new Map();
  for (const item of [...accepted.auto, ...accepted.human]) {
    if (!item.member || isCleanStop(item)) continue;
    byMember.set(item.member, (byMember.get(item.member) || 0) + 1);
  }
  if (byMember.size > 0) {
    lines.push(`workers: ${Array.from(byMember, ([who, n]) => `${who} landed ${n}`).join(', ')}`);
  }
  if (waiting.length > 0) {
    lines.push(`waiting on you: ${waiting.length} (oldest ${waiting[0].hours}h). approve or bounce: atris task reviews`);
  } else {
    lines.push('waiting on you: nothing');
  }
  if (landed && landed.branches > 0) {
    lines.push(`in the air: ${plur(landed.branches, 'piece')}${landed.due > 0 ? `, ${landed.due} overdue` : ', all fresh'} (atris land)`);
  }
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
      lines.push(`- ${cutAtWord(move.title, 90)}${move.owner ? ` (best fit: ${move.owner})` : ''}`);
    }
    if (unexplained > 0) lines.push(`- ${plur(unexplained, 'more idea')} that can't explain themselves yet (atris now)`);
  } else if (unexplained > 0) {
    lines.push(`${plur(unexplained, 'idea')} in the queue can't explain themselves yet (atris now)`);
  }
  lines.push('the full story: atris autoland digest');
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
  composeAlarm,
  composeDigest,
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
