'use strict';

// atris morning [--business <id>] [--agent <id>] [--json] [--full] [--no-save]
// Prints a short card for the last finished night shift (GET /morning) and
// saves what the agent learned into this project's atris/ folder.

const { parseFlags, wantsHelp, resolveTarget, errorText, cleanText, formatUsd } = require('../lib/night-shift');
const { nightFromMorning, saveLearned, LEARNED_REL, LESSONS_REL } = require('../lib/night-learned');

const NO_SHIFT = 'No night shift finished yet.';
const NOT_LOGGED_IN = 'not logged in. run: atris login';

function showMorningHelp(log = console.log) {
  log('usage: atris morning [--business <id>] [--agent <id>] [--full] [--no-save] [--json]');
  log('');
  log('How your agent\'s last night went: the score, what it learned, and what it');
  log('spent. What it learned is saved in this project\'s atris/ folder, in');
  log(`${LEARNED_REL} (which a new session reads at start) and ${LESSONS_REL}.`);
  log('Start a night with: atris night "<goal>"');
  log('');
  log('  --business <id>    Receipt for this business (id or connected slug)');
  log('  --agent <id>       Receipt for this agent (default: the agent you joined as)');
  log('  --full             Also print the full receipt: what it read, made and met');
  log('  --no-save          Do not write anything into the atris/ folder');
  log('  --json             Print the raw receipt as JSON (saves nothing)');
}

async function morningCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  if (wantsHelp(args)) {
    showMorningHelp(log);
    return 0;
  }

  const { flags } = parseFlags(args, ['--business', '--agent'], ['--json', '--full', '--no-save']);
  const load = deps.loadCredentials || require('../utils/auth').loadCredentials;
  const request = deps.apiRequestJson || require('../utils/api').apiRequestJson;
  const creds = await load(request);
  const token = creds && typeof creds.token === 'string' ? creds.token.trim() : '';
  if (!token) {
    if (flags.json) log(JSON.stringify({ ok: false, error: NOT_LOGGED_IN }));
    else err(NOT_LOGGED_IN);
    return 1;
  }

  const { agentId, businessId } = resolveTarget(flags, creds, deps);
  const query = new URLSearchParams();
  if (businessId) query.set('business_id', businessId);
  if (agentId) query.set('agent_id', agentId);
  const qs = query.toString();
  const result = await request(`/morning${qs ? `?${qs}` : ''}`, { method: 'GET', token });

  const notFound = result && Number(result.status) === 404;
  if (!notFound && (!result || !result.ok)) {
    const message = errorText(result);
    if (flags.json) log(JSON.stringify({ ok: false, error: message, status: result && result.status }));
    else err(`Could not read the morning receipt: ${message}`);
    return 1;
  }

  const data = (!notFound && result.data && typeof result.data === 'object') ? result.data : {};
  const text = typeof data.text === 'string' ? data.text.replace(/\s+$/, '') : '';

  if (flags.json) {
    log(JSON.stringify(notFound ? { text: null, receipt: null } : data, null, 2));
    return 0;
  }
  const night = notFound ? null : nightFromMorning(data);
  if (!night) {
    log(text || NO_SHIFT);
    return 0;
  }

  let saved = null;
  if (!flags['no-save']) saved = (deps.saveLearned || saveLearned)(deps.cwd || process.cwd(), night);
  for (const line of renderCard(night, data, saved)) log(line);
  if (flags.full && text) {
    log('');
    log(text);
  }
  return 0;
}

function headline(night) {
  const goal = `Night on "${night.goal}"`;
  if (night.score === null) return `${goal}: not scored.`;
  const base = `${goal}: ${night.score} of 99`;
  if (!night.known) return `${base}.`;
  if (night.previous === null) return `${base}, first scored night.`;
  // The server leaves the change out when the two nights were scored two
  // different ways, so there is nothing fair to compare.
  if (night.change === null) return `${base}.`;
  if (night.change > 0) return `${base}, up from ${night.previous}.`;
  if (night.change < 0) return `${base}, down from ${night.previous}.`;
  return `${base}, the same as the night before.`;
}

function savedLine(night, saved) {
  if (!saved) return 'Not saved to your folder (--no-save).';
  if (saved.reason === 'no-folder') {
    return 'Nothing saved: there is no atris/ folder here. Run this from your project to keep what it learned.';
  }
  if (saved.reason === 'error') return `Nothing saved: ${cleanText(saved.error, 120)}`;
  if (!night.lines.length) return 'Nothing to save: the night learned nothing new.';
  if (!saved.added) return `Nothing new to save: these notes are already in ${LEARNED_REL}.`;
  const where = saved.lessons ? `${LEARNED_REL} and ${LESSONS_REL}` : LEARNED_REL;
  return `Saved to your folder: ${saved.added} ${saved.added === 1 ? 'note' : 'notes'} (${where})`;
}

function renderCard(night, data, saved) {
  const out = [headline(night)];
  if (night.lines.length) {
    out.push('Learned:');
    for (const text of night.lines.slice(0, 3)) out.push(`- ${text}`);
  } else {
    out.push('Learned: nothing new recorded.');
  }
  if (night.lessons.length) {
    const shown = night.lessons.slice(0, 3).map((name) => `"${name}"`).join(', ');
    const more = night.lessons.length > 3 ? `, and ${night.lessons.length - 3} more` : '';
    out.push(`Used ${night.lessons.length} ${night.lessons.length === 1 ? 'lesson' : 'lessons'}: ${shown}${more}`);
  }
  const receipt = data.receipt || {};
  if (typeof receipt.spent_usd === 'number' && typeof receipt.cap_usd === 'number') {
    out.push(`Spent ${formatUsd(receipt.spent_usd)} of the ${formatUsd(receipt.cap_usd)} cap.`);
  }
  out.push(savedLine(night, saved));
  return out;
}

module.exports = { morningCommand, showMorningHelp, renderCard, NO_SHIFT };
