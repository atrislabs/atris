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

// One line per piece, in the work's own words: the landing sentence beats
// the task title, because titles are written for the queue, not for a text.
function digestLine(item) {
  const happened = String(item.happened || '').split(/(?<=[.!?])\s+/)[0] || '';
  const title = String(item.title || '').replace(/^Mission XP:\s*/i, '');
  const source = happened.length >= 12 ? happened : title;
  const line = cutAtWord(source.replace(/[.\s]+$/, ''), 72);
  return line.charAt(0).toLowerCase() + line.slice(1);
}

// The mission loop files a check-off every time it stops instead of
// inventing work; those all say the same thing, so they collapse into one line.
function isCleanStop(item) {
  return /no concrete follow-up|did not start fake work|stopped with reason/i.test(String(item.happened || ''))
    || /^(Mission XP:\s*)?Decide and start the next useful mission/i.test(String(item.title || ''));
}

// Short enough for one iMessage, plain enough to read over coffee — and it
// names the work, because "7 things landed" tells the score, not the story.
function composeDigest({ accepted, waiting, landed, project }) {
  const lines = [];
  lines.push(`atris ${project} daily`);
  const autoCount = accepted.auto.length;
  const humanCount = accepted.human.length;
  if (autoCount > 0) {
    lines.push('got their final sign-off on their own (checked twice, proof on file):');
    const stops = accepted.auto.filter(isCleanStop);
    const work = accepted.auto.filter((item) => !isCleanStop(item));
    for (const item of work.slice(0, 4)) lines.push(`- ${digestLine(item) || item.ref}`);
    if (work.length > 4) lines.push(`- and ${work.length - 4} more`);
    if (stops.length > 0) lines.push(`- ${plur(stops.length, 'check')} that the loop stops cleanly instead of inventing work`);
  }
  if (humanCount > 0) lines.push(`you approved ${plur(humanCount, 'piece')} yourself`);
  if (autoCount + humanCount === 0) lines.push('nothing finished in the last day');
  if (waiting.length > 0) {
    lines.push(`waiting on you: ${waiting.length} (oldest ${waiting[0].hours}h) — atris task reviews`);
  } else {
    lines.push('nothing is waiting on you');
  }
  if (landed && landed.branches > 0) {
    lines.push(`${plur(landed.branches, 'piece')} of work still in the air${landed.due > 0 ? `, ${landed.due} overdue` : ''} — atris land`);
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
