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
const OPERATOR_WHY = /\b(sav(?:e|es|ing)|burn(?:s|ing)?|wast(?:e|es|ing)|cost(?:s|ing)?|prevent\w*|stop(?:s|ping)?|break(?:s|ing)?|fail(?:s|ing)?|slow(?:s|er)?|faster|cheaper|easier|clearer|safer|simpler|trust|revenue|users?|customers?|operators?|so that|because)\b/i;
const AGENT_JARGON = /[a-z0-9]_[a-z0-9]|\b[a-z]+[A-Z]\w*|--[a-z]|\bCLI-\d+/;
const RESULT_ULID = /[0-9A-HJKMNP-TV-Z]{20,}/;
const RESULT_TICKET = /\b[A-Z]{2,4}-\d+\b/;
const RESULT_FILE_PATH = /\S+\.(js|md|py|json|ts)(:\d+)?/i;
const RESULT_COMMAND = /--|->|\b(?:npm|node|grep|git)\s+/i;
const TRAILING_FRAGMENT_WORDS = new Set([
  'after',
  'and',
  'as',
  'at',
  'because',
  'before',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'over',
  'so',
  'than',
  'that',
  'the',
  'to',
  'under',
  'with',
  'without',
]);

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
  return {
    enabled: true,
    enabled_by: inferOwner(root),
    enabled_at: null,
    daily_experiment: true,
    default: true,
  };
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
      result: String(t.result || t.metadata?.result || '').slice(0, 220),
      tag: String(t.tag || ''),
      hours: waitingHours(t, now),
      member: String(t.claimed_by || t.assigned_to || '').trim(),
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
      result: String(t.result || t.metadata?.result || '').slice(0, 220),
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

function pauseReasonDigestLabel(reason) {
  if (reason === 'auth-required') return 'awaiting login';
  if (reason === 'model-unavailable') return 'awaiting an available model';
  if (reason === 'rate-limit-exceeded-wall') return 'waiting for the rate-limit reset';
  if (reason === 'stale' || reason === 'paused-idle') return 'stale after the idle window';
  return 'paused for operator action';
}

function normalizeReasonTally(value) {
  const tally = {};
  if (!value || typeof value !== 'object') return tally;
  for (const [reason, count] of Object.entries(value)) {
    const cleanReason = String(reason || '').trim();
    const n = Number(count) || 0;
    if (cleanReason && n > 0) tally[cleanReason] = (tally[cleanReason] || 0) + n;
  }
  return tally;
}

function heldReasonTally(janitor) {
  const holds = janitor?.mission_holds && typeof janitor.mission_holds === 'object'
    ? Object.values(janitor.mission_holds)
    : [];
  const tally = {};
  for (const hold of holds) {
    const reason = String(hold?.reason || '').trim();
    if (reason) tally[reason] = (tally[reason] || 0) + 1;
  }
  if (holds.length > 0) return tally;
  return normalizeReasonTally(janitor?.missions_held_reasons);
}

function pushJanitorMissionReasonLines(lines, janitor) {
  const held = heldReasonTally(janitor);
  for (const [reason, count] of Object.entries(held).sort()) {
    lines.push(`held: ${plur(count, 'mission')} ${pauseReasonDigestLabel(reason)} (${reason})`);
  }
  const stopped = normalizeReasonTally(janitor?.mission_stop_reasons || janitor?.missions_stopped_reasons);
  for (const [reason, count] of Object.entries(stopped).sort()) {
    lines.push(`stopped: ${plur(count, 'mission')} ${pauseReasonDigestLabel(reason)} (${reason})`);
  }
}

function pushLandingSweepLines(lines, landingSweep) {
  if (!landingSweep || typeof landingSweep !== 'object') return;
  const stale = Array.isArray(landingSweep.stale) ? landingSweep.stale : [];
  const staleCount = Number(landingSweep.stale_count) || stale.length;
  if (staleCount > 0) {
    const oldest = stale[0];
    const oldestText = oldest
      ? ` oldest ${Number(oldest.activityHours || oldest.ageHours || 0)}h: ${oldest.name}`
      : '';
    lines.push(`stuck in the air past 48h: ${plur(staleCount, 'piece')} needs a human.${oldestText}`);
  }
  const human = Array.isArray(landingSweep.human) ? landingSweep.human : [];
  const humanCount = Number(landingSweep.human_count) || human.length;
  if (humanCount > 0) {
    const first = human[0] ? ` ${finishThought(human[0], 130)}` : '';
    const more = humanCount > 1 ? `; ${humanCount - 1} more` : '';
    lines.push(`cleanup needs a human:${first}${more}`);
  }
}

function pushWaitingWishLines(lines, waitingWishes) {
  const wishes = (Array.isArray(waitingWishes) ? waitingWishes : [])
    .filter((wish) => wish && String(wish.text || '').trim());
  if (!wishes.length) return;
  lines.push(`${plur(wishes.length, 'wish')} waiting on you:`);
  for (const wish of wishes.slice(0, 2)) {
    const text = finishThought(String(wish.text || '').replace(/[.\s]+$/, ''), 90);
    const need = cutAtWord(String(wish.need || 'answer the open question before it can start'), 120);
    lines.push(`- ${text}: ${need}`);
  }
  const hidden = Math.max(0, wishes.length - 2);
  if (hidden > 0) lines.push(`- ${plur(hidden, 'more wish')} waiting on an answer`);
}

function cutAtWord(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}...`;
}

function stripDanglingFragment(text) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  while (out.includes('(') && out.lastIndexOf('(') > out.lastIndexOf(')')) {
    out = out.slice(0, out.lastIndexOf('(')).trim();
  }
  out = out.replace(/[,\s;:]+$/g, '').trim();
  while (out) {
    const withoutPunctuation = out.replace(/[.!?]+$/g, '').trim();
    const word = (withoutPunctuation.match(/[A-Za-z]+$/) || [''])[0].toLowerCase();
    if (!TRAILING_FRAGMENT_WORDS.has(word)) break;
    out = withoutPunctuation.slice(0, Math.max(0, withoutPunctuation.length - word.length)).replace(/[,\s;:]+$/g, '').trim();
  }
  return out;
}

// A line ends where a thought ends. Long lines close at their last complete
// clause inside the budget and read whole: no ellipsis, nothing dangling.
// Only when a line has no clause boundary at all does a word cut remain.
function finishThought(text, max = 160) {
  const clean = stripDanglingFragment(String(text || '').replace(/\s+/g, ' ').trim().replace(/[,;:\s]+$/, ''));
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > max * 0.3) return stripDanglingFragment(cut.slice(0, sentence + 1));
  const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' ('), cut.lastIndexOf(': '));
  if (clause > max * 0.45) return stripDanglingFragment(cut.slice(0, clause));
  const space = cut.lastIndexOf(' ');
  return stripDanglingFragment(cut.slice(0, space > max * 0.6 ? space : max));
}

function digestMoveLine(move) {
  if (move.kind === 'mission_ready') {
    return 'Review the finished mission proof so accepted work can leave the queue';
  }
  return `${finishThought(move.title, 140)}${move.owner ? ` (best fit: ${move.owner})` : ''}`;
}

function operatorReady(text) {
  const value = String(text || '');
  return OPERATOR_WHY.test(value) && !AGENT_JARGON.test(value);
}

function hasAgentJargon(text) {
  return AGENT_JARGON.test(String(text || ''));
}

function explainResult(text) {
  const raw = String(text || '');
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, reason: 'result must say what someone can do now and why it matters.' };
  if (raw.includes('\n') || raw.includes('\r')) return { ok: false, reason: 'result must be one sentence, not a paragraph.' };
  if (value.length < 30) return { ok: false, reason: 'result is too short to explain what changed for a human.' };
  if (value.length > 180) return { ok: false, reason: 'result must stay under 180 characters so it survives briefs.' };
  if (!/[.!?]$/.test(value)) return { ok: false, reason: 'result must end as a complete sentence with a period, question mark, or exclamation point.' };
  const sentenceStops = value.match(/[.!?]/g) || [];
  if (sentenceStops.length !== 1) return { ok: false, reason: 'result must be exactly one complete sentence.' };
  if (RESULT_ULID.test(value)) return { ok: false, reason: 'result should explain the gain, not include database ids.' };
  if (RESULT_TICKET.test(value)) return { ok: false, reason: 'result should not include ticket ids.' };
  if (RESULT_FILE_PATH.test(value)) return { ok: false, reason: 'result should not include file paths.' };
  if (RESULT_COMMAND.test(value)) return { ok: false, reason: 'result should not include command syntax or flags.' };
  const finalWord = (value.replace(/[.!?]+$/g, '').match(/[A-Za-z]+$/) || [''])[0].toLowerCase();
  if (TRAILING_FRAGMENT_WORDS.has(finalWord)) return { ok: false, reason: 'result ends mid-thought; finish the sentence with the actual human gain.' };
  if (!operatorReady(value)) {
    return { ok: false, reason: 'result needs a plain operator why: say who can do what now, and why it saves time, reduces risk, increases trust, or helps users.' };
  }
  return { ok: true, reason: null };
}

// One line per piece, in the work's own words: the landing sentence beats
// the task title, because titles are written for the queue, not for a text.
// The cut is generous on purpose: a specific sentence the reader trusts
// (what happened + how big + how we know) beats a short one they must chase.
function digestLine(item) {
  const result = String(item.result || '').replace(/^completed:\s*/i, '').split(/(?<=[.!?])\s+/)[0] || '';
  const happened = String(item.happened || '').replace(/^completed:\s*/i, '').split(/(?<=[.!?])\s+/)[0] || '';
  const title = clarify(String(item.title || '').replace(/^Mission XP:\s*/i, ''));
  const source = result.length >= 12 ? result : (happened.length >= 12 && operatorReady(happened) ? happened : (operatorReady(title) ? title : ''));
  if (!source) return '';
  const line = finishThought(source.replace(/[.\s]+$/, ''), 160);
  return line.charAt(0).toLowerCase() + line.slice(1);
}

function unexplainedSummaryRows(items, label) {
  const groups = new Map();
  for (const entry of items || []) {
    const member = String(entry.item?.member || '').trim();
    groups.set(member, (groups.get(member) || 0) + 1);
  }
  return [...groups.entries()].map(([member, count]) => {
    const who = member ? ` from ${member}` : '';
    return `${count} more ${label}${who} that could not explain themselves yet`;
  });
}

function missionDigestLine(mission, max = 160) {
  const visibleGoal = mission?.visible_goal?.desired_objective
    || mission?.goal?.visible_goal?.desired_objective
    || (typeof mission?.visible_goal === 'string' ? mission.visible_goal : '');
  const objective = visibleGoal || mission?.objective || '';
  return finishThought(clarify(objective, max), max);
}

// Some older surfaces still need a readable fallback for rough text, but the
// digest paths above now hide agent-speak until a result sentence exists.
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
function composeDigest({ accepted, waiting, waitingWishes = [], landed, project, nextMoves = [], acceptAll = false, reapError = null, janitor = null, landingSweep = null }) {
  const lines = [];
  lines.push(`atris ${project}: yesterday`);
  const autoCount = accepted.auto.length;
  const humanCount = accepted.human.length;
  const wishWaits = (Array.isArray(waitingWishes) ? waitingWishes : [])
    .filter((wish) => wish && String(wish.text || '').trim());
  if (autoCount > 0) {
    // Three results, air between them, the rest on ask: the whole message
    // fits a laptop screen with no scrolling. Reading it is one glance.
    const stops = accepted.auto.filter(isCleanStop);
    const work = accepted.auto
      .filter((item) => !isCleanStop(item))
      .map((item) => ({ item, line: digestLine(item) }));
    const ready = work.filter(({ line }) => line && operatorReady(line));
    const unexplainedWork = work.filter(({ line }) => !line || !operatorReady(line));
    const visibleWork = ready.slice(0, 3);
    const held = Math.max(0, ready.length - visibleWork.length) + (stops.length > 0 ? 1 : 0);
    if (visibleWork.length > 0) {
      // The header states the actual bar: under accept-all the claim
      // "verified twice" would be a lie the operator builds trust on.
      lines.push(acceptAll
        ? `${autoCount} landed (${ready.length} explained), protected lanes held back for you:`
        : `${autoCount} landed (${ready.length} explained), verified twice with proof on file:`);
      for (const { item, line } of visibleWork) {
        lines.push('');
        lines.push(`- ${line || item.ref}${item.member ? ` (${item.member})` : ''}`);
      }
      lines.push('');
      if (held > 0) lines.push(`${plur(held, 'more result')} when you want them: atris autoland digest`);
    } else {
      lines.push(`${autoCount} landed (0 explained), verified proof on file:`);
    }
    for (const row of unexplainedSummaryRows(unexplainedWork, 'landed')) lines.push(row);
  }
  if (autoCount + humanCount === 0) lines.push('nothing finished in the last day');
  if (waiting.length > 0) {
    // The only lines that ask the reader to act, so they name what's asking.
    const waitingWork = waiting.map((item) => ({ item, line: digestLine(item) }));
    const explainedWaiting = waitingWork.filter(({ line }) => line && operatorReady(line));
    const unexplainedWaiting = waitingWork.filter(({ line }) => !line || !operatorReady(line));
    lines.push(`waiting on you (${explainedWaiting.length} explained/${waiting.length} total; approve or bounce: atris task reviews):`);
    for (const { item, line } of explainedWaiting.slice(0, 2)) {
      lines.push(`- ${finishThought(line, 140)}${item.hours >= 12 ? ` (${item.hours}h)` : ''}`);
    }
    for (const row of unexplainedSummaryRows(unexplainedWaiting, 'in review')) lines.push(`- ${row}`);
    const hiddenWaiting = Math.max(0, explainedWaiting.length - 2);
    if (hiddenWaiting > 0) lines.push(`- ${hiddenWaiting} more explained in review`);
  } else if (wishWaits.length === 0) {
    lines.push('waiting on you: nothing');
  }
  pushWaitingWishLines(lines, wishWaits);
  if (landed && landed.branches > 0) {
    lines.push(`in the air: ${plur(landed.branches, 'piece')}${landed.due > 0 ? `, ${landed.due} overdue` : ', all fresh'} (atris land)`);
  }
  if (reapError) lines.push(`cleanup trouble: the landing sweep failed (${reapError}) - run: atris land --reap`);
  pushLandingSweepLines(lines, landingSweep);
  // The janitor's day in one line: stale paused missions stopped and merged
  // worktrees cleared since the last digest. Silence when it did nothing.
  const missionsStopped = Number(janitor?.missions_stopped) || 0;
  const worktreesReaped = Number(janitor?.worktrees_reaped) || 0;
  if (janitor) pushJanitorMissionReasonLines(lines, janitor);
  if (missionsStopped > 0 || worktreesReaped > 0) {
    lines.push(`tidied up: ${plur(missionsStopped, 'stale mission')} stopped, ${plur(worktreesReaped, 'merged worktree')} cleared`);
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
      lines.push(`- ${digestMoveLine(move)}`);
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
      result: String(t.result || t.metadata?.result || '').slice(0, 220),
      happened: String(t.review?.landing?.happened || t.metadata?.landing_happened || '').slice(0, 300),
      member: String(t.claimed_by || t.assigned_to || '').trim(),
    };
  }).filter((item) => !isCleanStop(item));
  if (!items.length) return '';
  const lines = [`atris ${project}: just landed`];
  const work = items.map((item) => ({ item, line: digestLine(item) }));
  const ready = work.filter(({ line }) => line && operatorReady(line));
  const unexplained = work.filter(({ line }) => !line || !operatorReady(line));
  for (const { item, line } of ready.slice(0, 3)) {
    lines.push('');
    lines.push(`- ${finishThought(line, 160)}${item.member ? ` (${item.member})` : ''}`);
  }
  for (const row of unexplainedSummaryRows(unexplained, 'landed')) {
    lines.push('');
    lines.push(row);
  }
  if (ready.length > 3) {
    lines.push('');
    lines.push(`and ${plur(ready.length - 3, 'more piece')}: atris autoland digest`);
  }
  return lines.join('\n');
}

function composeAlarm({ waiting, project, alarmHours }) {
  const worst = waiting[0];
  return [
    `atris ${project}: ${plur(waiting.length, 'piece')} of finished work ${waiting.length === 1 ? 'has' : 'have'} been waiting on you for over ${alarmHours}h`,
    `oldest: ${worst.ref} (${worst.hours}h), ${worst.title}`,
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
  explainResult,
  installCron,
  liveAcceptAuthorization,
  markAlerted,
  missionDigestLine,
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
