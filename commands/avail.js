'use strict';

/**
 * Booking availability — read/update the windows that power /book/{username}.
 *
 *   atris avail                         # show current settings
 *   atris avail set --wake 2:30pm --sleep 9pm --where Ibiza --days all --apply
 *   atris avail slots [--days 7]
 */

const { ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson, getAppBaseUrl, httpRequest } = require('../utils/api');

const DAY_INDEX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const DAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const WHERE_TZ = {
  ibiza: 'Europe/Madrid',
  madrid: 'Europe/Madrid',
  spain: 'Europe/Madrid',
  la: 'America/Los_Angeles',
  sf: 'America/Los_Angeles',
  pt: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  nyc: 'America/New_York',
  ny: 'America/New_York',
  london: 'Europe/London',
  utc: 'UTC',
};

function backendBaseUrl() {
  const raw = process.env.ATRIS_BACKEND_URL
    ? process.env.ATRIS_BACKEND_URL.replace(/\/+$/, '')
    : 'https://api.atris.ai';
  return raw.replace(/\/api$/, '');
}

async function getToken() {
  const ensured = await ensureValidCredentials(apiRequestJson);
  const creds = ensured.error ? null : ensured.credentials;
  if (!creds?.token) {
    console.error(ensured.error && ensured.error !== 'not_logged_in'
      ? `Authentication failed: ${ensured.detail || ensured.error}. Run: atris login`
      : 'Not logged in. Run: atris login');
    process.exit(1);
  }
  return creds.token;
}

/** Parse "2:30pm", "14:30", "9", "9pm" → decimal hours (e.g. 14.5). */
function parseTimeToDecimal(raw) {
  if (raw == null || raw === '') throw new Error('time value required');
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = m12[2] ? parseInt(m12[2], 10) : 0;
    const ap = m12[3];
    if (h < 1 || h > 12 || min < 0 || min > 59) throw new Error(`invalid time: ${raw}`);
    if (ap === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
    return h + min / 60;
  }
  const m24 = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = m24[2] ? parseInt(m24[2], 10) : 0;
    if (h < 0 || h > 23 || min < 0 || min > 59) throw new Error(`invalid time: ${raw}`);
    return h + min / 60;
  }
  throw new Error(`invalid time: ${raw} (use 2:30pm, 14:30, 9am)`);
}

function formatDecimalHour(h) {
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  const ap = hrs >= 12 ? 'pm' : 'am';
  const h12 = hrs % 12 === 0 ? 12 : hrs % 12;
  return mins ? `${h12}:${String(mins).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}

/** mon-fri | all | mon,wed,fri | weekdays | weekends */
function parseDaysArg(raw) {
  if (!raw || raw === 'all' || raw === 'everyday' || raw === 'daily') {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  const key = raw.trim().toLowerCase();
  if (key === 'weekdays' || key === 'mon-fri' || key === 'weekdays-mon-fri') {
    return [0, 1, 2, 3, 4];
  }
  if (key === 'weekends' || key === 'sat-sun') return [5, 6];
  const out = new Set();
  for (const part of key.split(/[,+\s]+/).filter(Boolean)) {
    if (part.includes('-')) {
      const [a, b] = part.split('-');
      const start = DAY_INDEX[a];
      const end = DAY_INDEX[b];
      if (start == null || end == null) throw new Error(`invalid day range: ${part}`);
      for (let d = start; d <= end; d += 1) out.add(d);
      continue;
    }
    const idx = DAY_INDEX[part.slice(0, 3)] ?? DAY_INDEX[part];
    if (idx == null) throw new Error(`invalid day: ${part}`);
    out.add(idx);
  }
  return [...out].sort((a, b) => a - b);
}

function resolveTimezone({ tz, where }) {
  if (tz) return tz;
  if (where) {
    const key = where.trim().toLowerCase();
    if (WHERE_TZ[key]) return WHERE_TZ[key];
    throw new Error(`unknown --where "${where}"; use --tz IANA/Zone instead`);
  }
  return 'America/Los_Angeles';
}

function parseSetArgs(argv) {
  const opts = {
    wake: null,
    sleep: null,
    tz: null,
    where: null,
    days: 'all',
    apply: false,
    json: false,
    slotMinutes: null,
    windowDays: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--wake') opts.wake = argv[++i];
    else if (a === '--sleep' || a === '--bed') opts.sleep = argv[++i];
    else if (a === '--tz') opts.tz = argv[++i];
    else if (a === '--where') opts.where = argv[++i];
    else if (a === '--days') opts.days = argv[++i];
    else if (a === '--slot-minutes') opts.slotMinutes = parseInt(argv[++i], 10);
    else if (a === '--window-days') opts.windowDays = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') return { help: true };
    else throw new Error(`unknown arg: ${a}`);
  }
  if (opts.wake == null || opts.sleep == null) {
    throw new Error('--wake and --sleep are required (e.g. --wake 2:30pm --sleep 9pm)');
  }
  return opts;
}

function buildAvailableHours(dayIndexes, wakeDec, sleepDec) {
  const hours = {};
  for (let d = 0; d <= 6; d += 1) hours[String(d)] = [];
  const window = [[wakeDec, sleepDec]];
  for (const d of dayIndexes) hours[String(d)] = window.map(([a, b]) => [a, b]);
  return hours;
}

function summarizeHours(availableHours) {
  const lines = [];
  for (let d = 0; d <= 6; d += 1) {
    const ranges = availableHours[String(d)] || availableHours[d] || [];
    if (!ranges.length) {
      lines.push(`  ${DAY_LABEL[d]}: off`);
      continue;
    }
    const pretty = ranges.map(([a, b]) => `${formatDecimalHour(a)}–${formatDecimalHour(b)}`).join(', ');
    lines.push(`  ${DAY_LABEL[d]}: ${pretty}`);
  }
  return lines.join('\n');
}

async function showAvail({ json = false } = {}) {
  const token = await getToken();
  const result = await apiRequestJson('/profile/booking-settings', { method: 'GET', token });
  if (!result.ok) {
    console.error(`Error: ${result.error || result.status}`);
    process.exit(1);
  }
  const data = result.data || {};
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  const identity = await apiRequestJson('/identity/me', { method: 'GET', token });
  const username = identity.ok ? identity.data?.username : null;
  const appBase = getAppBaseUrl();
  console.log('📅 Booking availability\n');
  console.log(`  timezone: ${data.timezone}`);
  console.log(`  slot: ${data.slot_duration_minutes} min · window: ${data.booking_window_days} days`);
  if (username) console.log(`  link: ${appBase}/book/${username}`);
  console.log('\n  weekly windows (stored timezone):');
  console.log(summarizeHours(data.available_hours || {}));
  console.log('\n  Google Calendar busy times are subtracted automatically.');
  return 0;
}

async function setAvail(argv) {
  let opts;
  try {
    opts = parseSetArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  const wakeDec = parseTimeToDecimal(opts.wake);
  const sleepDec = parseTimeToDecimal(opts.sleep);
  if (!(wakeDec < sleepDec)) {
    console.error('wake must be before sleep on the same calendar day');
    return 1;
  }

  let dayIndexes;
  try {
    dayIndexes = parseDaysArg(opts.days);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  let timezone;
  try {
    timezone = resolveTimezone(opts);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const payload = {
    timezone,
    available_hours: buildAvailableHours(dayIndexes, wakeDec, sleepDec),
  };
  if (opts.slotMinutes) payload.slot_duration_minutes = opts.slotMinutes;
  if (opts.windowDays) payload.booking_window_days = opts.windowDays;

  if (opts.json && !opts.apply) {
    console.log(JSON.stringify({ preview: true, payload }, null, 2));
    return 0;
  }

  console.log('📅 Availability preview\n');
  console.log(`  timezone: ${timezone}`);
  console.log(`  awake: ${formatDecimalHour(wakeDec)} → ${formatDecimalHour(sleepDec)} (${opts.days})`);
  console.log('\n  weekly windows:');
  console.log(summarizeHours(payload.available_hours));

  if (!opts.apply) {
    console.log('\n  Dry run — add --apply to push to your profile.');
    return 0;
  }

  const token = await getToken();
  const result = await apiRequestJson('/profile/booking-settings', {
    method: 'PUT',
    token,
    body: payload,
  });
  if (!result.ok) {
    console.error(`Update failed: ${result.error || result.status}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, settings: result.data }, null, 2));
    return 0;
  }

  console.log('\n✓ Updated. Live on /book/{username} after the next slots fetch.');
  return 0;
}

async function slotsAvail(argv) {
  const opts = { days: 7, username: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--days') opts.days = parseInt(argv[++i], 10);
    else if (a === '--user' || a === '--username') opts.username = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      return 0;
    } else {
      console.error(`unknown arg: ${a}`);
      return 1;
    }
  }

  const token = await getToken();
  let username = opts.username;
  if (!username) {
    const identity = await apiRequestJson('/identity/me', { method: 'GET', token });
    if (!identity.ok || !identity.data?.username) {
      console.error('Could not resolve username — pass --user keshav');
      return 1;
    }
    username = identity.data.username;
  }

  const url = `${backendBaseUrl()}/book/${encodeURIComponent(username)}/slots?days=${opts.days}`;
  const result = await httpRequest(url, { method: 'GET', timeoutMs: 30000 });
  let data = null;
  try {
    data = JSON.parse(result.body.toString('utf8'));
  } catch {
    console.error('Invalid slots response');
    return 1;
  }
  if (result.status < 200 || result.status >= 300) {
    console.error(data?.detail || data?.error || `HTTP ${result.status}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }

  const byDay = data.slots_by_day || {};
  const keys = Object.keys(byDay).sort();
  console.log(`📅 Open slots for /book/${username} (${data.timezone || 'local'})\n`);
  if (!keys.length) {
    console.log('  No open slots in range.');
    return 0;
  }
  for (const day of keys) {
    const slots = byDay[day] || [];
    const times = slots.map((s) => s.start_formatted?.split(' at ').pop() || s.start).join(', ');
    console.log(`  ${day}: ${times || '(none)'}`);
  }
  const total = keys.reduce((n, k) => n + (byDay[k]?.length || 0), 0);
  console.log(`\n  ${total} slot(s) · ${opts.days}-day window`);
  return 0;
}

function printHelp() {
  console.log(`Usage: atris avail [show | set | slots] [options]

Show or update the weekly windows behind your public booking page.
Busy Google Calendar events are subtracted when guests pick a slot.

Commands:
  atris avail                 Same as show
  atris avail show [--json]
  atris avail set --wake TIME --sleep TIME [options]
  atris avail slots [--days N] [--user USERNAME] [--json]

Set options:
  --wake TIME       Awake/start (2:30pm, 14:30, 9am)
  --sleep TIME      Sleep/end (9pm, 21:00)
  --where CITY      Shorthand timezone (Ibiza, LA, NYC, London, …)
  --tz ZONE         IANA timezone (overrides --where)
  --days DAYS       all | weekdays | mon-fri | mon,wed,fri (default: all)
  --slot-minutes N  15, 30, 45, or 60
  --window-days N   How far ahead to offer slots (1-90)
  --apply           Push preview to your profile (default: dry run)
  --json            Machine-readable output

Examples:
  atris avail
  atris avail set --where Ibiza --wake 2:30pm --sleep 9pm --days all
  atris avail set --wake 9am --sleep 5pm --days mon-fri --tz America/Los_Angeles --apply
  atris avail slots --days 7
`);
}

async function availCommand(argv = []) {
  if (!argv.length || argv[0]?.startsWith('-') || argv[0] === 'show' || argv[0] === 'get') {
    return showAvail({ json: argv.includes('--json') });
  }
  const sub = argv[0].toLowerCase();
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return 0;
  }
  if (sub === 'set' || sub === 'update') return setAvail(argv.slice(1));
  if (sub === 'slots') return slotsAvail(argv.slice(1));
  console.error(`Unknown subcommand: ${sub}`);
  printHelp();
  return 1;
}

module.exports = {
  availCommand,
  parseTimeToDecimal,
  parseDaysArg,
  buildAvailableHours,
  resolveTimezone,
  formatDecimalHour,
};
