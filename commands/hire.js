'use strict';

// atris hire "<name>" --job "<idea>"   one call: member, inbox, allowance, nightly loop
// atris hires                         the morning check-in, one line per hire
// Backend: POST /api/business/{id}/hire, GET /api/business/{id}/hires

const { apiRequestJson } = require('../utils/api');
const { NOT_LOGGED_IN } = require('../lib/developer-api');
const {
  NO_BUSINESS, parseArgs, resolveBusiness, loginToken, errorText, relativeTime, dollars, clip,
} = require('../lib/business-target');

function hireHelp(log = console.log) {
  log(`usage: atris hire "<name>" --job "<idea>" [--budget 50] [--outreach] [--schedule nightly] [--business <slug>] [--json]

hire an agent in one step. it gets a name, a job, its own email inbox,
a monthly spending allowance, and a work loop that runs overnight.

  --job       the idea it works on, in plain words (required)
  --budget    most it may ask you to approve per month, in dollars (default 0 = no spending)
              you still approve every purchase yourself
  --outreach  mark it as doing outreach (recorded; it uses a normal inbox for now)
  --schedule  nightly (default, 2 AM your time), hourly, or a cron like "0 3 * * *"
  --timezone  defaults to this computer's timezone
  --business  which business; defaults to the business folder you are in

running it again with the same name is safe: you get the same hire back,
and anything missing (like the inbox) is filled in. --budget changes the allowance.

then each morning: atris hires`);
}

function hiresHelp(log = console.log) {
  log(`usage: atris hires [--business <slug>] [--json]

the morning check-in: one line per hire with its email in the last day,
what it spent this month, and what its last overnight run did.`);
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

function renderHire(data = {}, now = Date.now()) {
  const m = data.member || {};
  const lines = [data.created ? `Hired ${m.name}.` : `${m.name} was already hired. Same hire, nothing duplicated.`];
  if (m.job) lines.push(`Job: ${clip(m.job, 200)}`);
  if (data.inbox && data.inbox.address) lines.push(`Inbox: ${data.inbox.address}`);
  const a = data.allowance || {};
  lines.push(Number(a.monthly_usd) > 0
    ? `Allowance: ${dollars(a.monthly_usd)} a month. You still approve every purchase.`
    : 'Allowance: none. It cannot ask to spend money.');
  if (a.note) lines.push(`  ${a.note}`);
  const s = data.schedule || {};
  let when = s.label ? `Works ${s.label}.` : 'Works on its schedule.';
  if (s.enabled === false) when += ' Asleep right now.';
  else if (data.next_run_at) when += ` First run ${relativeTime(data.next_run_at, now)}.`;
  lines.push(when);
  if (data.outreach && data.outreach.requested) lines.push(`Outreach: ${data.outreach.note || 'recorded.'}`);
  lines.push('', 'Check in each morning: atris hires');
  return lines.join('\n');
}

function hireLine(h = {}, now = Date.now()) {
  const parts = [];
  if (h.status && h.status !== 'active') {
    const why = { needs_inbox: 'paused, no inbox yet', needs_allowance: 'paused, allowance not set up', setting_up: 'still setting up' };
    parts.push(why[h.status] || `paused (${h.status})`);
  }
  const mail = h.emails_last_24h;
  if (mail) parts.push(`sent ${mail.sent}, got ${mail.received} emails today`);
  else parts.push('no inbox');
  const a = h.allowance || {};
  if (Number(a.monthly_usd) > 0) {
    parts.push(a.spent_this_month_usd == null
      ? `${dollars(a.monthly_usd)} a month`
      : `spent ${dollars(a.spent_this_month_usd)} of ${dollars(a.monthly_usd)}`);
  }
  if (h.last_run_at) {
    const result = h.last_result ? `: ${clip(h.last_result, 80)}` : '';
    parts.push(`last ran ${relativeTime(h.last_run_at, now)}${result}`);
  } else if (h.schedule && h.schedule.enabled === false) {
    parts.push('asleep, has not run');
  } else if (h.next_run_at) {
    parts.push(`first run ${relativeTime(h.next_run_at, now)}`);
  } else {
    parts.push('has not run yet');
  }
  return `${h.name}: ${parts.join(' · ')}`;
}

function renderHires(data = {}, now = Date.now()) {
  const rows = Array.isArray(data.hires) ? data.hires : [];
  if (!rows.length) return 'No hires yet. Start one: atris hire "Maya" --job "grow the newsletter"';
  return rows.map((h) => hireLine(h, now)).join('\n');
}

function io(deps) {
  return { log: deps.log || console.log, err: deps.err || console.error };
}

async function hireCommand(args = [], deps = {}) {
  const out = io(deps);
  const { flags, pos } = parseArgs(args, ['outreach']);
  if (flags.help || pos[0] === 'help') { hireHelp(out.log); return 0; }

  const name = pos.join(' ').trim();
  const job = typeof flags.job === 'string' ? flags.job.trim() : '';
  if (!name) { out.err('give the hire a name: atris hire "Maya" --job "<idea>"'); return 1; }
  if (!job) { out.err('give the hire a job: --job "<the idea to grow>"'); return 1; }
  const body = { name, job, outreach: flags.outreach === true };
  if (flags.budget != null) {
    const budget = Number(flags.budget);
    if (!Number.isInteger(budget) || budget < 0 || budget > 1000) {
      out.err('--budget must be whole dollars from 0 to 1000');
      return 1;
    }
    body.monthly_allowance_usd = budget;
  }
  if (typeof flags.schedule === 'string') body.schedule = flags.schedule;
  const tz = typeof flags.timezone === 'string' ? flags.timezone : (deps.timezone || localTimezone());
  if (tz) body.timezone = tz;

  const business = resolveBusiness(flags, deps);
  if (!business) { out.err(NO_BUSINESS); return 1; }
  const token = await loginToken(deps);
  if (!token) { out.err(NOT_LOGGED_IN); return 1; }

  const request = deps.apiRequestJson || apiRequestJson;
  const result = await request(`/business/${encodeURIComponent(business.id)}/hire`, {
    method: 'POST', token, body, timeoutMs: 60000, retries: 0,
  });
  if (!result || !result.ok) { out.err(`Could not hire ${name}: ${errorText(result)}`); return 1; }
  if (flags.json) out.log(JSON.stringify(result.data));
  else out.log(renderHire(result.data, deps.now ? deps.now() : Date.now()));
  return 0;
}

async function hiresCommand(args = [], deps = {}) {
  const out = io(deps);
  const { flags, pos } = parseArgs(args);
  if (flags.help || pos[0] === 'help') { hiresHelp(out.log); return 0; }
  const business = resolveBusiness(flags, deps);
  if (!business) { out.err(NO_BUSINESS); return 1; }
  const token = await loginToken(deps);
  if (!token) { out.err(NOT_LOGGED_IN); return 1; }

  const request = deps.apiRequestJson || apiRequestJson;
  const result = await request(`/business/${encodeURIComponent(business.id)}/hires`, { method: 'GET', token });
  if (!result || !result.ok) { out.err(`Could not load hires: ${errorText(result)}`); return 1; }
  if (flags.json) out.log(JSON.stringify(result.data));
  else out.log(renderHires(result.data, deps.now ? deps.now() : Date.now()));
  return 0;
}

module.exports = { hireCommand, hiresCommand, renderHire, renderHires, hireLine };
