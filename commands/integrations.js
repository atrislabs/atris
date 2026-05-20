/**
 * Integration commands for Atris CLI
 *
 * Usage:
 *   atris gmail inbox       - List recent emails
 *   atris gmail read <id>   - Read specific email
 *   atris calendar today    - Show today's events
 *   atris calendar yesterday - Show yesterday's events
 *   atris calendar week     - Show this week's events
 *   atris calendar date YYYY-MM-DD - Show events on a date
 *   atris twitter post      - Post a tweet (interactive)
 *   atris slack channels    - List Slack channels
 *   atris slack messages <channel> [--limit 20] - Read recent messages
 *   atris slack search <query> [--limit 20] - Search Slack messages
 */

const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

async function getAuth() {
  const ensured = await ensureValidCredentials(apiRequestJson);
  const creds = ensured.error ? null : ensured.credentials;
  if (!creds || !creds.token) {
    if (ensured.error && ensured.error !== 'not_logged_in') {
      console.error(`Authentication failed: ${ensured.detail || ensured.error}. Run: atris login`);
    } else {
      console.error('Not logged in. Run: atris login');
    }
    process.exit(1);
  }
  return { token: creds.token, email: creds.email || 'unknown' };
}

async function getAuthToken() {
  return (await getAuth()).token;
}

// ============================================================================
// GMAIL
// ============================================================================

async function gmailInbox(options = {}) {
  const { token, email } = await getAuth();
  const limit = options.limit || 10;

  console.log('📬 Fetching inbox...\n');

  const result = await apiRequestJson(`/integrations/gmail/messages?max_results=${limit}`, {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    if (result.status === 400 || result.status === 401) {
      console.error(`Gmail not connected for ${email}.`);
      console.error('Connect at: https://atris.ai/dashboard/settings');
      console.error(`Make sure you're signed in as ${email} on the web.`);
    } else {
      console.error(`Error: ${result.error || 'Failed to fetch inbox'}`);
    }
    process.exit(1);
  }

  const messages = result.data?.messages || result.data || [];

  if (messages.length === 0) {
    console.log('No messages found.');
    return;
  }

  console.log(`Found ${messages.length} messages:\n`);
  console.log('─'.repeat(60));

  for (const msg of messages) {
    const from = msg.from || msg.sender || 'Unknown';
    const subject = msg.subject || '(no subject)';
    const date = msg.date || msg.received_at || '';
    const id = msg.id || msg.message_id || '';

    console.log(`From: ${from}`);
    console.log(`Subj: ${subject}`);
    console.log(`Date: ${date}`);
    console.log(`ID:   ${id}`);
    console.log('─'.repeat(60));
  }
}

async function gmailRead(messageId) {
  if (!messageId) {
    console.error('Usage: atris gmail read <message_id>');
    process.exit(1);
  }

  const token = await getAuthToken();

  console.log('📧 Fetching message...\n');

  const result = await apiRequestJson(`/integrations/gmail/messages/${messageId}`, {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to fetch message'}`);
    process.exit(1);
  }

  const msg = result.data;

  console.log('─'.repeat(60));
  console.log(`From:    ${msg.from || 'Unknown'}`);
  console.log(`To:      ${msg.to || 'Unknown'}`);
  console.log(`Subject: ${msg.subject || '(no subject)'}`);
  console.log(`Date:    ${msg.date || ''}`);
  console.log('─'.repeat(60));
  console.log('');
  console.log(msg.body || msg.snippet || '(no body)');
}

async function gmailCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'inbox':
    case 'list':
      await gmailInbox();
      break;
    case 'read':
      await gmailRead(args[0]);
      break;
    default:
      console.log('Gmail commands:');
      console.log('  atris gmail inbox       - List recent emails');
      console.log('  atris gmail read <id>   - Read specific email');
  }
}

// ============================================================================
// CALENDAR
// ============================================================================

function localDayBounds(offsetDays = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function localDateBounds(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) {
    console.error('Usage: atris calendar date YYYY-MM-DD');
    process.exit(1);
  }
  const start = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    console.error('Invalid date. Use YYYY-MM-DD.');
    process.exit(1);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function calendarEventTimeValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.dateTime || value.date || '';
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function formatCalendarTimeRange(event) {
  const start = calendarEventTimeValue(event.start || event.start_time || event.startTime);
  const end = calendarEventTimeValue(event.end || event.end_time || event.endTime);
  if (!start || isDateOnly(start)) return 'All day';
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return 'Time unavailable';
  const startText = startDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (!end || isDateOnly(end)) return startText;
  const endDate = new Date(end);
  if (Number.isNaN(endDate.getTime())) return startText;
  return `${startText}-${endDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatCalendarEvents(label, events) {
  if (events.length === 0) {
    console.log(`No events ${label}. 🎉`);
    return;
  }

  console.log('─'.repeat(50));

  for (const event of events) {
    const time = formatCalendarTimeRange(event);
    const title = event.summary || '(no title)';

    console.log(`${time}  ${title}`);
    if (event.location) {
      console.log(`        📍 ${event.location}`);
    }
  }

  console.log('─'.repeat(50));
}

async function calendarRange(label, { timeMin, timeMax, days } = {}) {
  const { token, email } = await getAuth();

  console.log(`📅 ${label}:\n`);

  const params = new URLSearchParams();
  if (timeMin) params.set('time_min', timeMin);
  if (timeMax) params.set('time_max', timeMax);
  if (days) params.set('days', String(days));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const result = await apiRequestJson(`/integrations/google-calendar/events${suffix}`, {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    if (result.status === 400 || result.status === 401) {
      console.error(`Calendar not connected for ${email}.`);
      console.error('Connect at: https://atris.ai/dashboard/settings');
      console.error(`Make sure you're signed in as ${email} on the web.`);
    } else {
      console.error(`Error: ${result.error || 'Failed to fetch events'}`);
    }
    process.exit(1);
  }

  const events = result.data?.events || result.data || [];
  formatCalendarEvents(label.toLowerCase(), events);
}

async function calendarToday() {
  await calendarRange("Today's events", { days: 1 });
}

async function calendarYesterday() {
  const { start, end } = localDayBounds(-1);
  await calendarRange("Yesterday's events", { timeMin: start.toISOString(), timeMax: end.toISOString() });
}

async function calendarWeek() {
  await calendarRange("This week's events", { days: 7 });
}

async function calendarDate(dateText) {
  const { start, end } = localDateBounds(dateText);
  await calendarRange(`Events on ${dateText}`, { timeMin: start.toISOString(), timeMax: end.toISOString() });
}

async function calendarCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'today':
      await calendarToday();
      break;
    case 'yesterday':
    case 'yday':
      await calendarYesterday();
      break;
    case 'week':
      await calendarWeek();
      break;
    case 'date':
      await calendarDate(args[0]);
      break;
    default:
      console.log('Calendar commands:');
      console.log('  atris calendar today          - Show today\'s events');
      console.log('  atris calendar yesterday      - Show yesterday\'s events');
      console.log('  atris calendar week           - Show this week\'s events');
      console.log('  atris calendar date YYYY-MM-DD - Show events on a date');
  }
}

// ============================================================================
// TWITTER
// ============================================================================

async function twitterPost(text) {
  const token = await getAuthToken();

  if (!text) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    text = await new Promise((resolve) => {
      rl.question('Tweet: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!text) {
    console.error('Tweet text is required');
    process.exit(1);
  }

  console.log('\n🐦 Posting tweet...');

  const result = await apiRequestJson('/integrations/twitter/tweet', {
    method: 'POST',
    token,
    body: { text },
  });

  if (!result.ok) {
    if (result.status === 400 || result.status === 401) {
      const { email } = await getAuth();
      console.error(`Twitter not connected for ${email}.`);
      console.error('Connect at: https://atris.ai/dashboard/settings');
      console.error(`Make sure you're signed in as ${email} on the web.`);
    } else {
      console.error(`Error: ${result.error || 'Failed to post tweet'}`);
    }
    process.exit(1);
  }

  console.log('✓ Tweet posted!');
  if (result.data?.id) {
    console.log(`  https://twitter.com/i/status/${result.data.id}`);
  }
}

async function twitterCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'post':
    case 'tweet':
      await twitterPost(args.join(' '));
      break;
    default:
      console.log('Twitter commands:');
      console.log('  atris twitter post [text]  - Post a tweet');
  }
}

// ============================================================================
// SLACK
// ============================================================================

async function slackChannels() {
  const token = await getAuthToken();

  console.log('💬 Fetching Slack channels...\n');

  const result = await apiRequestJson('/integrations/slack/me/channels', {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    if (result.status === 400 || result.status === 401) {
      const { email } = await getAuth();
      console.error(`Slack not connected for ${email}.`);
      console.error('Connect at: https://atris.ai/dashboard/settings');
      console.error(`Make sure you're signed in as ${email} on the web.`);
    } else {
      console.error(`Error: ${result.error || 'Failed to fetch channels'}`);
    }
    process.exit(1);
  }

  const channels = result.data?.channels || result.data || [];

  if (channels.length === 0) {
    console.log('No channels found.');
    return;
  }

  console.log('Channels:');
  for (const ch of channels) {
    const name = ch.name || ch.id;
    const priv = ch.is_private ? '🔒' : '#';
    console.log(`  ${priv} ${name}  ${ch.id || ''}`.trimEnd());
  }
}

async function slackDms() {
  const token = await getAuthToken();

  console.log('💬 Fetching Slack DMs...\n');

  const result = await apiRequestJson('/integrations/slack/me/dms', {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to fetch DMs'}`);
    process.exit(1);
  }

  const dms = result.data?.dms || result.data?.channels || result.data || [];
  if (!dms.length) {
    console.log('No DMs found.');
    return;
  }
  for (const dm of dms) {
    const name = dm.name || dm.user_name || dm.user || dm.id;
    console.log(`  ${name}  ${dm.id || ''}`.trimEnd());
  }
}

function parseLimit(args, fallback = 20) {
  const idx = args.findIndex((arg) => arg === '--limit' || arg === '-n');
  const raw = idx >= 0 ? args[idx + 1] : '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

function argsWithoutLimit(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--limit' || args[i] === '-n') {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

async function slackPersonalChannels(token) {
  const result = await apiRequestJson('/integrations/slack/me/channels', {
    method: 'GET',
    token,
  });
  if (!result.ok) return [];
  return result.data?.channels || result.data || [];
}

async function resolveSlackChannel(token, channel) {
  const text = String(channel || '').trim();
  if (!text) return '';
  if (/^[A-Z][A-Z0-9]{5,}$/.test(text)) return text;
  const wanted = text.replace(/^#/, '').toLowerCase();
  const channels = await slackPersonalChannels(token);
  const match = channels.find((ch) => String(ch.name || '').toLowerCase() === wanted || String(ch.id || '').toLowerCase() === wanted);
  return match?.id || text;
}

function formatSlackMessages(messages) {
  if (!messages.length) {
    console.log('No Slack messages found.');
    return;
  }
  console.log('─'.repeat(60));
  for (const message of messages) {
    const author = message.user_name || message.username || message.user || message.sender || 'unknown';
    const ts = message.datetime || message.time || message.ts || message.created_at || '';
    const text = String(message.text || message.content || message.message || '').replace(/\s+/g, ' ').trim();
    console.log(`${ts}  ${author}: ${text || '(no text)'}`);
  }
  console.log('─'.repeat(60));
}

async function slackMessages(channel, args = []) {
  if (!channel) {
    console.error('Usage: atris slack messages <channel-or-id> [--limit 20]');
    process.exit(1);
  }
  const token = await getAuthToken();
  const limit = parseLimit(args);
  const channelId = await resolveSlackChannel(token, channel);

  console.log(`💬 Reading Slack messages from ${channel}...\n`);

  const result = await apiRequestJson(`/integrations/slack/me/messages/${encodeURIComponent(channelId)}?limit=${limit}`, {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to fetch Slack messages'}`);
    process.exit(1);
  }

  const messages = result.data?.messages || result.data || [];
  formatSlackMessages(messages);
}

async function slackSearch(query, args = []) {
  if (!query) {
    console.error('Usage: atris slack search <query> [--limit 20]');
    process.exit(1);
  }
  const token = await getAuthToken();
  const limit = parseLimit(args);
  const q = encodeURIComponent(query);

  console.log(`💬 Searching Slack for "${query}"...\n`);

  const result = await apiRequestJson(`/integrations/slack/me/search?q=${q}&count=${limit}`, {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to search Slack messages'}`);
    process.exit(1);
  }

  const messages = result.data?.messages || result.data?.results || result.data || [];
  formatSlackMessages(messages);
}

async function slackCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'channels':
    case 'list':
      await slackChannels();
      break;
    case 'dms':
      await slackDms();
      break;
    case 'messages':
    case 'read':
      await slackMessages(args[0], args.slice(1));
      break;
    case 'search':
      await slackSearch(argsWithoutLimit(args).join(' '), args);
      break;
    default:
      console.log('Slack commands:');
      console.log('  atris slack channels             - List Slack channels');
      console.log('  atris slack dms                  - List Slack DMs');
      console.log('  atris slack messages <channel>   - Read recent messages');
      console.log('  atris slack search <query>       - Search Slack messages');
  }
}

// ============================================================================
// IMESSAGE
// ============================================================================

function imessageDoctor() {
  const chatDb = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  const checks = {
    macos: process.platform === 'darwin',
    chat_db_exists: false,
    chat_db_readable: false,
    sqlite3_available: false,
    osascript_available: false,
    messages_automation: false,
  };
  const issues = [];

  checks.chat_db_exists = fs.existsSync(chatDb);
  if (checks.chat_db_exists) {
    try {
      fs.accessSync(chatDb, fs.constants.R_OK);
      checks.chat_db_readable = true;
    } catch {
      issues.push('Messages database exists but is not readable. Grant Full Disk Access to this terminal or Atris.');
    }
  } else {
    issues.push('Messages database not found on this Mac.');
  }

  checks.sqlite3_available = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!checks.sqlite3_available) issues.push('sqlite3 is not available.');

  checks.osascript_available = spawnSync('osascript', ['-e', 'return "ok"'], { encoding: 'utf8' }).status === 0;
  if (!checks.osascript_available) issues.push('osascript is not available.');
  if (checks.osascript_available) {
    checks.messages_automation = spawnSync('osascript', ['-e', 'tell application "Messages" to count services'], {
      encoding: 'utf8',
      timeout: 4000,
    }).status === 0;
  }
  if (!checks.messages_automation) issues.push('Messages automation permission is not available yet.');

  if (!checks.macos) issues.push('Local iMessage requires macOS.');

  const connected = checks.macos && checks.chat_db_exists && checks.chat_db_readable && checks.sqlite3_available && checks.osascript_available && checks.messages_automation;
  return {
    connected,
    provider: 'local_imessage',
    mode: 'local',
    checks,
    issues,
    next_step: connected
      ? 'iMessage is available on this Mac.'
      : 'Open System Settings -> Privacy & Security -> Full Disk Access and allow your terminal or Atris, then run this check again.',
  };
}

function printImessageDoctor(result, json = false) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('iMessage local check\n');
  console.log(`Status: ${result.connected ? 'Connected on this Mac' : 'Needs permission or setup'}`);
  for (const [name, ok] of Object.entries(result.checks)) {
    console.log(`  ${ok ? '✓' : '✗'} ${name.replace(/_/g, ' ')}`);
  }
  if (result.issues.length) {
    console.log('\nNext:');
    for (const issue of result.issues) console.log(`  - ${issue}`);
    console.log(`  - ${result.next_step}`);
  }
}

function imessageRecent(handle, options = {}) {
  if (!handle) {
    console.error('Usage: atris imessage recent <phone-or-email> [--limit 20]');
    process.exit(1);
  }
  const doctor = imessageDoctor();
  if (!doctor.connected) {
    printImessageDoctor(doctor, Boolean(options.json));
    process.exit(1);
  }

  const limit = Number(options.limit || 20);
  const chatDb = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  const sql = `
    SELECT datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS ts,
           CASE m.is_from_me WHEN 1 THEN 'me' ELSE h.id END AS sender,
           replace(replace(COALESCE(m.text,''), char(10), ' '), char(13), ' ') AS text
    FROM message m
    JOIN handle h ON h.rowid = m.handle_id
    WHERE h.id = '${String(handle).replace(/'/g, "''")}'
    ORDER BY m.date DESC
    LIMIT ${Math.max(1, Math.min(100, limit))};
  `;
  const result = spawnSync('sqlite3', ['-readonly', chatDb, sql], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || 'Failed to read Messages database.');
    process.exit(1);
  }
  console.log(result.stdout.trim() || 'No recent messages found.');
}

function escapeSqlString(value) {
  return String(value || '').replace(/'/g, "''");
}

function normalizeLookupKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9@+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeImessageHandle(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw;
}

function normalizeContactLabel(value) {
  return String(value || '')
    .replace(/^_\$!<|>!\$_$/g, '')
    .replace(/^\$!<|>!\$$/g, '')
    .trim() || 'other';
}

function imessageLookupCachePath() {
  return path.join(os.homedir(), '.atris', 'cache', 'imessage-contacts.json');
}

function readImessageLookupCache() {
  const cachePath = imessageLookupCachePath();
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeImessageLookupCache(cache) {
  const cachePath = imessageLookupCachePath();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  return cachePath;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLatestOutgoingImessage(handle, sinceMs) {
  const chatDb = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  const sinceUnix = Math.max(0, Math.floor(Number(sinceMs || Date.now()) / 1000) - 5);
  const sql = `
    SELECT m.rowid,
           datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS ts,
           m.is_sent,
           m.is_delivered,
           m.is_finished,
           COALESCE(m.error, 0) AS error,
           length(COALESCE(m.text,'')) AS text_len
    FROM message m
    JOIN handle h ON h.rowid = m.handle_id
    WHERE h.id = '${escapeSqlString(handle)}'
      AND m.is_from_me = 1
      AND (m.date/1000000000 + 978307200) >= ${sinceUnix}
    ORDER BY m.date DESC
    LIMIT 1;
  `;
  const result = spawnSync('sqlite3', ['-readonly', chatDb, sql], { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      matched: false,
      error: (result.stderr || 'Failed to verify latest outgoing iMessage.').trim(),
    };
  }
  const row = String(result.stdout || '').trim();
  if (!row) {
    return {
      matched: false,
      error: 'No outgoing Messages row found after send.',
    };
  }
  const [rowid, ts, isSent, isDelivered, isFinished, messageError, textLen] = row.split('|');
  return {
    matched: true,
    rowid,
    timestamp: ts,
    is_sent: Number(isSent) === 1,
    is_delivered: Number(isDelivered) === 1,
    is_finished: Number(isFinished) === 1,
    message_error: Number(messageError) || 0,
    text_readable: Number(textLen) > 0,
  };
}

function imessageVerifyLatestOutgoing(handle, sinceMs, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 2000));
  const intervalMs = Math.max(25, Number(options.intervalMs || 150));
  const startedAt = Date.now();
  let latest = readLatestOutgoingImessage(handle, sinceMs);
  while (
    latest.matched
    && latest.message_error === 0
    && !(latest.is_sent || latest.is_delivered || latest.is_finished)
    && Date.now() - startedAt < timeoutMs
  ) {
    sleepMs(intervalMs);
    latest = readLatestOutgoingImessage(handle, sinceMs);
  }
  return {
    ...latest,
    settled: Boolean(latest.matched && latest.message_error === 0 && (latest.is_sent || latest.is_delivered || latest.is_finished)),
    waited_ms: Date.now() - startedAt,
  };
}

function parseImessageLookupArgs(args) {
  const options = {
    json: false,
    refresh: false,
    name: '',
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--refresh') {
      options.refresh = true;
    } else if (arg === '--name' || arg === '--query') {
      options.name = args[i + 1] || '';
      i += 1;
    } else if (arg === '--max-age-minutes') {
      options.maxAgeMs = Math.max(0, Number(args[i + 1] || 0) * 60 * 1000);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  if (!options.name && positional.length) options.name = positional.join(' ');
  options.name = String(options.name || '').trim();
  return options;
}

const CONTACT_LOOKUP_SCRIPT = `
function run(argv) {
  const query = String(argv[0] || '').trim();
  const Contacts = Application('Contacts');
  const selfAlias = /^(me|myself|self|my number|my phone|my contact)$/i.test(query);
  function safe(fn) {
    try {
      const value = fn();
      return value === null || value === undefined ? '' : String(value);
    } catch (error) {
      return '';
    }
  }
  function propertyRows(rows) {
    const out = [];
    try {
      const list = rows();
      for (let i = 0; i < list.length; i += 1) {
        const item = list[i];
        out.push({
          label: safe(function () { return item.label(); }),
          value: safe(function () { return item.value(); })
        });
      }
    } catch (error) {}
    return out.filter(function (row) { return row.value; });
  }
  function contactRow(person) {
    return {
      id: safe(function () { return person.id(); }),
      name: safe(function () { return person.name(); }),
      first_name: safe(function () { return person.firstName(); }),
      last_name: safe(function () { return person.lastName(); }),
      organization: safe(function () { return person.organization(); }),
      phones: propertyRows(function () { return person.phones(); }),
      emails: propertyRows(function () { return person.emails(); })
    };
  }
  let people = [];
  if (selfAlias) {
    if (Contacts.myCard.exists()) people = [Contacts.myCard];
  } else {
    people = Contacts.people.whose({ name: { _contains: query } })();
    if (!people.length && query.indexOf(' ') > -1) {
      people = Contacts.people.whose({ name: { _contains: query.split(/\\s+/)[0] } })();
    }
  }
  const rows = [];
  const limit = Math.min(20, people.length);
  for (let i = 0; i < limit; i += 1) rows.push(contactRow(people[i]));
  return JSON.stringify({ ok: true, query: query, self_alias: selfAlias, contacts_count: people.length, matches: rows });
}
`;

function scoreImessageContact(query, match, selfAlias = false) {
  if (selfAlias) return 100;
  const q = normalizeLookupKey(query);
  const name = normalizeLookupKey(match.name);
  if (!q || !name) return 0;
  if (name === q) return 95;
  if (name.includes(q)) return 80;
  const tokens = q.split(' ').filter(Boolean);
  const nameTokens = new Set(name.split(' ').filter(Boolean));
  if (tokens.length && tokens.every((token) => nameTokens.has(token))) return 75;
  if (tokens.length === 1 && nameTokens.has(tokens[0])) return 65;
  return 40;
}

function shapeImessageLookupPayload(raw, options, cached = false, cachedAt = null) {
  const query = options.name;
  const selfAlias = Boolean(raw.self_alias);
  const matches = (raw.matches || [])
    .map((match) => {
      const phones = (match.phones || [])
        .map((phone) => ({
          label: normalizeContactLabel(phone.label),
          value: String(phone.value || '').trim(),
          handle: normalizeImessageHandle(phone.value),
        }))
        .filter((phone) => phone.handle);
      const emails = (match.emails || [])
        .map((email) => ({
          label: normalizeContactLabel(email.label),
          value: String(email.value || '').trim(),
          handle: String(email.value || '').trim(),
        }))
        .filter((email) => email.handle);
      const handles = [
        ...phones.map((phone) => ({ type: 'phone', label: phone.label, handle: phone.handle })),
        ...emails.map((email) => ({ type: 'email', label: email.label, handle: email.handle })),
      ];
      return {
        id: match.id || '',
        name: match.name || [match.first_name, match.last_name].filter(Boolean).join(' '),
        phones,
        emails,
        handles,
        primary_handle: handles[0]?.handle || '',
        score: scoreImessageContact(query, match, selfAlias),
      };
    })
    .filter((match) => match.primary_handle)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const exactMatches = matches.filter((match) => normalizeLookupKey(match.name) === normalizeLookupKey(query));
  const primary = matches.length === 1
    ? matches[0]
    : exactMatches.length === 1
      ? exactMatches[0]
      : null;
  return {
    ok: true,
    action: 'imessage_lookup',
    provider: 'local_contacts',
    query,
    cached,
    cached_at: cachedAt,
    cache_path: imessageLookupCachePath(),
    match_count: matches.length,
    unique: Boolean(primary),
    ambiguous: matches.length > 1 && !primary,
    primary: primary ? {
      name: primary.name,
      handle: primary.primary_handle,
      handles: primary.handles,
    } : null,
    matches,
  };
}

function printImessageLookupPayload(payload, json = false) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (!payload.ok) {
    console.error(payload.error || 'Contact lookup failed.');
    return;
  }
  if (!payload.matches.length) {
    console.log(`No iMessage contacts found for "${payload.query}".`);
    return;
  }
  if (payload.primary) {
    console.log(`${payload.primary.name}: ${payload.primary.handle}${payload.cached ? ' (cached)' : ''}`);
    return;
  }
  console.log(`Multiple matches for "${payload.query}":`);
  for (const match of payload.matches.slice(0, 8)) {
    console.log(`  - ${match.name}: ${match.primary_handle}`);
  }
}

function imessageLookup(args = []) {
  const options = parseImessageLookupArgs(args);
  if (!options.name) {
    printImessageLookupPayload({
      ok: false,
      action: 'imessage_lookup',
      error: 'Usage: atris imessage lookup --name <contact-name> [--json] [--refresh]',
    }, options.json);
    process.exit(1);
  }

  const key = normalizeLookupKey(options.name);
  const cache = readImessageLookupCache();
  const entry = cache.entries?.[key];
  if (!options.refresh && entry && Date.now() - Number(entry.cached_at || 0) <= options.maxAgeMs) {
    printImessageLookupPayload(shapeImessageLookupPayload(entry.raw, options, true, entry.cached_at), options.json);
    return;
  }

  const result = spawnSync('osascript', ['-l', 'JavaScript', '-e', CONTACT_LOOKUP_SCRIPT, options.name], {
    encoding: 'utf8',
    timeout: 6000,
  });
  if (result.status !== 0) {
    printImessageLookupPayload({
      ok: false,
      action: 'imessage_lookup',
      query: options.name,
      error: (result.stderr || 'Contacts lookup failed. Grant Contacts automation permission to this terminal or Atris.').trim(),
    }, options.json);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(String(result.stdout || '{}'));
  } catch {
    printImessageLookupPayload({
      ok: false,
      action: 'imessage_lookup',
      query: options.name,
      error: 'Contacts lookup returned invalid JSON.',
    }, options.json);
    process.exit(1);
  }

  const cachedAt = Date.now();
  const latestCache = readImessageLookupCache();
  latestCache.version = 1;
  latestCache.entries = latestCache.entries || {};
  latestCache.entries[key] = { cached_at: cachedAt, raw };
  writeImessageLookupCache(latestCache);
  printImessageLookupPayload(shapeImessageLookupPayload(raw, options, false, cachedAt), options.json);
}

function parseImessageSendArgs(args) {
  const options = {
    approved: false,
    json: false,
    receipt: false,
    to: '',
    text: '',
  };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--approved' || arg === '--confirm-approved') {
      options.approved = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--receipt') {
      options.receipt = true;
    } else if (arg === '--to' || arg === '--handle') {
      options.to = args[i + 1] || '';
      i += 1;
    } else if (arg === '--text' || arg === '--message') {
      options.text = args[i + 1] || '';
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  if (!options.to && positional.length) options.to = positional.shift() || '';
  if (!options.text && positional.length) options.text = positional.join(' ');
  options.to = normalizeImessageHandle(options.to);
  options.text = String(options.text || '').trim();
  return options;
}

function printImessageSendPayload(payload, json = false) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.ok) {
    console.log(`Sent iMessage to ${payload.to}.`);
    if (payload.receipt_path) console.log(`Receipt: ${payload.receipt_path}`);
  } else {
    console.error(payload.error || 'Failed to send iMessage.');
  }
}

function writeImessageSendReceipt(payload) {
  const atrisDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(atrisDir)) return '';
  const runsDir = path.join(atrisDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const receiptPath = path.join(runsDir, `imessage-send-${stamp}.md`);
  const lines = [
    '# iMessage Send Receipt',
    '',
    `- Sent at: ${payload.sent_at}`,
    `- Provider: ${payload.provider}`,
    `- To: ${payload.to}`,
    `- Text: ${payload.text}`,
    `- Doctor connected: ${payload.doctor?.connected === true}`,
    `- Send exit: ${payload.osascript?.status}`,
    `- DB verified: ${payload.db_verification?.matched === true}`,
    `- DB settled: ${payload.db_verification?.settled === true}`,
  ];
  fs.writeFileSync(receiptPath, `${lines.join('\n')}\n`, 'utf8');
  return receiptPath;
}

function imessageSend(args = []) {
  const options = parseImessageSendArgs(args);
  const basePayload = {
    ok: false,
    action: 'imessage_send',
    provider: 'local_imessage',
    to: options.to,
    text: options.text,
    approved: options.approved,
  };

  if (!options.to || !options.text) {
    printImessageSendPayload({
      ...basePayload,
      error: 'Usage: atris imessage send --to <phone-or-email> --text <message> --approved [--json] [--receipt]',
    }, options.json);
    process.exit(1);
  }

  if (!options.approved) {
    printImessageSendPayload({
      ...basePayload,
      error: 'Refusing to send without --approved after the exact recipient and exact text are confirmed.',
    }, options.json);
    process.exit(1);
  }

  const doctor = imessageDoctor();
  if (!doctor.connected) {
    printImessageSendPayload({
      ...basePayload,
      doctor,
      error: 'iMessage is not available on this Mac.',
    }, options.json);
    process.exit(1);
  }

  const sendStartedAt = Date.now();
  const result = spawnSync('osascript', [
    '-e', 'on run argv',
    '-e', 'set targetHandle to item 1 of argv',
    '-e', 'set messageText to item 2 of argv',
    '-e', 'tell application "Messages"',
    '-e', 'set targetService to 1st service whose service type = iMessage',
    '-e', 'set targetBuddy to buddy targetHandle of targetService',
    '-e', 'send messageText to targetBuddy',
    '-e', 'end tell',
    '-e', 'return targetHandle',
    '-e', 'end run',
    options.to,
    options.text,
  ], {
    encoding: 'utf8',
    timeout: 10000,
  });

  const payload = {
    ...basePayload,
    ok: result.status === 0,
    sent_at: new Date().toISOString(),
    doctor: {
      connected: doctor.connected,
      checks: doctor.checks,
    },
    osascript: {
      status: result.status,
      signal: result.signal || null,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
    },
  };

  if (payload.ok) {
    payload.db_verification = imessageVerifyLatestOutgoing(options.to, sendStartedAt);
  }

  if (payload.ok && options.receipt) {
    payload.receipt_path = writeImessageSendReceipt(payload);
  }

  if (!payload.ok) {
    payload.error = payload.osascript.stderr || 'Messages AppleScript send failed.';
  }

  printImessageSendPayload(payload, options.json);
  if (!payload.ok) process.exit(1);
}

async function imessageCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'doctor': {
      const json = args.includes('--json');
      const result = imessageDoctor();
      printImessageDoctor(result, json);
      if (!result.connected && args.includes('--strict')) process.exit(1);
      break;
    }
    case 'recent': {
      const handle = args[0];
      const limitFlag = args.findIndex((x) => x === '--limit');
      const limit = limitFlag >= 0 ? args[limitFlag + 1] : 20;
      imessageRecent(handle, { limit, json: args.includes('--json') });
      break;
    }
    case 'lookup': {
      imessageLookup(args);
      break;
    }
    case 'send': {
      imessageSend(args);
      break;
    }
    default:
      console.log('iMessage commands:');
      console.log('  atris imessage doctor [--json]   - Check local Messages access');
      console.log('  atris imessage lookup --name <name> [--json] [--refresh]');
      console.log('  atris imessage recent <handle>   - Read recent local messages');
      console.log('  atris imessage send --to <handle> --text <text> --approved [--json] [--receipt]');
  }
}

// ============================================================================
// STATUS
// ============================================================================

async function integrationsStatus() {
  const token = await getAuthToken();

  console.log('🔌 Integration Status:\n');

  const integrations = ['gmail', 'google-calendar', 'slack', 'twitter', 'github'];

  for (const name of integrations) {
    try {
      const result = await apiRequestJson(`/integrations/${name}/status`, {
        method: 'GET',
        token,
      });

      const connected = result.ok && result.data?.connected;
      const icon = connected ? '✅' : '❌';
      const displayName = name.replace('google-', '').replace('-', ' ');
      console.log(`  ${icon} ${displayName}`);
    } catch {
      console.log(`  ❓ ${name}`);
    }
  }

  const imessage = imessageDoctor();
  console.log(`  ${imessage.connected ? '✅' : '❌'} iMessage (local Mac)`);

  console.log('\nConnect integrations at: https://atris.ai/dashboard/settings');
}

module.exports = {
  gmailCommand,
  calendarCommand,
  twitterCommand,
  slackCommand,
  imessageCommand,
  imessageDoctor,
  integrationsStatus,
};
