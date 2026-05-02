/**
 * Integration commands for Atris CLI
 *
 * Usage:
 *   atris gmail inbox       - List recent emails
 *   atris gmail read <id>   - Read specific email
 *   atris calendar today    - Show today's events
 *   atris calendar week     - Show this week's events
 *   atris twitter post      - Post a tweet (interactive)
 *   atris slack channels    - List Slack channels
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

async function calendarToday() {
  const { token, email } = await getAuth();

  console.log('📅 Today\'s events:\n');

  const result = await apiRequestJson('/integrations/google-calendar/events/today', {
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

  if (events.length === 0) {
    console.log('No events today. 🎉');
    return;
  }

  console.log('─'.repeat(50));

  for (const event of events) {
    const start = event.start?.dateTime || event.start?.date || '';
    const time = start ? new Date(start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'All day';
    const title = event.summary || '(no title)';

    console.log(`${time}  ${title}`);
    if (event.location) {
      console.log(`        📍 ${event.location}`);
    }
  }

  console.log('─'.repeat(50));
}

async function calendarCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'today':
      await calendarToday();
      break;
    case 'week':
      console.log('Week view coming soon...');
      break;
    default:
      console.log('Calendar commands:');
      console.log('  atris calendar today    - Show today\'s events');
      console.log('  atris calendar week     - Show this week\'s events');
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

  const result = await apiRequestJson('/integrations/slack/channels', {
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
    console.log(`  ${priv} ${name}`);
  }
}

async function slackCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'channels':
    case 'list':
      await slackChannels();
      break;
    default:
      console.log('Slack commands:');
      console.log('  atris slack channels    - List Slack channels');
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
    default:
      console.log('iMessage commands:');
      console.log('  atris imessage doctor [--json]   - Check local Messages access');
      console.log('  atris imessage recent <handle>   - Read recent local messages');
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
