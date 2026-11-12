'use strict';

// atris morning [--business <id>] [--agent <id>] [--json]
// Prints the morning receipt from the last finished night shift (GET /morning).

const { parseFlags, wantsHelp, resolveTarget, errorText } = require('../lib/night-shift');

const NO_SHIFT = 'No night shift finished yet.';
const NOT_LOGGED_IN = 'not logged in. run: atris login';

function showMorningHelp(log = console.log) {
  log('usage: atris morning [--business <id>] [--agent <id>] [--json]');
  log('');
  log('What your agent did last night: what it read, what it made, who it met,');
  log('and what it spent. Start a night with: atris night "<goal>"');
  log('');
  log('  --business <id>    Receipt for this business (id or connected slug)');
  log('  --agent <id>       Receipt for this agent (default: the agent you joined as)');
  log('  --json             Print the raw receipt as JSON');
}

async function morningCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  if (wantsHelp(args)) {
    showMorningHelp(log);
    return 0;
  }

  const { flags } = parseFlags(args, ['--business', '--agent'], ['--json']);
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
  log(text || NO_SHIFT);
  return 0;
}

module.exports = { morningCommand, showMorningHelp, NO_SHIFT };
