'use strict';

// atris night "<goal>" [--cap <usd>] [--business <id>] [--agent <id>] [--watch]
// Starts a night shift on the home computer (POST /night-shift). The shift
// stops on its own when it reaches the dollar cap.

const {
  parseFlags,
  wantsHelp,
  formatUsd,
  resolveTarget,
  errorText,
} = require('../lib/night-shift');

const DEFAULT_CAP_USD = 1;
const POLL_MS = 60 * 1000;
const FINAL_STATUSES = new Set(['capped', 'done', 'failed']);
const MAX_POLL_FAILURES = 5;
const NOT_LOGGED_IN = 'not logged in. run: atris login';

function showNightHelp(log = console.log) {
  log('usage: atris night "<goal>" [--cap <usd>] [--business <id>] [--agent <id>] [--watch]');
  log('');
  log('Give your agent a goal for tonight. It works on its home computer and');
  log('stops when it has spent the cap. Read what it did with: atris morning');
  log('');
  log('  --cap <usd>        Most it may spend tonight, in dollars (default 1)');
  log('  --business <id>    Run for this business (id or connected slug)');
  log('  --agent <id>       Run as this agent (default: the agent you joined as)');
  log('  --watch            Stay open and print each step until the shift ends');
}

function parseCap(raw) {
  if (raw === undefined) return { ok: true, cap: DEFAULT_CAP_USD };
  const text = String(raw).trim().replace(/^\$/, '');
  const cap = text === '' ? NaN : Number(text);
  if (!Number.isFinite(cap) || cap <= 0) return { ok: false };
  return { ok: true, cap };
}

function formatStart(startsAt, now = new Date()) {
  const when = startsAt ? new Date(startsAt) : null;
  if (!when || Number.isNaN(when.getTime())) return startsAt ? String(startsAt) : 'once the computer is free';
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = when.toDateString() === now.toDateString();
  if (sameDay) return time;
  const day = when.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${time} ${day}`;
}

function shiftFrom(data) {
  if (!data || typeof data !== 'object') return {};
  return data.shift && typeof data.shift === 'object' ? data.shift : data;
}

function eventsFrom(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.events)) return data.events;
  const shift = shiftFrom(data);
  return Array.isArray(shift.events) ? shift.events : [];
}

function eventKey(event, index) {
  if (event && typeof event === 'object' && (event.id || event.event_id)) return String(event.id || event.event_id);
  return `#${index}`;
}

function eventLine(event) {
  if (!event || typeof event !== 'object') return String(event);
  const at = event.at || event.created_at || event.ts || event.timestamp;
  const parsed = at ? new Date(at) : null;
  const time = parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  const what = event.message || event.text || event.summary || event.detail || event.kind || event.type || 'step';
  const spent = event.spent_usd != null ? ` (${formatUsd(event.spent_usd)} so far)` : '';
  const line = `${String(what).replace(/\s+/g, ' ').trim()}${spent}`;
  return time ? `${time}  ${line}` : line;
}

function finalLine(shift) {
  const status = String(shift.status || 'done');
  const spent = formatUsd(shift.spent_usd || 0);
  const cap = formatUsd(shift.cap_usd || 0);
  if (status === 'capped') return `The shift stopped at its cap. Spent ${spent} of ${cap}. Read it with: atris morning`;
  if (status === 'failed') return `The shift failed after spending ${spent} of ${cap}.`;
  return `The shift is done. Spent ${spent} of ${cap}. Read it with: atris morning`;
}

async function watchShift(shiftId, ctx) {
  const { request, token, log, err, sleep, pollMs } = ctx;
  const seen = new Set();
  let failures = 0;
  for (;;) {
    const result = await request(`/night-shift/${encodeURIComponent(shiftId)}`, { method: 'GET', token });
    if (!result || !result.ok) {
      failures += 1;
      err(`Could not check the shift: ${errorText(result)}`);
      if (failures >= MAX_POLL_FAILURES) return 1;
    } else {
      failures = 0;
      const events = eventsFrom(result.data);
      events.forEach((event, index) => {
        const key = eventKey(event, index);
        if (seen.has(key)) return;
        seen.add(key);
        log(eventLine(event));
      });
      const shift = shiftFrom(result.data);
      const status = String(shift.status || '').toLowerCase();
      if (FINAL_STATUSES.has(status)) {
        log(finalLine({ ...shift, status }));
        return status === 'failed' ? 1 : 0;
      }
    }
    await sleep(pollMs);
  }
}

async function nightCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  if (wantsHelp(args)) {
    showNightHelp(log);
    return 0;
  }

  const { flags, positionals } = parseFlags(args, ['--cap', '--business', '--agent'], ['--watch']);
  const goal = positionals.join(' ').trim();
  if (!goal) {
    err('Say what to learn tonight. Example: atris night "learn how our refunds work" --cap 1');
    return 1;
  }
  const capCheck = parseCap(flags.cap);
  if (!capCheck.ok) {
    err('The cap must be more than $0. Example: --cap 1');
    return 1;
  }

  const load = deps.loadCredentials || require('../utils/auth').loadCredentials;
  const request = deps.apiRequestJson || require('../utils/api').apiRequestJson;
  const creds = await load(request);
  const token = creds && typeof creds.token === 'string' ? creds.token.trim() : '';
  if (!token) {
    err(NOT_LOGGED_IN);
    return 1;
  }

  const { agentId, businessId } = resolveTarget(flags, creds, deps);
  const body = { goal, cap_usd: capCheck.cap };
  if (agentId) body.agent_id = agentId;
  if (businessId) body.business_id = businessId;

  const result = await request('/night-shift', { method: 'POST', token, body, retries: 0 });
  if (!result || !result.ok) {
    err(`Could not start the night shift: ${errorText(result)}`);
    return 1;
  }
  const data = result.data || {};
  if (!data.shift_id) {
    err('Atris did not return a shift id, so the shift may not have started.');
    return 1;
  }

  log(`Night shift starts at ${formatStart(data.starts_at, deps.now ? deps.now() : new Date())} with a ${formatUsd(capCheck.cap)} cap. Shift ${data.shift_id}.`);

  if (!flags.watch) return 0;
  return watchShift(data.shift_id, {
    request,
    token,
    log,
    err,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pollMs: deps.pollMs != null ? deps.pollMs : POLL_MS,
  });
}

module.exports = { nightCommand, showNightHelp, parseCap, formatStart, eventLine };
