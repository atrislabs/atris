'use strict';

// atris agent always-on: an owner turns on timed check-ins for one agent,
// reads what they cost, or turns them off. Backend: /api/agent/{id}/always-on
// (POST turns on or updates in place, GET reads the bill, DELETE turns off).
// The server checks that the caller owns the agent.

const { apiRequestJson } = require('../utils/api');
const { oneLine } = require('../lib/developer-api');
const { parseArgs, loginToken } = require('../lib/business-target');
const { resolveAgentRef } = require('./agent-home');

const MIN_MINUTES = 15;
const MAX_MINUTES = 1440;
const MIN_CAP = 4;
const MAX_CAP = 2000;
const MAX_WATCH = 2000;
const DEFAULT_ACTED_CREDITS = 4;
const RECENT_SHOWN = 10;

const OUTCOME_WORDS = { quiet: 'quiet', acted: 'did work', failed: 'failed', paused: 'paused by the limit' };

function alwaysOnHelp(log = console.log) {
  log(`usage: atris agent always-on <agent> [--every 30m|1h|4h|<minutes>] [--watch "<what to look out for>"] [--cap <credits a day>] [--no-followups]
       atris agent always-on status <agent> [--days N]
       atris agent always-on off <agent>

Turn on: the agent checks in on its own every so often (15 minutes to 24 hours, 30 minutes if you leave it off).
  --watch tells it what to look out for. --cap is the most it may spend in a day, 4 to 2000 credits (40 if you leave it off).
  --no-followups stops it from setting its own extra check-ins; --followups lets it again.
  Running it again changes the settings and keeps the history.
status: is it on, what it spent today, and the bill for the last N days (1 to 30, 1 if you leave it off).
off: stops the timer and cancels the follow-ups it set for itself. The bill is kept.

<agent> is an agent id, or a name saved by spawn. 1 credit is 1 cent.
--json prints the server's answer for scripts. Uses your sign-in (atris login).`);
}

// "30m", "1h", "4h", "90" -> minutes, or null when it is not a length of time.
function parseEvery(text) {
  const raw = String(text == null ? '' : text).trim().toLowerCase();
  let match = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes)?$/);
  if (match) return Number(match[1]);
  match = raw.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)$/);
  if (match) return Math.round(Number(match[1]) * 60);
  return null;
}

function checkEvery(text) {
  const minutes = parseEvery(text);
  if (minutes === null) return { error: '--every takes a length of time like 30m, 1h, 4h, or a number of minutes like 90' };
  if (minutes < MIN_MINUTES) return { error: 'the agent can check in at most every 15 minutes. use --every 15m or more' };
  if (minutes > MAX_MINUTES) return { error: 'the agent has to check in at least once a day. use --every 24h or less' };
  return { minutes };
}

function wholeNumberIn(text, low, high) {
  const raw = String(text).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= low && n <= high ? n : null;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function pace(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return '';
  if (m === 60) return 'every hour';
  if (m % 60 === 0) return `every ${m / 60} hours`;
  return `every ${m} minutes`;
}

function dollars(credits) {
  return `$${(Number(credits || 0) / 100).toFixed(2)}`;
}

// 4 -> "4 cents", 150 -> "$1.50"
function money(credits) {
  const n = Number(credits || 0);
  return n < 100 ? plural(n, 'cent') : dollars(n);
}

function ourCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return '';
  if (n > 0 && n < 0.01) return 'under $0.01';
  return `$${n.toFixed(2)}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// An ISO time in the person's own time zone: "today 3:05 PM", "Nov 14, 3:05 PM".
function localTime(iso, now = new Date()) {
  const at = new Date(iso || '');
  if (!iso || Number.isNaN(at.getTime())) return '';
  const clock = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay(at, now)) return `today ${clock}`;
  const yesterday = new Date(now.getTime() - 86400000);
  if (sameDay(at, yesterday)) return `yesterday ${clock}`;
  const tomorrow = new Date(now.getTime() + 86400000);
  if (sameDay(at, tomorrow)) return `tomorrow ${clock}`;
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${clock}`;
}

function shortNote(text, max = 80) {
  const line = oneLine(text || '');
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

// "My Agent" -> "\"My Agent\"" so the hint can be pasted back as one word.
function shellWord(text) {
  const s = String(text);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function detailOf(res) {
  const data = res && res.data;
  const detail = data && typeof data === 'object' ? (data.detail || data.error || data.message) : null;
  if (typeof detail === 'string') return detail;
  if (detail) return oneLine(detail);
  return typeof (res && res.error) === 'string' ? res.error : '';
}

// The server's refusal in one plain sentence.
function refusal(res, label) {
  if (!res || res.status === 0) return 'Could not reach the Atris server. Check your connection and try again.';
  if (res.status === 401) return 'You are not signed in. Run: atris login';
  if (res.status === 403) return `${label} is not your agent. Only its owner can do this.`;
  if (res.status === 404 || res.status === 405) {
    const detail = detailOf(res).trim();
    // FastAPI answers "Not Found" when the route itself does not exist yet.
    if (res.status === 405 || !detail || /^not found$/i.test(detail)) return 'This needs the newest Atris server. Try again in a few minutes.';
    return `Could not find an agent called ${label}. Check the name, or use its id.`;
  }
  if (res.status >= 500) return `The Atris server had a problem (${res.status}). Try again in a few minutes.`;
  const detail = oneLine(detailOf(res));
  return detail ? `The server said no: ${detail}` : `The server said no (${res.status}).`;
}

function actedCredits(data) {
  for (const key of ['acted_credits', 'credits_per_check_in', 'check_in_credits']) {
    const n = Number(data && data[key]);
    if (data && data[key] != null && Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_ACTED_CREDITS;
}

function printOn(data, ref, label, log, now) {
  const name = data.name || label;
  log(`${name} is on. It checks in ${pace(data.every_minutes) || 'on a timer'}.`);
  if (data.watch) log(`It looks out for: ${shortNote(data.watch, 200)}`);
  const price = actedCredits(data);
  log(`A quiet check-in is free. A check-in where it does work costs ${plural(price, 'credit')} (${money(price)}).`);
  if (data.daily_cap_credits != null) log(`Daily limit: ${plural(Number(data.daily_cap_credits), 'credit')}. It stops for the day when it gets there.`);
  log(data.followups === false ? 'Follow-ups are off. It only checks in on the timer.' : 'It can also set its own follow-up check-ins.');
  const next = localTime(data.next_check_in, now);
  if (next) log(`Next check-in: ${next}.`);
  log(`See the bill: atris agent always-on status ${shellWord(ref)}`);
}

function windowName(days) {
  const n = Number(days) || 1;
  return n === 1 ? 'Last 24 hours' : `Last ${n} days`;
}

function printStatus(data, ref, label, log, now) {
  const name = data.name || label;
  if (data.on) {
    log(`${name} is on. It checks in ${pace(data.every_minutes) || 'on a timer'}.`);
    if (data.watch) log(`It looks out for: ${shortNote(data.watch, 200)}`);
    const next = localTime(data.next_check_in, now);
    if (next) log(`Next check-in: ${next}.`);
  } else {
    log(`${name} is off. It does not check in on its own.`);
  }
  const last = localTime(data.last_check_in, now);
  if (last) log(`Last check-in: ${last}.`);

  const today = data.today || {};
  const spent = Number(today.credits || 0);
  if (today.cap_credits != null) {
    const left = today.remaining_credits != null ? Number(today.remaining_credits) : Math.max(0, Number(today.cap_credits) - spent);
    log(`Today: ${spent} of ${plural(Number(today.cap_credits), 'credit')} used, ${left} left.`);
  } else {
    log(`Today: ${plural(spent, 'credit')} used.`);
  }
  if (today.paused_by_cap) log('It hit the daily limit, so it stopped for today. It starts again tomorrow.');

  const bill = data.bill || {};
  const checkIns = Number(bill.check_ins || 0);
  log('');
  if (!checkIns) {
    log(`${windowName(bill.days)}: no check-ins.`);
  } else {
    log(`${windowName(bill.days)}: ${plural(checkIns, 'check-in')}.`);
    const parts = [`${Number(bill.quiet || 0)} quiet`, `${Number(bill.acted || 0)} did work`];
    if (Number(bill.failed || 0)) parts.push(`${Number(bill.failed)} failed`);
    if (Number(bill.paused || 0)) parts.push(`${Number(bill.paused)} paused by the limit`);
    log(`${parts.join(', ')}.`);
  }
  log(`Total: ${plural(Number(bill.credits || 0), 'credit')} (${dollars(bill.credits)}).`);
  if (Object.prototype.hasOwnProperty.call(bill, 'raw_cost_usd') && ourCost(bill.raw_cost_usd)) {
    log(`Our cost: ${ourCost(bill.raw_cost_usd)} (staff only).`);
  }

  const recent = Array.isArray(bill.recent) ? bill.recent.slice(0, RECENT_SHOWN) : [];
  if (recent.length) {
    log('');
    log('Newest check-ins:');
    for (const item of recent) {
      if (!item || typeof item !== 'object') continue;
      const bits = [localTime(item.at, now) || 'unknown time', OUTCOME_WORDS[item.outcome] || String(item.outcome || 'unknown'), plural(Number(item.credits || 0), 'credit')];
      const note = shortNote(item.note);
      if (note) bits.push(note);
      log(`  ${bits.join('  |  ')}`);
    }
  }
}

async function agentAlwaysOnCommand(args = [], deps = {}) {
  let secret = '';
  const hide = (line) => (secret ? String(line).split(secret).join('[hidden]') : String(line));
  const log = (line) => (deps.log || console.log)(hide(line));
  const err = (line) => (deps.err || console.error)(hide(line));
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;
  const now = deps.now ? new Date(deps.now) : new Date();

  const { flags, pos, error } = parseArgs(args, {
    switches: ['no_followups', 'followups'],
    values: ['every', 'watch', 'cap', 'days'],
  });
  if (flags.help || pos[0] === 'help') { alwaysOnHelp(log); return 0; }
  if (error) { err(`${error}. see: atris agent always-on --help`); return 1; }

  const verb = pos[0] === 'status' || pos[0] === 'off' ? pos[0] : 'on';
  const words = verb === 'on' ? pos : pos.slice(1);
  const usage = verb === 'on' ? 'atris agent always-on <agent>' : `atris agent always-on ${verb} <agent>`;
  if (!words.length) {
    if (verb === 'on') { alwaysOnHelp(log); return 1; }
    err(`name the agent, like: ${usage}`);
    return 1;
  }
  if (words.length > 1) { err(`${usage} takes one agent, got: ${words.join(' ')}`); return 1; }

  const onlyOn = ['every', 'watch', 'cap', 'no_followups', 'followups'].filter((key) => flags[key] !== undefined);
  if (verb !== 'on' && onlyOn.length) {
    err(`--${onlyOn[0].replace(/_/g, '-')} is for turning it on. use: atris agent always-on <agent> --${onlyOn[0].replace(/_/g, '-')} ...`);
    return 1;
  }
  if (verb !== 'status' && flags.days !== undefined) { err('--days is for reading the bill. use: atris agent always-on status <agent> --days N'); return 1; }

  const body = {};
  let days = 1;
  if (verb === 'on') {
    if (flags.every !== undefined) {
      const every = checkEvery(flags.every);
      if (every.error) { err(every.error); return 1; }
      body.every_minutes = every.minutes;
    }
    if (flags.watch !== undefined) {
      const watch = String(flags.watch).trim();
      if (watch.length > MAX_WATCH) { err(`--watch is too long: keep it under ${MAX_WATCH} characters (it has ${watch.length})`); return 1; }
      body.watch = watch;
    }
    if (flags.cap !== undefined) {
      const cap = wholeNumberIn(flags.cap, MIN_CAP, MAX_CAP);
      if (cap === null) { err('--cap is the most it may spend in a day: a whole number of credits from 4 to 2000'); return 1; }
      body.daily_cap_credits = cap;
    }
    if (flags.no_followups && flags.followups) { err('pick one: --followups or --no-followups'); return 1; }
    if (flags.no_followups) body.followups = false;
    if (flags.followups) body.followups = true;
  } else if (verb === 'status' && flags.days !== undefined) {
    days = wholeNumberIn(flags.days, 1, 30);
    if (days === null) { err('--days takes a whole number from 1 to 30'); return 1; }
  }

  const ref = words[0];
  const token = await loginToken(deps);
  if (!token) { err('You are not signed in. Run: atris login'); return 1; }
  secret = token;
  const request = deps.apiRequestJson || apiRequestJson;
  const agent = resolveAgentRef(ref, { cwd, env });
  const label = agent.handle || ref;
  const base = `/agent/${encodeURIComponent(agent.id)}/always-on`;

  let res;
  if (verb === 'on') res = await request(base, { method: 'POST', body, token });
  else if (verb === 'status') res = await request(`${base}?days=${days}`, { method: 'GET', token });
  else res = await request(base, { method: 'DELETE', token });

  if (!res || !res.ok) {
    const doing = { on: 'turn on', status: 'read the bill for', off: 'turn off' }[verb];
    err(`Could not ${doing} ${label}. ${refusal(res, label)}`);
    return 1;
  }
  const data = res.data && typeof res.data === 'object' ? res.data : {};
  if (flags.json) { log(JSON.stringify(res.data, null, 2)); return 0; }
  if (verb === 'on') printOn(data, ref, label, log, now);
  else if (verb === 'status') printStatus(data, ref, label, log, now);
  else {
    log(`${data.name || label} is off. It will not check in on its own anymore.`);
    log('Follow-ups it set for itself are canceled. The bill is kept.');
    log(`See the bill: atris agent always-on status ${shellWord(ref)}`);
  }
  return 0;
}

module.exports = {
  agentAlwaysOnCommand,
  parseEvery,
  checkEvery,
  refusal,
};
