'use strict';

/**
 * Booking availability: read/update the windows that power /book/{username}.
 *
 *   atris avail                         # show current settings and upcoming blocks
 *   atris avail set --wake 2:30pm --sleep 9pm --where Ibiza --days all --apply
 *   atris avail set --off --apply       # no weekly hours; only blocks are bookable
 *   atris avail set --notice 4h --buffer 10m --max-per-day 6 --apply
 *   atris avail types | type add intro 15 "Quick intro" | type remove intro [--apply]
 *   atris avail slots [--days 7]
 *   atris avail hold thu 2pm 5pm [--and mon 1pm 4pm] [--title T] [--weekly] [--apply]
 *   atris avail holds [--days N] [--json]
 *   atris avail unhold <id> [--apply]
 *
 * A block (hold) is a busy "Open for calls" event on your main Google
 * Calendar. Guests can book any open slot inside it, even outside weekly
 * hours. An event you make yourself titled exactly "Open for calls" counts too.
 */

const { ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson, getAppBaseUrl, httpRequest } = require('../utils/api');
const { argsWantHelp } = require('../lib/noninteractive');

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

function parseWholeNumber(raw, min, max) {
  if (raw === undefined || !/^\d+$/.test(String(raw).trim())) return null;
  const n = parseInt(raw, 10);
  if (n < min || n > max) return null;
  return n;
}

function requireWholeNumber(flag, raw, min, max) {
  const n = parseWholeNumber(raw, min, max);
  if (n === null) {
    throw new Error(`${flag} needs a whole number from ${min} to ${max}, got: ${raw === undefined ? 'nothing' : raw}`);
  }
  return n;
}

// Booking rules (server limits mirror backend validation).
const NOTICE_MAX_MINUTES = 10080;
const BUFFER_MAX_MINUTES = 120;
const MAX_PER_DAY_LIMIT = 50;
const MEETING_TYPE_MINUTES = [15, 20, 30, 45, 60, 90];
const MEETING_TYPES_MAX = 5;
const MEETING_SLUG_RE = /^[a-z0-9-]{1,24}$/;

/** "4h", "240m", "1h30m", "90" (minutes) → whole minutes within [0, max]. */
function parseMinutesArg(flag, raw, max) {
  const s = String(raw ?? '').trim().toLowerCase();
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m(?:in)?)?$/);
  let minutes = null;
  if (/^\d+$/.test(s)) minutes = parseInt(s, 10);
  else if (s && m && (m[1] || m[2])) minutes = (parseInt(m[1] || '0', 10) * 60) + parseInt(m[2] || '0', 10);
  if (minutes === null || minutes > max) {
    throw new Error(`${flag} needs a length like 4h, 90m or 1h30m, up to ${max} minutes, got: ${raw === undefined ? 'nothing' : raw}`);
  }
  return minutes;
}

/** "none" | "off" → null (no cap); otherwise 1..50. */
function parseMaxPerDay(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'none' || s === 'off' || s === 'no') return null;
  const n = parseWholeNumber(s, 1, MAX_PER_DAY_LIMIT);
  if (n === null) {
    throw new Error(`--max-per-day needs a number from 1 to ${MAX_PER_DAY_LIMIT}, or none, got: ${raw === undefined ? 'nothing' : raw}`);
  }
  return n;
}

function formatMinutes(minutes) {
  if (!minutes) return '0 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The rule keys a set command will send. Empty when no rule flag was given. */
function buildRulesPayload(opts) {
  const rules = {};
  if (opts.notice !== undefined) rules.min_notice_minutes = opts.notice;
  if (opts.buffer !== undefined) rules.buffer_minutes = opts.buffer;
  if (opts.maxPerDay !== undefined) rules.max_per_day = opts.maxPerDay;
  return rules;
}

function describeRules(data) {
  const cap = data.max_per_day == null ? 'no cap' : `${data.max_per_day} a day`;
  const lines = [];
  if (data.min_notice_minutes !== undefined) lines.push(`  notice: ${formatMinutes(data.min_notice_minutes)} before a call`);
  if (data.buffer_minutes !== undefined) lines.push(`  buffer: ${formatMinutes(data.buffer_minutes)} around other meetings`);
  if (data.max_per_day !== undefined) lines.push(`  booked calls: ${cap}`);
  return lines.join('\n');
}

function formatMeetingTypes(types, indent = '  ') {
  if (!types || !types.length) return `${indent}none`;
  return types.map((t) => `${indent}${t.slug}: ${t.title} (${t.minutes} min)`).join('\n');
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
    off: false,
    notice: undefined,
    buffer: undefined,
    maxPerDay: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--off') opts.off = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--wake') opts.wake = argv[++i];
    else if (a === '--sleep' || a === '--bed') opts.sleep = argv[++i];
    else if (a === '--tz') opts.tz = argv[++i];
    else if (a === '--where') opts.where = argv[++i];
    else if (a === '--days') opts.days = argv[++i];
    else if (a === '--slot-minutes') opts.slotMinutes = requireWholeNumber(a, argv[++i], 5, 480);
    else if (a === '--window-days') opts.windowDays = requireWholeNumber(a, argv[++i], 1, 365);
    else if (a === '--notice') opts.notice = parseMinutesArg(a, argv[++i], NOTICE_MAX_MINUTES);
    else if (a === '--buffer') opts.buffer = parseMinutesArg(a, argv[++i], BUFFER_MAX_MINUTES);
    else if (a === '--max-per-day') opts.maxPerDay = parseMaxPerDay(argv[++i]);
    else if (a === '--help' || a === '-h') return { help: true };
    else throw new Error(`atris avail set does not take "${a}". Run: atris avail --help`);
  }
  const hasRules = Object.keys(buildRulesPayload(opts)).length > 0;
  // Rules alone change only the rules; weekly hours stay as they are.
  opts.rulesOnly = !opts.off && hasRules && opts.wake == null && opts.sleep == null;
  if (opts.rulesOnly) return opts;
  if (opts.off) {
    if (opts.wake != null || opts.sleep != null) {
      throw new Error('--off turns weekly hours off, so it does not take --wake or --sleep');
    }
    return opts;
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

// Every day present and empty. An empty object {} is NOT off: the server
// reads it as "use the 9 to 5 default", so off is always sent as seven lists.
function weeklyHoursOff(availableHours) {
  if (!availableHours || typeof availableHours !== 'object') return false;
  for (let d = 0; d <= 6; d += 1) {
    const ranges = availableHours[String(d)] ?? availableHours[d];
    if (!Array.isArray(ranges) || ranges.length) return false;
  }
  return true;
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

// The booking link is the funnel: an operator shares /book/{username} so a
// stranger can pick a slot. With no claimed handle there is no link, say so and
// name the fix instead of silently dropping the line.
function formatBookingLink(username, appBase) {
  const handle = String(username || '').trim();
  const base = String(appBase || '').replace(/\/+$/, '');
  if (!handle) {
    return '  link: none yet, claim a handle with `atris signup` to get your /book link';
  }
  return `  link: ${base}/book/${handle}`;
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
  const rulesLine = describeRules(data);
  if (rulesLine) console.log(rulesLine);
  console.log(formatBookingLink(username, appBase));
  if (Array.isArray(data.meeting_types)) {
    console.log('\n  Meeting types (guests pick one):');
    console.log(formatMeetingTypes(data.meeting_types, '    '));
  }
  if (weeklyHoursOff(data.available_hours)) {
    console.log('\n  Weekly hours: off. Only your blocks are bookable.');
  } else {
    console.log('\n  weekly windows (stored timezone):');
    console.log(summarizeHours(data.available_hours || {}));
  }
  const holds = await apiRequestJson('/profile/booking-holds', { method: 'GET', token });
  console.log('\n  Upcoming blocks:');
  if (!holds.ok) {
    console.log(`    could not read your blocks (${holds.error || holds.status})`);
  } else {
    console.log(formatHoldList(holds.data?.holds || [], data.timezone, '    '));
  }
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
  if (opts.off) return setAvailOff(opts);
  if (opts.rulesOnly) return setRules(opts);

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
  Object.assign(payload, buildRulesPayload(opts));

  if (opts.json && !opts.apply) {
    console.log(JSON.stringify({ preview: true, payload }, null, 2));
    return 0;
  }

  console.log('📅 Availability preview\n');
  console.log(`  timezone: ${timezone}`);
  console.log(`  awake: ${formatDecimalHour(wakeDec)} → ${formatDecimalHour(sleepDec)} (${opts.days})`);
  const rulesLine = describeRules(payload);
  if (rulesLine) console.log(rulesLine);
  console.log('\n  weekly windows:');
  console.log(summarizeHours(payload.available_hours));

  if (!opts.apply) {
    console.log('\n  Dry run, add --apply to push to your profile.');
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

async function setRules(opts, deps = defaultHoldDeps) {
  const payload = buildRulesPayload(opts);
  if (opts.slotMinutes) payload.slot_duration_minutes = opts.slotMinutes;
  if (opts.windowDays) payload.booking_window_days = opts.windowDays;
  if (opts.json && !opts.apply) {
    console.log(JSON.stringify({ preview: true, payload }, null, 2));
    return 0;
  }
  console.log('Booking rules:');
  console.log(describeRules(payload));
  if (!opts.apply) {
    console.log('Dry run, add --apply to save it.');
    return 0;
  }
  const token = await deps.getToken();
  const result = await deps.request('/profile/booking-settings', { method: 'PUT', token, body: payload });
  if (!result.ok) {
    console.error(`Update failed: ${result.error || result.status}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, settings: result.data }, null, 2));
    return 0;
  }
  console.log('Saved. Guests see it on your booking page within a minute.');
  return 0;
}

function buildOffPayload(opts) {
  const payload = { available_hours: buildAvailableHours([], 0, 0) };
  // Keep the stored timezone unless one is asked for: blocks are read in it.
  if (opts.tz || opts.where) payload.timezone = resolveTimezone(opts);
  if (opts.slotMinutes) payload.slot_duration_minutes = opts.slotMinutes;
  if (opts.windowDays) payload.booking_window_days = opts.windowDays;
  Object.assign(payload, buildRulesPayload(opts));
  return payload;
}

async function setAvailOff(opts) {
  let payload;
  try {
    payload = buildOffPayload(opts);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.json && !opts.apply) {
    console.log(JSON.stringify({ preview: true, payload }, null, 2));
    return 0;
  }
  console.log('Weekly hours: off. Only your blocks will be bookable.');
  if (!opts.apply) {
    console.log('Dry run, add --apply to save it.');
    return 0;
  }
  const token = await getToken();
  const result = await apiRequestJson('/profile/booking-settings', { method: 'PUT', token, body: payload });
  if (!result.ok) {
    console.error(`Update failed: ${result.error || result.status}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, settings: result.data }, null, 2));
    return 0;
  }
  console.log('Saved. Add a block with: atris avail hold thu 2pm 5pm --apply');
  return 0;
}

// ---------------------------------------------------------------------------
// Blocks (holds)
// ---------------------------------------------------------------------------

const WEEKDAY_SHORT = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Wall-clock parts of an instant in a timezone. */
function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_SHORT[parts.weekday],
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** ISO string with the zone's offset for a wall-clock time on a date. */
function zonedIso(dateStr, decimalHour, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const hour = Math.floor(decimalHour);
  const minute = Math.round((decimalHour - hour) * 60);
  const wantedAsUtc = Date.UTC(y, m - 1, d, hour, minute);
  let guess = wantedAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(new Date(guess), timeZone);
    const seenAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wantedAsUtc - seenAsUtc;
  }
  const p = zonedParts(new Date(guess), timeZone);
  if (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) !== wantedAsUtc) {
    throw new Error(`${formatDecimalHour(decimalHour)} on ${dateStr} does not exist in ${timeZone} (clock change)`);
  }
  const offsetMin = Math.round((wantedAsUtc - guess) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${dateStr}T${pad2(hour)}:${pad2(minute)}:00${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * today | tomorrow | mon..sun (or full names) | YYYY-MM-DD → YYYY-MM-DD in the zone.
 * A weekday means the next one coming; today counts while `startHour` is still ahead.
 */
function resolveHoldDate(when, timeZone, now = new Date(), startHour = null) {
  const raw = String(when || '').trim().toLowerCase();
  if (!raw) throw new Error('say which day: today, tomorrow, thu, or 2026-11-20');
  const here = zonedParts(now, timeZone);
  const today = ymd(here);
  if (raw === 'today') return today;
  if (raw === 'tomorrow' || raw === 'tmrw') return addDays(today, 1);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const check = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    if (check.getUTCMonth() !== Number(iso[2]) - 1 || check.getUTCDate() !== Number(iso[3])) {
      throw new Error(`not a real date: ${when}`);
    }
    return raw;
  }
  const idx = /^[a-z]+$/.test(raw) && raw.length >= 3 ? DAY_INDEX[raw.slice(0, 3)] : undefined;
  const fullNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  if (idx == null || !(raw.length === 3 || fullNames[idx].startsWith(raw))) {
    throw new Error(`unknown day "${when}"; use today, tomorrow, thu, or 2026-11-20`);
  }
  let ahead = (idx - here.weekday + 7) % 7;
  if (ahead === 0 && startHour != null && startHour <= here.hour + here.minute / 60) ahead = 7;
  return addDays(today, ahead);
}

function parseHoldArgs(argv) {
  const opts = { blocks: [], title: null, weekly: false, apply: false, json: false, tz: null };
  const positional = [];
  let current = positional;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--weekly') opts.weekly = true;
    else if (a === '--title') {
      opts.title = argv[++i];
      if (!opts.title || !opts.title.trim()) throw new Error('--title needs some words');
    } else if (a === '--tz') opts.tz = argv[++i];
    else if (a === '--and') {
      current = [];
      opts.blocks.push(current);
    } else if (a === '--help' || a === '-h') return { help: true };
    else if (a.startsWith('--')) throw new Error(`atris avail hold does not take "${a}". Run: atris avail --help`);
    else current.push(a);
  }
  const all = [positional, ...opts.blocks];
  for (const block of all) {
    if (block.length !== 3) {
      throw new Error('each block needs a day, a start and an end, like: thu 2pm 5pm');
    }
  }
  opts.blocks = all.map(([when, start, end]) => ({ when, start, end }));
  return opts;
}

/** Turn parsed blocks into the exact bodies sent to POST /profile/booking-holds. */
function buildHoldBodies(opts, timeZone, now = new Date()) {
  return opts.blocks.map(({ when, start, end }) => {
    const startDec = parseTimeToDecimal(start);
    const endDec = parseTimeToDecimal(end);
    if (!(endDec > startDec)) throw new Error(`the end (${end}) must be after the start (${start}) on the same day`);
    const date = resolveHoldDate(when, timeZone, now, startDec);
    const body = { start: zonedIso(date, startDec, timeZone), end: zonedIso(date, endDec, timeZone) };
    if (opts.title) body.title = opts.title.trim();
    if (opts.weekly) body.repeat = 'weekly';
    return body;
  });
}

function formatClock(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return formatDecimalHour(p.hour + p.minute / 60);
}

function formatDay(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
  }).format(date);
}

function describeBlock(hold, timeZone) {
  const start = new Date(hold.start);
  const end = new Date(hold.end);
  const title = hold.title || 'Open for calls';
  const repeats = hold.repeats || hold.repeat === 'weekly' ? ', every week' : '';
  return `${formatDay(start, timeZone)}, ${formatClock(start, timeZone)} to ${formatClock(end, timeZone)}${repeats} (${title})`;
}

function formatHoldList(holds, timeZone, indent = '  ') {
  if (!holds.length) return `${indent}none. Add one: atris avail hold thu 2pm 5pm --apply`;
  return holds.map((h) => `${indent}${describeBlock(h, timeZone)}\n${indent}  id: ${h.id}`).join('\n');
}

async function fetchBookingTimezone(token) {
  const result = await apiRequestJson('/profile/booking-settings', { method: 'GET', token });
  if (!result.ok) throw new Error(`could not read your booking timezone (${result.error || result.status})`);
  return result.data?.timezone || 'America/Los_Angeles';
}

const defaultHoldDeps = {
  getToken: () => getToken(),
  timezone: (token) => fetchBookingTimezone(token),
  now: () => new Date(),
  request: (path, options) => apiRequestJson(path, options),
};

async function holdAvail(argv, deps = defaultHoldDeps) {
  let opts;
  try {
    opts = parseHoldArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }
  let token = null;
  let timeZone = opts.tz;
  let bodies;
  try {
    if (!timeZone) {
      token = await deps.getToken();
      timeZone = await deps.timezone(token);
    }
    bodies = buildHoldBodies(opts, timeZone, deps.now());
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  if (opts.json && !opts.apply) {
    console.log(JSON.stringify({ preview: true, timezone: timeZone, holds: bodies }, null, 2));
    return 0;
  }
  if (!opts.apply) {
    console.log(`Would block ${bodies.length === 1 ? 'this time' : 'these times'} on your Google Calendar (${timeZone}):`);
    for (const body of bodies) console.log(`  ${describeBlock(body, timeZone)}`);
    console.log('Guests can book inside it. Dry run, add --apply to create it.');
    return 0;
  }

  token = token || await deps.getToken();
  const made = [];
  for (const body of bodies) {
    const result = await deps.request('/profile/booking-holds', { method: 'POST', token, body });
    if (!result.ok) {
      console.error(`Could not block ${describeBlock(body, timeZone)}: ${result.error || result.status}`);
      if (made.length) console.error(`${made.length} block(s) were already made. See them: atris avail holds`);
      return 1;
    }
    made.push(result.data || {});
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, holds: made }, null, 2));
    return 0;
  }
  for (const hold of made) {
    console.log(`Blocked ${describeBlock(hold, timeZone)}.`);
    console.log(`  id: ${hold.id}`);
  }
  console.log('It is on your Google Calendar now. Guests can book inside it.');
  return 0;
}

async function holdsAvail(argv, deps = defaultHoldDeps) {
  const opts = { days: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--days') {
      const raw = argv[++i];
      opts.days = parseWholeNumber(raw, 1, 90);
      if (opts.days === null) {
        console.error(`--days needs a whole number from 1 to 90, got: ${raw === undefined ? 'nothing' : raw}`);
        return 1;
      }
    } else if (a === '--help' || a === '-h') {
      printHelp();
      return 0;
    } else {
      console.error(`atris avail holds does not take "${a}". Run: atris avail --help`);
      return 1;
    }
  }
  const token = await deps.getToken();
  const path = opts.days ? `/profile/booking-holds?days=${opts.days}` : '/profile/booking-holds';
  const result = await deps.request(path, { method: 'GET', token });
  if (!result.ok) {
    console.error(`Could not read your blocks: ${result.error || result.status}`);
    return 1;
  }
  const holds = result.data?.holds || [];
  if (opts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return 0;
  }
  let timeZone;
  try {
    timeZone = await deps.timezone(token);
  } catch {
    timeZone = 'America/Los_Angeles';
  }
  console.log(`Your blocks (${timeZone}):`);
  console.log(formatHoldList(holds, timeZone));
  if (holds.length) console.log('Remove one: atris avail unhold <id> --apply');
  return 0;
}

async function unholdAvail(argv, deps = defaultHoldDeps) {
  let id = null;
  let apply = false;
  for (const a of argv) {
    if (a === '--apply') apply = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      return 0;
    } else if (a.startsWith('--')) {
      console.error(`atris avail unhold does not take "${a}". Run: atris avail --help`);
      return 1;
    } else if (id) {
      console.error('give one block id at a time');
      return 1;
    } else id = a;
  }
  if (!id) {
    console.error('say which block: atris avail unhold <id>. See ids with: atris avail holds');
    return 1;
  }
  const token = await deps.getToken();
  if (!apply) {
    const listed = await deps.request('/profile/booking-holds', { method: 'GET', token });
    const holds = listed.ok ? listed.data?.holds || [] : [];
    const one = holds.find((h) => h.id === id);
    const series = holds.filter((h) => h.series_id === id);
    let timeZone = 'America/Los_Angeles';
    try { timeZone = await deps.timezone(token); } catch { /* keep default */ }
    if (one) console.log(`Would remove ${describeBlock(one, timeZone)}.`);
    else if (series.length) console.log(`Would remove the whole weekly block, starting ${describeBlock(series[0], timeZone)}.`);
    else console.log(`Would remove the block with id ${id}.`);
    console.log('Only blocks can be removed this way. Dry run, add --apply to remove it.');
    return 0;
  }
  const result = await deps.request(`/profile/booking-holds/${encodeURIComponent(id)}`, { method: 'DELETE', token });
  if (!result.ok) {
    console.error(`Could not remove it: ${result.error || result.status}`);
    return 1;
  }
  console.log('Removed. That time is no longer open for calls.');
  return 0;
}

// ---------------------------------------------------------------------------
// Meeting types (lengths guests can pick)
// ---------------------------------------------------------------------------

async function fetchSettings(deps, token) {
  const result = await deps.request('/profile/booking-settings', { method: 'GET', token });
  if (!result.ok) throw new Error(`could not read your booking settings (${result.error || result.status})`);
  return result.data || {};
}

async function typesAvail(argv, deps = defaultHoldDeps) {
  const json = argv.includes('--json');
  for (const a of argv) {
    if (a !== '--json') {
      console.error(`atris avail types does not take "${a}". Run: atris avail --help`);
      return 1;
    }
  }
  const token = await deps.getToken();
  let settings;
  try {
    settings = await fetchSettings(deps, token);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  const types = settings.meeting_types || [];
  if (json) {
    console.log(JSON.stringify({ meeting_types: types }, null, 2));
    return 0;
  }
  console.log('Meeting types (the first is the default):');
  console.log(formatMeetingTypes(types));
  console.log('Add one: atris avail type add intro 15 "Quick intro" --apply');
  return 0;
}

/** The new list after an add or remove. Throws in plain words when the change is not allowed. */
function changeMeetingTypes(types, action, args) {
  const current = (types || []).map((t) => ({ slug: t.slug, title: t.title, minutes: t.minutes }));
  if (action === 'add') {
    const [slug, rawMinutes, ...titleParts] = args;
    const title = titleParts.join(' ').trim();
    if (!slug || rawMinutes === undefined || !title) {
      throw new Error('say a slug, minutes and a title: atris avail type add intro 15 "Quick intro"');
    }
    if (!MEETING_SLUG_RE.test(slug)) throw new Error('the slug must be 1 to 24 lowercase letters, numbers or dashes');
    const minutes = Number(rawMinutes);
    if (!MEETING_TYPE_MINUTES.includes(minutes)) {
      throw new Error(`minutes must be one of ${MEETING_TYPE_MINUTES.join(', ')}`);
    }
    if (title.length > 80) throw new Error('the title can be at most 80 characters');
    if (current.some((t) => t.slug === slug)) throw new Error(`you already have a meeting type called ${slug}`);
    if (current.length >= MEETING_TYPES_MAX) throw new Error(`you can offer at most ${MEETING_TYPES_MAX} meeting types; remove one first`);
    return [...current, { slug, title, minutes }];
  }
  if (action === 'remove' || action === 'rm') {
    const [slug] = args;
    if (!slug || args.length !== 1) throw new Error('say which one: atris avail type remove <slug>');
    if (!current.some((t) => t.slug === slug)) {
      throw new Error(`there is no meeting type called ${slug}. See them: atris avail types`);
    }
    if (current.length === 1) throw new Error('that is your only meeting type; add another before removing it');
    return current.filter((t) => t.slug !== slug);
  }
  throw new Error('use: atris avail type add <slug> <minutes> "<title>" or atris avail type remove <slug>');
}

async function typeAvail(argv, deps = defaultHoldDeps) {
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  const rest = argv.filter((a) => a !== '--apply' && a !== '--json');
  if (rest.some((a) => a === '--help' || a === '-h')) {
    printHelp();
    return 0;
  }
  const unknown = rest.find((a) => a.startsWith('--'));
  if (unknown) {
    console.error(`atris avail type does not take "${unknown}". Run: atris avail --help`);
    return 1;
  }
  const [action, ...args] = rest;
  const token = await deps.getToken();
  let next;
  try {
    const settings = await fetchSettings(deps, token);
    next = changeMeetingTypes(settings.meeting_types, String(action || '').toLowerCase(), args);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  const payload = { meeting_types: next };
  if (json && !apply) {
    console.log(JSON.stringify({ preview: true, payload }, null, 2));
    return 0;
  }
  if (!apply) {
    console.log('Meeting types would be:');
    console.log(formatMeetingTypes(next));
    console.log('Dry run, add --apply to save it.');
    return 0;
  }
  const result = await deps.request('/profile/booking-settings', { method: 'PUT', token, body: payload });
  if (!result.ok) {
    console.error(`Update failed: ${result.error || result.status}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, meeting_types: result.data?.meeting_types || next }, null, 2));
    return 0;
  }
  console.log('Saved. Meeting types:');
  console.log(formatMeetingTypes(result.data?.meeting_types || next));
  return 0;
}

function parseSlotsDays(raw) {
  return parseWholeNumber(raw, 1, 365);
}

async function slotsAvail(argv) {
  const opts = { days: 7, username: null, json: false, type: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--days') {
      const raw = argv[++i];
      const days = parseSlotsDays(raw);
      if (days === null) {
        console.error(`--days needs a whole number from 1 to 365, got: ${raw === undefined ? 'nothing' : raw}`);
        return 1;
      }
      opts.days = days;
    }
    else if (a === '--user' || a === '--username') opts.username = argv[++i];
    else if (a === '--type') opts.type = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      return 0;
    } else {
      console.error(`atris avail slots does not take "${a}". Run: atris avail --help`);
      return 1;
    }
  }

  const token = await getToken();
  let username = opts.username;
  if (!username) {
    const identity = await apiRequestJson('/identity/me', { method: 'GET', token });
    if (!identity.ok || !identity.data?.username) {
      console.error('could not resolve username; pass --user <username>.');
      return 1;
    }
    username = identity.data.username;
  }

  const typeParam = opts.type ? `&type=${encodeURIComponent(opts.type)}` : '';
  const url = `${backendBaseUrl()}/book/${encodeURIComponent(username)}/slots?days=${opts.days}${typeParam}`;
  const result = await httpRequest(url, { method: 'GET', timeoutMs: 30000 });
  let data = null;
  try {
    data = JSON.parse(result.body.toString('utf8'));
  } catch {
    console.error(`the booking server sent back a reply atris could not read (HTTP ${result.status}). Try again in a minute.`);
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
  const meeting = data.meeting_type ? ` · ${data.meeting_type.title}, ${data.meeting_type.minutes} min` : '';
  console.log(`📅 Open slots for /book/${username} (${data.timezone || 'local'})${meeting}\n`);
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
  console.log(`Usage: atris avail [show | set | slots | hold | holds | unhold | types | type] [options]

Show or update the times guests can book on your public booking page.
Busy Google Calendar events are subtracted when guests pick a slot.

Commands:
  atris avail                 Same as show
  atris avail show [--json]
  atris avail set --wake TIME --sleep TIME [options]
  atris avail set --off [--apply]   Weekly hours off; only your blocks are bookable
  atris avail set [--notice 4h] [--buffer 10m] [--max-per-day N|none] [--apply]
  atris avail slots [--days N] [--user USERNAME] [--type SLUG] [--json]
  atris avail hold DAY START END [--and DAY START END] [--title T] [--weekly] [--apply]
  atris avail holds [--days N] [--json]
  atris avail unhold ID [--apply]
  atris avail types [--json]
  atris avail type add SLUG MINUTES "TITLE" [--apply]
  atris avail type remove SLUG [--apply]

Blocks:
  A block puts a busy "Open for calls" event on your Google Calendar now.
  Guests can book any open slot inside it, even outside your weekly hours.
  An event you make yourself titled exactly "Open for calls" counts too.
  DAY is today, tomorrow, a weekday (thu = the next one), or YYYY-MM-DD.
  Times are in your booking timezone. Dry run until you add --apply.
  --weekly repeats the block every week. unhold on a weekly block's id
  removes the whole series; on one day's id, just that day.

Set options:
  --wake TIME       Awake/start (2:30pm, 14:30, 9am)
  --sleep TIME      Sleep/end (9pm, 21:00)
  --where CITY      Shorthand timezone (Ibiza, LA, NYC, London, …)
  --tz ZONE         IANA timezone (overrides --where)
  --days DAYS       all | weekdays | mon-fri | mon,wed,fri (default: all)
  --slot-minutes N  15, 30, 45, or 60
  --window-days N   How far ahead to offer slots (1-90)
  --notice LEN      No call starts sooner than this from now (4h, 240m; default 4h)
  --buffer LEN      Free time kept before and after other meetings (10m; max 120m)
  --max-per-day N   Most booked calls in one day (1-50), or none for no cap
  --apply           Push preview to your profile (default: dry run)
  --json            Machine-readable output

Rules only: --notice, --buffer and --max-per-day can be set without
--wake/--sleep, and then weekly hours stay as they are.

Meeting types:
  The lengths guests can pick, up to 5. MINUTES is 15, 20, 30, 45, 60 or 90.
  SLUG is lowercase letters, numbers or dashes; it goes in the link as ?type=SLUG.
  The first type is the default. You always keep at least one.

Examples:
  atris avail
  atris avail set --notice 4h --buffer 10m --max-per-day 6 --apply
  atris avail type add intro 15 "Quick intro" --apply
  atris avail type add investor 30 "Investor call" --apply
  atris avail set --where Ibiza --wake 2:30pm --sleep 9pm --days all
  atris avail set --wake 9am --sleep 5pm --days mon-fri --tz America/Los_Angeles --apply
  atris avail slots --days 7
  atris avail hold thu 2pm 5pm --apply
  atris avail hold mon 1pm 4pm --and wed 10am 12pm --weekly --apply
  atris avail set --off --apply
`);
}

async function availCommand(argv = []) {
  if (argsWantHelp(argv)) {
    printHelp();
    return 2;
  }
  if (!argv.length || argv[0]?.startsWith('-') || argv[0] === 'show' || argv[0] === 'get') {
    return showAvail({ json: argv.includes('--json') });
  }
  const sub = argv[0].toLowerCase();
  if (sub === 'set' || sub === 'update') return setAvail(argv.slice(1));
  if (sub === 'slots') return slotsAvail(argv.slice(1));
  if (sub === 'hold' || sub === 'block') return holdAvail(argv.slice(1));
  if (sub === 'holds' || sub === 'blocks') return holdsAvail(argv.slice(1));
  if (sub === 'unhold' || sub === 'unblock') return unholdAvail(argv.slice(1));
  if (sub === 'types') return typesAvail(argv.slice(1));
  if (sub === 'type') return typeAvail(argv.slice(1));
  console.error(`atris avail does not know "${sub}". Use show, set, slots, hold, holds, unhold, types, or type.`);
  printHelp();
  return 1;
}

// Verbs that only read. The CLI's account guard lets these run inside a
// project folder without --account; every other verb keeps the full guard.
const READ_VERBS = new Set(['show', 'get', 'slots', 'holds', 'blocks', 'types']);

function isReadOnlyAvail(argv = []) {
  const first = argv.find((a) => a !== '--account');
  if (!first || first.startsWith('-')) return true;
  return READ_VERBS.has(first.toLowerCase());
}

module.exports = {
  availCommand,
  isReadOnlyAvail,
  holdAvail,
  holdsAvail,
  unholdAvail,
  typesAvail,
  typeAvail,
  setRules,
  changeMeetingTypes,
  parseMinutesArg,
  parseMaxPerDay,
  parseHoldArgs,
  buildHoldBodies,
  buildOffPayload,
  resolveHoldDate,
  zonedIso,
  weeklyHoursOff,
  formatBookingLink,
  parseTimeToDecimal,
  parseDaysArg,
  parseSlotsDays,
  parseSetArgs,
  buildAvailableHours,
  resolveTimezone,
  formatDecimalHour,
};
