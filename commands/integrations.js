/**
 * Integration commands for Atris CLI
 *
 * Usage:
 *   atris gmail inbox [--account <id>]       - List recent emails for a mailbox
 *   atris gmail read <id> [--account <id>]   - Read specific email
 *   atris gmail archive <id> [...] [--account <id>] - Archive messages
 *   atris gmail triage [--account <id>] [--limit N] - Record keep or archive verdicts
 *   atris gmail verdicts [--summary] [--account <id>] [--limit N] - List recent Gmail verdicts
 *   atris gmail send <to> <subject> <body...> --approved [--body-file <path>] [--account <id>] - Send an email
 *   atris gmail voice [account] [--clear]    - Edit an account's writing voice
 *   atris gmail connect [name]              - Connect or reconnect a Gmail account
 *   atris gmail accounts                     - List connected Gmail accounts and the active account
 *   atris gmail use [<account_id|name>]      - Choose or set the active Gmail account
 *   atris calendar today    - Show today's events
 *   atris calendar yesterday - Show yesterday's events
 *   atris calendar week     - Show this week's events
 *   atris calendar date YYYY-MM-DD - Show events on a date
 *   atris calendar search <query> [--days 30] [--limit 20] [--timeout-ms 10000] [--json] - Search upcoming events
 *   atris twitter post      - Post a tweet (interactive)
 *   atris slack channels    - List Slack channels
 *   atris slack messages <channel> [--limit 20] - Read recent messages
 *   atris slack search <query> [--limit 20] - Search Slack messages
 */

const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson: rawApiRequestJson } = require('../utils/api');
const { AsyncLocalStorage } = require('async_hooks');
const { createHash } = require('crypto');
const { resolveBusiness } = require('../lib/business-target');
const googleContext = new AsyncLocalStorage();

function apiRequestJson(url, options = {}) {
  const context = googleContext.getStore();
  if (!context || !/^\/integrations\/(gmail|google-calendar|google)(?:\/|$)/.test(url)) return rawApiRequestJson(url, options);
  const next = { ...options };
  if (context.business) next.headers = { ...(options.headers || {}), 'X-Business-Id': context.business };
  if (context.calendarAccount && url.startsWith('/integrations/google-calendar/')) {
    if ((options.method || 'GET') === 'GET' || options.method === 'DELETE') {
      url += `${url.includes('?') ? '&' : '?'}account_id=${encodeURIComponent(context.calendarAccount)}`;
    } else next.body = { ...(options.body || {}), account_id: context.calendarAccount };
  }
  if (context.serverDefaults && !context.mailAccount && url.startsWith('/integrations/gmail/') && !/\/accounts|\/start/.test(url)) {
    const parts = url.split('?');
    if (parts[1]) { const q = new URLSearchParams(parts[1]); q.delete('account_id'); url = parts[0] + (q.toString() ? `?${q}` : ''); }
    if (next.body && Object.hasOwn(next.body, 'account_id')) { next.body = { ...next.body }; delete next.body.account_id; }
  }
  return rawApiRequestJson(url, next);
}

function takeContext(args) {
  const rest = []; let businessFlag; let calendarAccount; let mailAccount;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--business' || arg.startsWith('--business=')) {
      businessFlag = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (!businessFlag || String(businessFlag).startsWith('--')) throw new Error('--business needs a business slug or id');
    } else if (arg === '--account' || arg.startsWith('--account=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (!value || String(value).startsWith('--')) throw new Error('--account needs an account name or email');
      calendarAccount = mailAccount = String(value);
      rest.push('--account', String(value));
    } else rest.push(args[i]);
  }
  const business = resolveBusiness(businessFlag === undefined ? {} : { business: businessFlag });
  if (business && business.error) throw new Error(business.error);
  return { rest, business: business && business.id, explicitBusiness: businessFlag !== undefined, calendarAccount, mailAccount };
}

const {
  assertOutboundSendAllowedOrExit,
  extractOutboundGateOptions,
  prepareOutboundSendTextOrExit,
} = require('../lib/outbound-send-gate');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateHome } = require('../lib/state-home');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { sleepSync } = require('../lib/sleep-sync');

const CALENDAR_CACHE_PATH = path.join(stateHome(), '.atris', 'calendar-events-cache.json');
const GMAIL_CONNECT_POLL_MS = 3000;
const GMAIL_CONNECT_TIMEOUT_MS = 3 * 60 * 1000;
const GMAIL_SEND_USAGE = 'usage: atris gmail send <to> <subject> <body...> --approved [--body-file <path>] [--account <id>]';
const GMAIL_VOICE_USAGE = 'usage: atris gmail voice [account] [--clear]';
const GMAIL_TRIAGE_USAGE = 'usage: atris gmail triage [--account <id>] [--limit N]';
const GMAIL_VERDICTS_USAGE = 'usage: atris gmail verdicts [--summary] [--account <id>] [--limit N]';
const GMAIL_BULK_DOMAINS = [
  'campaign-archive.com',
  'constantcontact.com',
  'hubspotemail.net',
  'mailchimp.com',
  'mailchimpapp.net',
  'mailgun.org',
  'sendgrid.net',
  'substack.com',
];

function gmailVerdictsPath(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'gmail-verdicts.jsonl');
}

function appendGmailVerdicts(verdicts, options = {}) {
  const rows = Array.isArray(verdicts) ? verdicts : [];
  if (!rows.length) return;
  const filePath = options.filePath || gmailVerdictsPath(options.root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = rows.map((row) => JSON.stringify({
    ts: row.ts || new Date().toISOString(),
    account: String(row.account || ''),
    verdict: row.verdict === 'keep' ? 'keep' : 'archive',
    message_id: String(row.message_id || ''),
    ...(row.from ? { from: row.from } : {}),
    ...(row.subject ? { subject: row.subject } : {}),
    ...(typeof row.reason === 'string' && row.reason ? { reason: row.reason } : {}),
  }));
  fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function readGmailVerdicts(options = {}) {
  const filePath = options.filePath || gmailVerdictsPath(options.root);
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const account = String(options.account || '').trim();
  const limit = options.limit === null ? null : (Number.isInteger(options.limit) ? options.limit : 20);
  const rows = lines.reduce((matches, line) => {
    try {
      const row = JSON.parse(line);
      if (!account || row.account === account) matches.push(row);
    } catch {}
    return matches;
  }, []).reverse();
  return limit === null ? rows : rows.slice(0, limit);
}

function summarizeGmailVerdicts(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const date = String(row.ts || '').slice(0, 10);
    const account = String(row.account || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const key = `${date}\n${account}`;
    const summary = groups.get(key) || { date, account, keep: 0, archive: 0 };
    summary[row.verdict === 'keep' ? 'keep' : 'archive'] += 1;
    groups.set(key, summary);
  }
  return [...groups.values()].sort((left, right) => (
    right.date.localeCompare(left.date) || left.account.localeCompare(right.account)
  ));
}

function printGmailVerdicts(options = {}) {
  const rows = readGmailVerdicts(options.summary ? { ...options, limit: null } : options);
  if (options.summary) {
    const summaries = summarizeGmailVerdicts(rows);
    if (!summaries.length) {
      console.log('no gmail verdicts found.');
      return summaries;
    }
    for (const row of summaries) {
      console.log(`${row.date} account ${row.account}, keep ${row.keep}, archive ${row.archive}`);
    }
    return summaries;
  }
  if (!rows.length) {
    console.log('no gmail verdicts found.');
    return rows;
  }
  for (const row of rows) {
    const details = [
      row.reason && `reason ${row.reason}`,
      row.from && `from ${row.from}`,
      row.subject && `subject ${row.subject}`,
    ].filter(Boolean);
    console.log(`${row.ts} ${row.verdict || 'archive'} ${row.message_id} account ${row.account}${details.length ? `, ${details.join(', ')}` : ''}`);
  }
  return rows;
}

function parseGmailTriageArgs(args = []) {
  let accountId = null;
  let limit = 25;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = String(args[i + 1] || '').trim();
    if (arg === '--account' && value && !value.startsWith('--')) accountId = value;
    else if (arg === '--limit' && /^\d+$/.test(value) && Number(value) > 0) limit = Number(value);
    else {
      console.error(GMAIL_TRIAGE_USAGE);
      process.exit(1);
    }
    i += 1;
  }
  return { accountId, limit };
}

function parseGmailVerdictsArgs(args = []) {
  let account = null;
  let limit = 20;
  let summary = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = String(args[i + 1] || '').trim();
    if (arg === '--summary') {
      summary = true;
      continue;
    }
    if (arg === '--account' && value && !value.startsWith('--')) account = value;
    else if (arg === '--limit' && /^\d+$/.test(value) && Number(value) > 0) limit = Number(value);
    else {
      console.error(GMAIL_VERDICTS_USAGE);
      process.exit(1);
    }
    i += 1;
  }
  return { account, limit, summary };
}

function gmailAccountStatePath() {
  return process.env.ATRIS_GMAIL_ACCOUNT_FILE
    || path.join(stateHome(), '.atris', 'gmail-account.json');
}

function readGmailStickyAccount() {
  try {
    const data = JSON.parse(fs.readFileSync(gmailAccountStatePath(), 'utf8'));
    const id = String(data.account_id || '').trim();
    return id || null;
  } catch {
    return null;
  }
}

function writeGmailStickyAccount(accountId) {
  const filePath = gmailAccountStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ account_id: accountId }, null, 2)}\n`, 'utf8');
}

function mailMigrationRecord(auth) {
  const markerPath = `${gmailAccountStatePath()}.migrated`;
  let subject = '';
  try { subject = JSON.parse(Buffer.from(auth.token.split('.')[1], 'base64url').toString()).sub || ''; } catch {}
  const owner = auth.userId || (auth.email !== 'unknown' ? auth.email.toLowerCase() : subject || auth.token);
  const identity = createHash('sha256').update(owner).digest('hex');
  let migrated = {};
  try { migrated = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch {}
  if (!migrated || typeof migrated !== 'object' || Array.isArray(migrated)) migrated = {};
  return { markerPath, identity, migrated };
}

function markMailMigration(record) {
  record.migrated[record.identity] = true;
  fs.mkdirSync(path.dirname(record.markerPath), { recursive: true });
  fs.writeFileSync(record.markerPath, `${JSON.stringify(record.migrated)}\n`, { mode: 0o600 });
}

async function googleAccountsCapability(token, { refresh = false } = {}) {
  const context = googleContext.getStore();
  if (!refresh && context?.googleCapability) return context.googleCapability;
  const result = await apiRequestJson('/integrations/google/accounts', { method: 'GET', token });
  if (!result.ok && result.status !== 404) {
    const error = new Error(`could not check google accounts: ${result.error || result.data?.detail || 'request failed'}`);
    error.status = result.status || 0;
    throw error;
  }
  if (result.ok && !Array.isArray(result.data?.accounts)) throw new Error('could not check google accounts: the server returned an incomplete account list');
  const capability = { supported: result.ok, data: result.data || {} };
  if (context) context.googleCapability = capability;
  return capability;
}

async function prepareMailDefaults(context, { migrate = true } = {}) {
  const auth = await getAuth();
  const capability = await googleAccountsCapability(auth.token);
  if (!capability.supported) {
    const sticky = readGmailStickyAccount();
    if (sticky && sticky.includes('@')) {
      const account = resolveAccountSelector(await fetchGmailAccounts(auth.token), sticky);
      if (!account) throw new Error('saved gmail account is not connected');
      context.resolvedMail = gmailAccountIdentity(account).id;
    }
    return;
  }
  let data = capability.data;
  if (!data || !Array.isArray(data.accounts) || !data.defaults || !Object.hasOwn(data.defaults, 'gmail') || !data.resolved || !Object.hasOwn(data.resolved, 'gmail')) {
    throw new Error('could not resolve mail account: the server returned an incomplete account list');
  }
  const record = mailMigrationRecord(auth);
  if (migrate && !record.migrated[record.identity]) {
    const sticky = readGmailStickyAccount();
    const legacy = sticky && resolveAccountSelector(data.accounts, sticky);
    const eligible = legacy && legacy.products?.gmail?.connected;
    if (sticky && data.defaults.gmail == null && !eligible) console.error('saved mail account is no longer connected; using the server choice.');
    if (sticky && data.defaults.gmail == null && eligible) {
      const canonical = gmailAccountIdentity(legacy).id;
      const saved = await rawApiRequestJson('/integrations/google/defaults', {
        method: 'PUT', token: auth.token, body: { account_id: canonical, products: ['gmail'] },
      });
      if (!saved.ok) return googleFailure(saved, 'move the saved mail default');
      const refreshed = await googleAccountsCapability(auth.token, { refresh: true });
      if (!refreshed.supported) throw new Error('could not refresh mail account');
      data = refreshed.data;
      if (!data || !data.resolved || !Object.hasOwn(data.resolved, 'gmail')) throw new Error('could not refresh mail account');
    }
    markMailMigration(record);
  }
  context.serverDefaults = true;
  context.resolvedMail = data.resolved.gmail || null;
}

function resolveGmailAccountId(explicitId) {
  const trimmed = String(explicitId || '').trim();
  if (trimmed) return trimmed;
  const context = googleContext.getStore();
  if (context?.resolvedMail) return context.resolvedMail;
  const sticky = readGmailStickyAccount();
  if (sticky) return sticky;
  return 'default';
}

function gmailAccountIdentity(account = {}) {
  const id = String(account.account_id || account.id || 'default').trim() || 'default';
  const email = String(account.email_address || account.email || '').trim().toLowerCase();
  const name = String(account.display_name || account.name || id).trim().toLowerCase() || id.toLowerCase();
  return { id, email, name };
}

function sortGmailAccounts(accounts) {
  return [...accounts].sort((left, right) => {
    const leftIdentity = gmailAccountIdentity(left);
    const rightIdentity = gmailAccountIdentity(right);
    const leftDefault = leftIdentity.id.toLowerCase() === 'default';
    const rightDefault = rightIdentity.id.toLowerCase() === 'default';
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
    return leftIdentity.name.localeCompare(rightIdentity.name)
      || leftIdentity.id.localeCompare(rightIdentity.id);
  });
}

function formatGmailAccountRows(accounts, activeId = null) {
  const rows = sortGmailAccounts(accounts).map((account) => {
    const identity = gmailAccountIdentity(account);
    return { ...identity, emailLabel: identity.email || 'email pending' };
  });
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const emailWidth = Math.max(...rows.map((row) => row.emailLabel.length));
  const active = String(activeId || '').toLowerCase();
  return rows.map((row) => {
    const marker = row.id.toLowerCase() === active ? '  (active)' : '';
    return `${row.name.padEnd(nameWidth)}  ${row.emailLabel.padEnd(emailWidth)}${marker}`.trimEnd();
  });
}

async function fetchGmailAccounts(token, options = {}) {
  const result = await apiRequestJson('/integrations/gmail/accounts', {
    method: 'GET',
    token,
  });
  if (!result.ok) {
    if (options.quiet) return [];
    console.error(`Error: ${result.error || 'Failed to fetch accounts'}`);
    process.exit(1);
  }
  const accounts = result.data?.accounts || result.data || [];
  return Array.isArray(accounts) ? accounts : [];
}

function resolveAccountSelector(accounts, selector, { displayName = false } = {}) {
  const wanted = String(selector || '').trim().toLowerCase();
  if (!wanted) return null;
  const exact = accounts.filter((account) => {
    const identity = gmailAccountIdentity(account);
    return identity.id.toLowerCase() === wanted || identity.email === wanted;
  });
  const matches = exact.length || !displayName ? exact : accounts.filter((account) => gmailAccountIdentity(account).name === wanted);
  if (matches.length > 1) {
    const labels = matches.map((account) => {
      const { id, email } = gmailAccountIdentity(account);
      return `${id} (${email || 'email pending'})`;
    });
    throw new Error(`ambiguous account "${selector}": ${labels.join(', ')}. use an account name or email.`);
  }
  return matches[0] || null;
}

async function promptForGmailAccount(deps = {}) {
  if (deps.prompt) return deps.prompt('choose account: ');
  const rl = readline.createInterface({
    input: deps.input || process.stdin,
    output: deps.output || process.stdout,
  });
  return new Promise((resolve) => {
    rl.question('choose account: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

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
  return { token: creds.token, email: creds.email || 'unknown', userId: creds.user_id || null };
}

async function getAuthToken() {
  return (await getAuth()).token;
}

// ============================================================================
// GMAIL
// ============================================================================

function extractGmailMailboxAccount(args = []) {
  const out = [];
  let mailboxAccountId = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--account' && args[i + 1] && !String(args[i + 1]).startsWith('-')) {
      mailboxAccountId = args[i + 1];
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return { args: out, mailboxAccountId };
}

function parseGmailArgs(args = []) {
  const options = { accountId: null };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--account') {
      options.accountId = String(args[i + 1] || '').trim();
      if (!options.accountId) {
        console.error('Usage: --account requires an account id');
        process.exit(1);
      }
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { ...options, positional };
}

async function gmailInbox(options = {}) {
  const { token, email } = await getAuth();
  const limit = options.limit || 10;
  const accountId = resolveGmailAccountId(options.accountId);
  const accounts = await fetchGmailAccounts(token, { quiet: true });
  const account = resolveAccountSelector(accounts, accountId);
  const mailboxEmail = account ? gmailAccountIdentity(account).email : '';

  if (!options.quiet) {
    if (mailboxEmail) console.log(`inbox for ${mailboxEmail} (${accountId.toLowerCase()})`);
    console.log('📬 Fetching inbox...\n');
  }

  const path = `/integrations/gmail/messages?max_results=${limit}&account_id=${encodeURIComponent(accountId)}`;

  const result = await apiRequestJson(path, {
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

  const payload = result.data?.messages || result.data || [];
  const messages = Array.isArray(payload) ? payload : [];

  if (messages.length === 0) {
    if (!options.quiet) console.log('No messages found.');
    return messages;
  }

  if (options.quiet) return messages;

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

  return messages;
}

function gmailMessageHeaderText(message = {}) {
  const lines = [];
  const headers = message.headers;
  if (Array.isArray(headers)) {
    for (const header of headers) {
      lines.push(`${String(header?.name || '')}: ${String(header?.value || '')}`);
    }
  } else if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${String(value || '')}`);
  } else if (headers) {
    lines.push(String(headers));
  }

  for (const name of ['list_id', 'list_unsubscribe', 'mailing_list', 'unsubscribe']) {
    if (message[name]) lines.push(`${name}: ${String(message[name])}`);
  }
  return lines.join('\n').toLowerCase();
}

function gmailTriageVerdict(message = {}, options = {}) {
  const from = String(message.from || message.sender || '').toLowerCase();
  let result;
  if (/(?:^|[^a-z0-9])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply)(?:[^a-z0-9]|$)/i.test(from)) {
    result = { verdict: 'archive', reason: 'noreply sender' };
  }

  const domain = from.match(/@([a-z0-9.-]+)/i)?.[1] || '';
  if (!result && GMAIL_BULK_DOMAINS.some((bulkDomain) => domain === bulkDomain || domain.endsWith(`.${bulkDomain}`))) {
    result = { verdict: 'archive', reason: 'bulk mail domain' };
  }

  const headers = gmailMessageHeaderText(message);
  if (!result && (/(?:^|\n)(?:list-id|list-unsubscribe|mailing-list|x-campaign-id|x-mailing-list)\s*:/i.test(headers)
    || /(?:^|\n)precedence\s*:\s*(?:bulk|junk|list)/i.test(headers)
    || /\bunsubscribe\b/i.test(headers))) {
    result = { verdict: 'archive', reason: 'list or unsubscribe headers' };
  }

  if (!result) result = { verdict: 'keep', reason: 'personal sender' };
  return options.details ? result : result.verdict;
}

async function gmailTriage(options = {}) {
  const accountId = resolveGmailAccountId(options.accountId);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 25;
  const messages = await gmailInbox({ accountId, limit, quiet: true });
  // The hourly pass rereads the newest window, so without this filter a message
  // gets one row per hour it lingers and counts measure dwell time, not preference.
  const seen = new Set(
    readGmailVerdicts({ root: options.root, filePath: options.filePath, account: accountId, limit: null })
      .map((row) => row.message_id),
  );
  const fresh = messages.filter((message) => !seen.has(String(message.id || message.message_id || '')));
  const skipped = messages.length - fresh.length;
  const ts = new Date().toISOString();
  const rows = fresh.map((message) => {
    const { verdict, reason } = gmailTriageVerdict(message, { details: true });
    return {
      ts,
      account: accountId,
      verdict,
      reason,
      message_id: String(message.id || message.message_id || ''),
      from: String(message.from || message.sender || 'Unknown'),
      subject: String(message.subject || '(no subject)'),
    };
  });
  appendGmailVerdicts(rows, { root: options.root, filePath: options.filePath });

  const keepCount = rows.filter((row) => row.verdict === 'keep').length;
  const archiveCount = rows.length - keepCount;
  const skippedNote = skipped > 0 ? ` (${skipped} already judged)` : '';
  console.log(`gmail triage recorded ${keepCount} keep and ${archiveCount} archive verdict${rows.length === 1 ? '' : 's'}${skippedNote}.`);
  return rows;
}

async function gmailRead(messageId, options = {}) {
  if (!messageId) {
    console.error('Usage: atris gmail read <message_id> [--account <id>]');
    process.exit(1);
  }

  const token = await getAuthToken();
  const accountId = resolveGmailAccountId(options.accountId);

  console.log('📧 Fetching message...\n');

  const path = `/integrations/gmail/messages/${messageId}?account_id=${encodeURIComponent(accountId)}`;

  const result = await apiRequestJson(path, {
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

async function gmailArchive(messageIds, options = {}) {
  const ids = (messageIds || []).map(id => String(id || '').trim()).filter(Boolean);
  if (!ids.length) {
    console.error('Usage: atris gmail archive <message_id> [<message_id> ...] [--account <id>]');
    process.exit(1);
  }

  const token = await getAuthToken();
  const accountId = resolveGmailAccountId(options.accountId);

  console.log(`Archiving ${ids.length} message${ids.length === 1 ? '' : 's'}...`);

  const body = { message_ids: ids, account_id: accountId };

  const result = await apiRequestJson('/integrations/gmail/messages/batch-archive', {
    method: 'POST',
    token,
    body,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to archive'}`);
    process.exit(1);
  }

  const archived = result.data?.archived ?? result.data?.count ?? ids.length;
  const responseMessages = [
    result.data?.messages,
    result.data?.archived_messages,
    result.data?.results,
  ].find(Array.isArray) || [];
  const metadata = new Map(responseMessages.map((message) => [
    String(message.id || message.message_id || ''),
    message,
  ]));
  appendGmailVerdicts(ids.map((messageId) => {
    const message = metadata.get(messageId) || {};
    return {
      account: accountId,
      message_id: messageId,
      from: message.from || message.sender || undefined,
      subject: message.subject || undefined,
    };
  }));
  console.log(`Archived ${archived} message${archived === 1 ? '' : 's'}. They stay searchable in All Mail.`);
}

function parseGmailSendArgs(args = []) {
  let accountId = null;
  let bodyFile = null;
  let approved = false;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--approved' || arg === '--confirm-approved') {
      approved = true;
      continue;
    }
    if (arg === '--account' || arg === '--body-file') {
      const value = String(args[i + 1] || '').trim();
      if (!value || value.startsWith('--')) {
        console.error(GMAIL_SEND_USAGE);
        process.exit(2);
      }
      if (arg === '--account') accountId = value;
      else bodyFile = value;
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  const [to, subject, ...bodyParts] = positional;
  if (!String(to || '').trim()
    || !String(subject || '').trim()
    || (bodyFile ? bodyParts.length > 0 : bodyParts.length === 0)) {
    console.error(GMAIL_SEND_USAGE);
    process.exit(2);
  }

  let body = bodyParts.join(' ');
  if (bodyFile) {
    try {
      body = fs.readFileSync(bodyFile, 'utf8');
    } catch (error) {
      console.error(`could not read body file "${bodyFile}": ${error.message}`);
      process.exit(1);
    }
  }

  return { to, subject, body, accountId, approved };
}

async function gmailSend(to, subject, body, options = {}) {
  // Approval is checked before any token lookup or network call so an
  // unapproved send can never reach the server.
  if (!options.approved) {
    console.error('Refusing to send without --approved after the exact recipient, subject, and body are confirmed.');
    console.error(GMAIL_SEND_USAGE);
    process.exit(2);
  }
  const token = await getAuthToken();
  const accountId = resolveGmailAccountId(options.accountId);
  const accounts = await fetchGmailAccounts(token);
  const account = resolveAccountSelector(accounts, accountId);

  if (!account) {
    console.error(`gmail account "${accountId}" is not connected.`);
    process.exit(1);
  }

  const result = await apiRequestJson('/integrations/gmail/send', {
    method: 'POST',
    token,
    body: { to, subject, body, account_id: accountId },
  });

  if (!result.ok) {
    console.error(`could not send gmail message: ${result.error || 'request failed'}`);
    process.exit(1);
  }

  const { email, id } = gmailAccountIdentity(account);
  console.log(`sent to ${to} from ${email || id}`);
}

function parseGmailVoiceArgs(args = []) {
  let clear = false;
  const positional = [];
  for (const arg of args) {
    if (arg === '--clear') clear = true;
    else positional.push(arg);
  }
  if (positional.length > 1 || positional.some((arg) => String(arg).startsWith('--'))) {
    console.error(GMAIL_VOICE_USAGE);
    process.exit(2);
  }
  return { accountId: positional[0] || null, clear };
}

function editGmailVoice(currentVoice, deps = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gmail-voice-'));
  const voicePath = path.join(tempDir, 'voice.md');
  let editedVoice;
  let editorError = null;

  try {
    fs.writeFileSync(voicePath, currentVoice, 'utf8');
    const editor = deps.editor || process.env.EDITOR || 'vi';
    const shell = deps.shell || process.env.SHELL || '/bin/sh';
    const run = deps.spawnSync || spawnSync;
    const result = run(shell, ['-c', 'exec $EDITOR "$1"', 'atris-gmail-voice', voicePath], {
      stdio: 'inherit',
      env: { ...process.env, EDITOR: editor },
    });
    if (result.error || result.status !== 0) {
      editorError = result.error?.message || `editor exited with status ${result.status}`;
    } else {
      editedVoice = fs.readFileSync(voicePath, 'utf8');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (editorError) {
    console.error(`could not edit gmail voice: ${editorError}`);
    process.exit(1);
  }
  return editedVoice;
}

async function gmailVoice(accountId, options = {}) {
  const token = await getAuthToken();
  const resolvedAccountId = resolveGmailAccountId(accountId);
  const accounts = await fetchGmailAccounts(token);
  const account = resolveAccountSelector(accounts, resolvedAccountId);

  if (!account) {
    console.error(`gmail account "${resolvedAccountId}" is not connected.`);
    process.exit(1);
  }

  let voiceMd = '';
  if (!options.clear) {
    const stdinIsTTY = options.stdinIsTTY === undefined
      ? Boolean(process.stdin.isTTY)
      : options.stdinIsTTY;
    voiceMd = stdinIsTTY
      ? editGmailVoice(String(account.voice_md || ''), options)
      : String((options.readStdin || (() => fs.readFileSync(0, 'utf8')))());
  }

  const { id, name } = gmailAccountIdentity(account);
  const result = await apiRequestJson(`/integrations/gmail/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    token,
    body: { voice_md: voiceMd },
  });

  if (!result.ok) {
    console.error(`could not ${options.clear ? 'clear' : 'save'} gmail voice: ${result.error || 'request failed'}`);
    process.exit(1);
  }

  console.log(`voice ${options.clear ? 'cleared' : 'saved'} for ${name}`);
}

function openGmailAuthUrl(authUrl, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const platform = deps.platform || process.platform;
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  const opened = run(command, [authUrl], { stdio: 'ignore' });
  return !opened.error && opened.status === 0;
}

async function gmailConnect(accountName, deps = {}) {
  const accountId = String(accountName || 'default').trim();
  if (!/^[a-z0-9-]{1,32}$/.test(accountId)) {
    console.error('invalid gmail account name. use 1 to 32 lowercase letters, numbers, or hyphens.');
    process.exit(1);
  }

  const token = await getAuthToken();
  const result = await apiRequestJson('/integrations/gmail/start', {
    method: 'POST',
    token,
    body: { account_id: accountId },
  });

  if (!result.ok) {
    const detail = String(result.error || 'request failed').toLowerCase();
    console.error(`could not start gmail connection: ${detail}`);
    process.exit(1);
  }

  const authUrl = String(result.data?.auth_url || result.data?.url || '').trim();
  if (!authUrl) {
    console.error('could not start gmail connection: the server did not return an auth url.');
    process.exit(1);
  }

  const openAuthUrl = deps.openAuthUrl || openGmailAuthUrl;
  if (!openAuthUrl(authUrl, deps)) {
    console.log(`open this url in your browser: ${authUrl}`);
  }

  console.log(`waiting for gmail account ${accountId}...`);

  const pollIntervalMs = deps.pollIntervalMs ?? GMAIL_CONNECT_POLL_MS;
  const timeoutMs = deps.timeoutMs ?? GMAIL_CONNECT_TIMEOUT_MS;
  const sleep = deps.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));

  for (let poll = 0; poll < maxPolls; poll += 1) {
    await sleep(pollIntervalMs);
    const accountsResult = await apiRequestJson('/integrations/gmail/accounts', {
      method: 'GET',
      token,
    });
    const accounts = accountsResult.ok
      ? (accountsResult.data?.accounts || accountsResult.data || [])
      : [];
    const match = Array.isArray(accounts) ? resolveAccountSelector(accounts, accountId) : null;
    const email = match ? gmailAccountIdentity(match).email.trim() : '';
    if (email && email !== 'unknown') {
      console.log(`connected ${email} as ${accountId}`);
      return;
    }
  }

  console.error(`connection timed out. finish in your browser: ${authUrl}`);
  console.error(`or connect from settings: https://atris.ai/dashboard/settings?connect=gmail&account=${accountId}`);
  process.exit(1);
}

async function gmailAccounts() {
  const token = await getAuthToken();
  const accounts = await fetchGmailAccounts(token);
  const activeId = resolveGmailAccountId(null);

  if (!accounts.length) {
    console.log('no connected accounts.');
    return;
  }

  for (const line of formatGmailAccountRows(accounts, activeId)) console.log(line);
}

async function gmailUse(accountId, deps = {}) {
  const auth = await getAuth();
  const token = auth.token;
  const accounts = await fetchGmailAccounts(token);
  let selector = String(accountId || '').trim();

  if (!selector) {
    if (!accounts.length) {
      console.log('no connected accounts.');
      return;
    }
    if (accounts.length === 1) {
      const { name, email } = gmailAccountIdentity(accounts[0]);
      console.log(`${name} (${email || 'email pending'}) is already the only gmail account.`);
      return;
    }

    const sortedAccounts = sortGmailAccounts(accounts);
    const activeId = resolveGmailAccountId(null);
    const rows = formatGmailAccountRows(sortedAccounts, activeId);
    rows.forEach((line, index) => console.log(`${index + 1}. ${line}`));
    const answer = String(await promptForGmailAccount(deps) || '').trim();
    const number = /^\d+$/.test(answer) ? Number(answer) : 0;
    selector = number >= 1 && number <= sortedAccounts.length
      ? gmailAccountIdentity(sortedAccounts[number - 1]).id
      : answer;
  }

  const match = resolveAccountSelector(accounts, selector, { displayName: true });
  if (!match) {
    console.error(`unknown gmail account "${selector}".`);
    if (accounts.length) {
      console.error('connected accounts:');
      for (const account of sortGmailAccounts(accounts)) {
        const { id, email, name } = gmailAccountIdentity(account);
        console.error(`  ${id.toLowerCase()}: ${email || 'email pending'}, ${name}`);
      }
    } else {
      console.error('no connected accounts.');
    }
    process.exit(1);
  }

  const { id, name, email } = gmailAccountIdentity(match);
  await saveGoogleDefault(auth, id, ['gmail'], googleContext.getStore()?.business, { mailAccounts: accounts });
  console.log(`now using ${name} (${email || 'email pending'})`);
}

const googleOldServer = 'calendar and drive accounts need the newest atris server.';
const googleProductNames = ['gmail', 'calendar', 'drive'];

function googleProducts(value) {
  if (value == null) return null;
  const products = String(value).split(',').map((part) => part.trim().toLowerCase() === 'mail' ? 'gmail' : part.trim().toLowerCase());
  if (!products.length || products.some((part) => !googleProductNames.includes(part)) || new Set(products).size !== products.length) throw new Error('--only needs mail, calendar, or drive');
  return products;
}

function googleCache(defaults, business) {
  const file = path.join(stateHome(), '.atris', 'google-accounts.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (business) cache.businesses = { ...(cache.businesses || {}), [business]: defaults };
  else cache.defaults = { ...(cache.defaults || {}), ...defaults };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

function googleFailure(result, action) {
  console.error(`could not ${action}: ${result.error || result.data?.detail || 'request failed'}`);
  process.exit(1);
}

async function saveGoogleDefault(auth, selector, products, business, { mailAccounts, warnLegacy = false } = {}) {
  const capability = await googleAccountsCapability(auth.token);
  if (!capability.supported && !products.includes('gmail')) {
    if (warnLegacy) console.log(googleOldServer);
    return { id: String(selector), legacy: true };
  }
  const roster = capability.supported ? (Array.isArray(capability.data.accounts) ? capability.data.accounts : []) : (mailAccounts || await fetchGmailAccounts(auth.token));
  const match = resolveAccountSelector(roster, selector, { displayName: !capability.supported });
  if (!match && (String(selector).includes('@') || !capability.supported)) throw new Error('unknown google account');
  const id = match ? gmailAccountIdentity(match).id : String(selector);
  if (!capability.supported) {
    if (warnLegacy) console.log(googleOldServer);
    if (products.includes('gmail')) writeGmailStickyAccount(id);
    return { id, legacy: true };
  }
  const url = business ? `/business/${encodeURIComponent(business)}/integrations/google` : '/integrations/google/defaults';
  const body = business ? { account_id: id } : { account_id: id, products };
  const options = { method: 'PUT', token: auth.token, body };
  if (business) options.headers = { 'X-Business-Id': business };
  const saved = await rawApiRequestJson(url, options);
  if (!saved.ok) return googleFailure(saved, 'save google default');
  googleCache(Object.fromEntries((business ? googleProductNames : products).map((product) => [product, id])), business);
  if (products.includes('gmail') && !business) {
    markMailMigration(mailMigrationRecord(auth));
    writeGmailStickyAccount(id);
  }
  return { id, legacy: false };
}

async function googleConnect(name, products, business, deps = {}) {
  if (name && (!/^[a-z0-9-]{1,32}$/.test(name) || name === 'all')) throw new Error('invalid google account name. use 1 to 32 lowercase letters, numbers, or hyphens');
  const token = await getAuthToken();
  const before = await googleAccountsCapability(token);
  if (!before.supported) {
    if (!deps.quietOldServer) console.log(googleOldServer);
    if (!products || products.includes('gmail')) return gmailConnect(name, deps);
    return;
  }
  const body = {};
  if (name) body.account_id = name;
  if (products) body.products = products;
  if (business) body.business_id = business;
  const result = await apiRequestJson('/integrations/google/start', { method: 'POST', token, body });
  if (result.status === 404) {
    if (!deps.quietOldServer) console.log(googleOldServer);
    if (!products || products.includes('gmail')) return gmailConnect(name, deps);
    return;
  }
  if (!result.ok) return googleFailure(result, 'start google connection');
  const url = result.data?.auth_url;
  if (!url) throw new Error('the server did not return a sign-in url');
  const state = result.data?.state;
  if (!state) throw new Error('the server did not return a sign-in state. start again with atris google connect.');
  if (!(deps.openAuthUrl || openGmailAuthUrl)(url, deps)) console.log(`open this url in your browser: ${url}`);
  console.log('waiting for google sign-in...');
  const interval = deps.pollIntervalMs ?? GMAIL_CONNECT_POLL_MS;
  const timeout = deps.timeoutMs ?? GMAIL_CONNECT_TIMEOUT_MS;
  const count = Math.max(1, Math.ceil(timeout / interval));
  const now = deps.now || Date.now;
  const deadline = now() + timeout;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const id = result.data?.account_id || name;
  for (let i = 0; i < count && now() < deadline; i += 1) {
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    const pollOptions = { method: 'GET', token, timeoutMs: Math.max(1, Math.min(interval, deadline - now())), retries: 0 };
    const check = await apiRequestJson(`/integrations/google/start/${encodeURIComponent(state)}`, pollOptions);
    if (check.status === 404) {
      const retry = ['atris google connect', name, products && `--only ${products.map((p) => p === 'gmail' ? 'mail' : p).join(',')}`, business && `--business ${business}`].filter(Boolean).join(' ');
      console.error(`google sign-in expired. start again with ${retry}.`);
      process.exit(1);
    }
    if (!check.ok) {
      if (check.status === 401 || check.status === 403) return googleFailure(check, 'check google sign-in');
      continue;
    }
    const status = check.data || {};
    if (status.status === 'error') {
      const reason = String(status.error || 'unknown error').replace(/_/g, ' ').toLowerCase();
      console.error(`google sign-in failed: ${reason}`);
      process.exit(1);
    }
    if (status.status === 'connected') {
      const accountId = status.account_id || id || 'account';
      const identity = status.email || accountId;
      const granted = Array.isArray(status.products) ? status.products : [];
      const missing = Array.isArray(status.missing) ? status.missing : [];
      console.log(`connected ${identity} as ${accountId}${granted.length ? `: ${granted.map((p) => p === 'gmail' ? 'mail' : p).join(', ')}` : ''}`);
      if (missing.length) console.log(`google did not grant: ${missing.map((p) => p === 'gmail' ? 'mail' : p).join(', ')}`);
      return;
    }
  }
  console.error(`connection could not be confirmed. finish in your browser and check atris google: ${url}`);
  process.exit(1);
}

async function gmailConnectUnified(name, deps = {}) {
  const id = String(name || 'default').trim();
  if (!/^[a-z0-9-]{1,32}$/.test(id)) {
    console.error('invalid gmail account name. use 1 to 32 lowercase letters, numbers, or hyphens.');
    process.exit(1);
  }
  return googleConnect(id, ['gmail'], null, { ...deps, quietOldServer: true });
}

async function googleCommand(subcommand, ...args) {
  if ([subcommand, ...args].some((arg) => ['help', '--help', '-h'].includes(arg))) {
    console.log('usage: atris google [accounts|connect|use|disconnect] [name] [--only mail,calendar,drive] [--business slug]');
    console.log('list accounts as json with atris google accounts --json.');
    console.log('disconnect requires --approved.');
    return;
  }
  if (subcommand && subcommand.startsWith('-')) { args.unshift(subcommand); subcommand = undefined; }
  const context = takeContext(args);
  return googleContext.run(context, async () => {
    const rest = context.rest;
    let only; let approved = false; let json = false; const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--only') { if (!rest[i + 1] || String(rest[i + 1]).startsWith('--')) throw new Error('--only needs mail, calendar, or drive'); only = googleProducts(rest[++i]); }
      else if (rest[i].startsWith('--only=')) only = googleProducts(rest[i].slice(7));
      else if (rest[i] === '--json') json = true;
      else if (rest[i] === '--approved' || rest[i] === '--confirm-approved') approved = true;
      else if (rest[i].startsWith('-')) throw new Error(`unknown option ${rest[i]}`);
      else positional.push(rest[i]);
    }
    const action = subcommand || 'accounts';
    if (json && action !== 'accounts') throw new Error('--json is available for google accounts');
    if (action === 'connect') return googleConnect(positional[0], only, context.explicitBusiness ? context.business : null);
    if (!['accounts', 'use', 'disconnect'].includes(action)) {
      console.log('usage: atris google [accounts|connect|use|disconnect] [name] [--only mail,calendar,drive] [--business slug]'); return;
    }
    if (action !== 'accounts' && !positional[0]) throw new Error(`usage: atris google ${action} <name or email>`);
    if (action === 'disconnect' && !approved) throw new Error('disconnect needs --approved after the account and products are confirmed');
    const auth = await getAuth();
    const token = auth.token;
    if (action === 'accounts') {
      const capability = await googleAccountsCapability(token);
      if (!capability.supported) {
        if (json) {
          const accounts = await fetchGmailAccounts(token);
          console.log(JSON.stringify({ accounts, defaults: {}, resolved: {}, business: null, legacy: true, notice: googleOldServer }, null, 2));
          return;
        }
        console.log(googleOldServer); return gmailAccounts();
      }
      const data = capability.data;
      const accounts = data.accounts.map((row) => ({ ...row, products: Object.fromEntries(Object.entries(row.products || {}).map(([product, value]) => {
        const reconnect = value?.reauth_required && googleProductNames.includes(product)
          ? `atris google connect ${row.account_id} --only ${product === 'gmail' ? 'mail' : product}` : null;
        return [product, reconnect ? { ...value, reconnect } : value];
      })) }));
      if (json) { console.log(JSON.stringify({ ...data, accounts }, null, 2)); return; }
      if (!data.accounts?.length) console.log('no connected accounts.');
      for (const row of accounts) {
        const products = googleProductNames.filter((p) => row.products?.[p]?.connected || row.products?.[p]?.reauth_required).map((p) => `${p === 'gmail' ? 'mail' : p}${row.products[p].reauth_required ? ' needs reconnecting' : ''}`);
        console.log(`${row.account_id}: ${row.email || 'email pending'} (${products.join(', ') || 'no products'})`);
        for (const p of googleProductNames) if (row.products?.[p]?.reconnect) console.log(`  reconnect ${p === 'gmail' ? 'mail' : p}: ${row.products[p].reconnect}`);
      }
      for (const product of googleProductNames) console.log(`${product === 'gmail' ? 'mail' : product} default: ${data.defaults?.[product] || 'automatic'}`);
      if (data.business) console.log(`business account: ${data.business.account_id || 'automatic'}`);
      return;
    }
    const id = positional[0];
    if (action === 'use' && context.business && only && only.length !== 3) throw new Error('a business has one account for all products, leave off --only');
    if (action === 'disconnect') {
      const suffix = only ? `?${new URLSearchParams({ products: only.join(',') })}` : '';
      const result = await apiRequestJson(`/integrations/google/accounts/${encodeURIComponent(id)}${suffix}`, { method: 'DELETE', token });
      if (result.status === 404) {
        const probe = await googleAccountsCapability(token);
        if (probe.supported) return googleFailure(result, 'disconnect google account');
        console.log(googleOldServer);
        if (only && !only.includes('gmail')) return;
        const accounts = await fetchGmailAccounts(token);
        const match = resolveAccountSelector(accounts, id, { displayName: true });
        if (!match) throw new Error('unknown gmail account');
        const mailId = gmailAccountIdentity(match).id;
        const removed = await apiRequestJson(`/integrations/gmail?account_id=${encodeURIComponent(mailId)}`, { method: 'DELETE', token });
        if (!removed.ok) return googleFailure(removed, 'disconnect mail');
        console.log(`disconnected mail for ${mailId}`); return;
      }
      if (!result.ok) return googleFailure(result, 'disconnect google account');
      console.log(`disconnected ${id}: ${(result.data?.removed || only || googleProductNames).map((p) => p === 'gmail' ? 'mail' : p).join(', ')}`); return;
    }
    const products = only || googleProductNames;
    const saved = await saveGoogleDefault(auth, id, products, context.business, { warnLegacy: true });
    if (saved.legacy) {
      if (products.includes('gmail')) console.log(`using ${saved.id}: mail`);
      return;
    }
    const chosen = saved.id;
    console.log(`using ${chosen}${context.business ? ' for this business' : ''}: ${products.map((p) => p === 'gmail' ? 'mail' : p).join(', ')}`);
  });
}

async function gmailCommand(subcommand, ...args) {
  const context = takeContext(args);
  return googleContext.run(context, async () => {
    const needsDefault = ['inbox', 'list', 'read', 'archive', 'triage', 'send', 'voice', 'accounts'].includes(subcommand);
    const hasVoiceAccount = subcommand === 'voice' && context.rest.some((arg) => !String(arg).startsWith('--'));
    let valid = true;
    if (subcommand === 'send') {
      const parsed = parseGmailSendArgs(context.rest);
      valid = parsed.approved;
    } else if (subcommand === 'read' || subcommand === 'archive') {
      valid = context.rest.some((arg) => !String(arg).startsWith('--'));
    }
    if (needsDefault && valid && context.mailAccount && context.mailAccount.includes('@')) {
      const auth = await getAuth();
      const capability = await googleAccountsCapability(auth.token);
      const accounts = capability.supported ? (capability.data.accounts || []) : await fetchGmailAccounts(auth.token);
      const match = resolveAccountSelector(accounts, context.mailAccount);
      if (!match) throw new Error('unknown gmail account');
      context.mailAccount = gmailAccountIdentity(match).id;
      const index = context.rest.indexOf('--account');
      if (index >= 0) context.rest[index + 1] = context.mailAccount;
    }
    if (needsDefault && valid && !context.mailAccount && !hasVoiceAccount) await prepareMailDefaults(context, { migrate: subcommand !== 'accounts' });
    return gmailCommandInner(subcommand, ...context.rest);
  });
}

async function gmailCommandInner(subcommand, ...args) {
  switch (subcommand) {
    case 'inbox':
    case 'list': {
      const parsed = parseGmailArgs(args);
      await gmailInbox({ accountId: parsed.accountId || undefined });
      break;
    }
    case 'read': {
      const parsed = parseGmailArgs(args);
      await gmailRead(parsed.positional[0], { accountId: parsed.accountId || undefined });
      break;
    }
    case 'archive': {
      const parsed = parseGmailArgs(args);
      await gmailArchive(parsed.positional, { accountId: parsed.accountId || undefined });
      break;
    }
    case 'triage': {
      const parsed = parseGmailTriageArgs(args);
      await gmailTriage(parsed);
      break;
    }
    case 'verdicts': {
      const parsed = parseGmailVerdictsArgs(args);
      printGmailVerdicts(parsed);
      break;
    }
    case 'send': {
      const parsed = parseGmailSendArgs(args);
      await gmailSend(parsed.to, parsed.subject, parsed.body, { accountId: parsed.accountId || undefined, approved: parsed.approved });
      break;
    }
    case 'voice': {
      const parsed = parseGmailVoiceArgs(args);
      await gmailVoice(parsed.accountId, { clear: parsed.clear });
      break;
    }
    case 'connect':
      await gmailConnectUnified(args[0]);
      break;
    case 'accounts':
      await gmailAccounts();
      break;
    case 'use':
      await gmailUse(args.join(' '));
      break;
    default:
      console.log('gmail commands:');
      console.log('  atris gmail inbox [--account <id>]       - list recent emails for a mailbox');
      console.log('  atris gmail read <id> [--account <id>]   - read specific email');
      console.log('  atris gmail archive <id> [...] [--account <id>] - archive messages (reversible, all mail keeps them)');
      console.log('  atris gmail triage [--account <id>] [--limit N] - record keep or archive verdicts without changing mail');
      console.log('  atris gmail verdicts [--summary] [--account <id>] [--limit N] - list recent gmail verdicts');
      console.log('  atris gmail send <to> <subject> <body...> --approved [--body-file <path>] [--account <id>] - send an email');
      console.log('  atris gmail voice [account] [--clear]    - edit or clear an account writing voice');
      console.log('  atris gmail connect [name]               - connect or reconnect a gmail account');
      console.log('  atris gmail accounts                     - list connected gmail accounts and the active account');
      console.log('  atris gmail use [<account_id|name>]      - choose or set the active gmail account');
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

// All-day dates start at local midnight; invalid or missing dates sort last.
function compareCalendarEvents(left, right) {
  const instant = (event) => {
    const value = calendarEventTimeValue(event.start || event.start_time || event.startTime);
    if (!value) return NaN;
    if (isDateOnly(value)) {
      const parsed = new Date(`${value}T00:00:00`);
      if (Number.isNaN(parsed.getTime()) || `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}` !== value) return NaN;
      return parsed.getTime();
    }
    return Date.parse(value);
  };
  const a = instant(left), b = instant(right);
  if (!Number.isFinite(a)) return Number.isFinite(b) ? 1 : 0;
  if (!Number.isFinite(b)) return -1;
  return a - b;
}

function calendarReadMetadata(data) {
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  return { accounts, errors, partial: errors.length > 0 };
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
    // label is already a phrase like "today's events" or "events on 2026-08-24"
    console.log(`No ${label}.`);
    return;
  }

  console.log('─'.repeat(50));

  const multipleAccounts = new Set(events.map((event) => event.account_id).filter(Boolean)).size > 1;
  for (const event of events) {
    const time = formatCalendarTimeRange(event);
    const title = event.summary || '(no title)';

    const account = multipleAccounts ? ` (${event.account_email || event.account_id || 'unknown'})` : '';
    console.log(`${time}  ${title}${account}`);
    if (event.location) {
      console.log(`        📍 ${event.location}`);
    }
  }

  console.log('─'.repeat(50));
}

function parseCalendarSearchArgs(args = []) {
  const values = [];
  const options = { days: 30, limit: 20, timeoutMs: 10000, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--days' || arg === '-d') {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) options.days = Math.min(parsed, 365);
      i += 1;
    } else if (arg === '--limit' || arg === '-n') {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) options.limit = Math.min(parsed, 100);
      i += 1;
    } else if (arg === '--timeout-ms' || arg === '--timeout') {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) options.timeoutMs = Math.min(parsed, 60000);
      i += 1;
    } else {
      values.push(arg);
    }
  }
  return { query: values.join(' ').trim(), ...options };
}

function calendarAttendeesText(attendees) {
  if (!Array.isArray(attendees)) return '';
  return attendees
    .map((attendee) => {
      if (typeof attendee === 'string') return attendee;
      return [
        attendee.email,
        attendee.displayName,
        attendee.name,
        attendee.responseStatus,
      ].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(' ');
}

function calendarSearchText(event = {}) {
  return [
    event.summary,
    event.title,
    event.location,
    event.description,
    calendarAttendeesText(event.attendees),
  ].filter(Boolean).join(' ').toLowerCase();
}

function filterCalendarEventsForSearch(events = [], query = '', limit = 20) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return events
    .filter((event) => {
      const haystack = calendarSearchText(event);
      return terms.every((term) => haystack.includes(term));
    })
    .slice(0, limit);
}

function compactCalendarEvent(event = {}) {
  return {
    id: event.id || event.event_id || '',
    start: calendarEventTimeValue(event.start || event.start_time || event.startTime),
    end: calendarEventTimeValue(event.end || event.end_time || event.endTime),
    summary: event.summary || event.title || '(no title)',
    location: event.location || '',
    htmlLink: event.htmlLink || event.link || '',
    ...(event.account_id ? { account_id: event.account_id } : {}),
    ...(event.account_email ? { account_email: event.account_email } : {}),
  };
}

function calendarCachePacket(events = [], meta = {}) {
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    source: meta.source || 'live',
    days: meta.days || null,
    count: events.length,
    accounts: meta.accounts || [],
    errors: meta.errors || [],
    partial: Boolean(meta.partial),
    events: events.map(compactCalendarEvent),
  };
}

function writeCalendarEventsCache(events = [], meta = {}) {
  const rows = Array.isArray(events) ? events : [];
  try {
    fs.mkdirSync(path.dirname(CALENDAR_CACHE_PATH), { recursive: true });
    fs.writeFileSync(CALENDAR_CACHE_PATH, `${JSON.stringify(calendarCachePacket(rows, meta), null, 2)}\n`, 'utf8');
    return CALENDAR_CACHE_PATH;
  } catch {
    return '';
  }
}

function readCalendarEventsCache() {
  try {
    const packet = JSON.parse(fs.readFileSync(CALENDAR_CACHE_PATH, 'utf8'));
    const events = Array.isArray(packet.events) ? packet.events : [];
    return {
      ok: true,
      path: CALENDAR_CACHE_PATH,
      updatedAt: packet.updatedAt || '',
      accounts: Array.isArray(packet.accounts) ? packet.accounts : [],
      errors: Array.isArray(packet.errors) ? packet.errors : [],
      partial: Boolean(packet.partial || packet.errors?.length),
      events,
    };
  } catch {
    return { ok: false, path: CALENDAR_CACHE_PATH, updatedAt: '', events: [] };
  }
}

function formatCalendarSearchResults(query, matches, {
  json = false,
  total = matches.length,
  source = 'live',
  liveOk = true,
  cacheUpdatedAt = '',
  error = '',
  accounts = [],
  errors = [],
  partial = false,
} = {}) {
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      query,
      source,
      liveOk,
      cacheUpdatedAt,
      error,
      accounts,
      errors,
      partial: Boolean(partial || errors.length),
      totalEvents: total,
      matchCount: matches.length,
      matches: matches.map(compactCalendarEvent),
    }, null, 2));
    return;
  }

  if (!matches.length) {
    console.log(`No upcoming events matched "${query}".`);
    return;
  }

  console.log(`Found ${matches.length} upcoming event(s) matching "${query}":\n`);
  formatCalendarEvents('matching your search', matches);
}

function formatCalendarSearchError(query, message, { json = false, status = 0 } = {}) {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      query,
      status,
      error: message || 'Failed to fetch events',
      totalEvents: 0,
      matchCount: 0,
      matches: [],
    }, null, 2));
    return;
  }
  console.error(`Error: ${message || 'Failed to fetch events'}`);
  process.exit(1);
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

  const events = [...(result.data?.events || (Array.isArray(result.data) ? result.data : []))].sort(compareCalendarEvents);
  for (const error of result.data?.errors || []) console.error(`calendar ${error.account_id || 'account'}: ${error.message || error.code || 'could not read events'}`);
  const meta = calendarReadMetadata(result.data);
  if (!googleContext.getStore()?.calendarAccount && !googleContext.getStore()?.business) writeCalendarEventsCache(events, { source: 'calendarRange', days: days || null, ...meta });
  formatCalendarEvents(label.toLowerCase(), events);
}

async function calendarSearch(args = []) {
  const { query, days, limit, timeoutMs, json } = parseCalendarSearchArgs(args);
  if (!query) {
    console.error('Usage: atris calendar search <query> [--days 30] [--limit 20] [--timeout-ms 10000] [--json]');
    process.exit(1);
  }

  const credentials = loadCredentials();
  const token = credentials && credentials.token;
  const email = credentials && credentials.email || 'unknown';
  if (!token) {
    formatCalendarSearchError(query, 'Not logged in. Run: atris login', { json, status: 401 });
    return;
  }
  const result = await apiRequestJson(`/integrations/google-calendar/events?days=${encodeURIComponent(String(days))}`, {
    method: 'GET',
    token,
    timeoutMs,
    retries: 0,
  });

  if (!result.ok) {
    const cache = readCalendarEventsCache();
    if (json && cache.ok && !googleContext.getStore()?.calendarAccount && !googleContext.getStore()?.business) {
      const matches = filterCalendarEventsForSearch(cache.events, query, limit);
      formatCalendarSearchResults(query, matches, {
        json,
        total: cache.events.length,
        source: 'cache',
        liveOk: false,
        cacheUpdatedAt: cache.updatedAt,
        error: result.error || 'Failed to fetch events',
        accounts: cache.accounts, errors: cache.errors, partial: cache.partial,
      });
      return;
    }
    if (result.status === 400 || result.status === 401) {
      formatCalendarSearchError(
        query,
        `Calendar not connected for ${email}. Connect at: https://atris.ai/dashboard/settings`,
        { json, status: result.status },
      );
    } else {
      formatCalendarSearchError(query, result.error || 'Failed to fetch events', { json, status: result.status || 0 });
    }
    return;
  }

  const events = [...(result.data?.events || (Array.isArray(result.data) ? result.data : []))].sort(compareCalendarEvents);
  for (const error of result.data?.errors || []) console.error(`calendar ${error.account_id || 'account'}: ${error.message || error.code || 'could not read events'}`);
  const meta = calendarReadMetadata(result.data);
  if (!googleContext.getStore()?.calendarAccount && !googleContext.getStore()?.business) writeCalendarEventsCache(events, { source: 'calendarSearch', days, ...meta });
  const matches = filterCalendarEventsForSearch(events, query, limit);
  formatCalendarSearchResults(query, matches, { json, total: events.length, source: 'live', liveOk: !meta.partial, error: meta.partial ? 'some calendar accounts could not be read' : '', ...meta });
}

async function calendarToday() {
  const { start, end } = localDayBounds();
  await calendarRange("Today's events", { timeMin: start.toISOString(), timeMax: end.toISOString() });
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

async function calendarAdd(args) {
  // atris calendar add "Title" --date YYYY-MM-DD --from HH:MM --to HH:MM
  //   or: --start <ISO> --end <ISO>; optional --location, --description
  const rest = [...(args || [])];
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = String(rest[i] || '');
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = String(rest[i + 1] || '');
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  const summary = positional.join(' ').trim();
  let start = String(flags.start || '').trim();
  let end = String(flags.end || '').trim();
  if (!start && flags.date && flags.from) start = `${flags.date}T${flags.from}:00`;
  if (!end && flags.date && flags.to) end = `${flags.date}T${flags.to}:00`;
  if (!summary || !start || !end) {
    console.error('Usage: atris calendar add "Title" --date YYYY-MM-DD --from HH:MM --to HH:MM');
    console.error('   or: atris calendar add "Title" --start <ISO datetime> --end <ISO datetime>');
    process.exit(1);
  }

  const token = await getAuthToken();

  console.log(`Creating event: ${summary} (${start} to ${end})...`);

  const body = { summary, start, end };
  if (flags.location) body.location = flags.location;
  if (flags.description) body.description = flags.description;
  if (flags.timezone) body.timezone = flags.timezone;

  const result = await apiRequestJson('/integrations/google-calendar/events', {
    method: 'POST',
    token,
    body,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to create event'}`);
    process.exit(1);
  }

  const created = result.data || {};
  const createdAccount = created.account_email || created.account_id;
  console.log(`Created: ${created.summary || summary}${createdAccount ? ` (${createdAccount})` : ''}`);
  if (!createdAccount && (googleContext.getStore()?.business || googleContext.getStore()?.calendarAccount)) console.log('account not reported by the server.');
  if (created.htmlLink) console.log(`Link: ${created.htmlLink}`);
  console.log(`Verified on calendar: ${created.verified ? 'yes' : 'no'}`);
}

async function calendarCommand(subcommand, ...args) {
  const context = takeContext(args);
  if ((subcommand === 'add' || subcommand === 'create') && context.calendarAccount === 'all') throw new Error('calendar writes need one account');
  const clean = context.rest.filter((arg, index, array) => arg !== '--account' && array[index - 1] !== '--account');
  return googleContext.run(context, async () => {
    if ((context.business || context.calendarAccount) && ['today', 'yesterday', 'yday', 'week', 'date', 'search', 'add', 'create'].includes(subcommand)) {
      try {
        const token = await getAuthToken();
        const capability = await googleAccountsCapability(token);
        if (!capability.supported) {
          const error = new Error(googleOldServer);
          error.status = 404;
          throw error;
        }
      } catch (error) {
        if (subcommand !== 'search' || !clean.includes('--json')) throw error;
        const { query } = parseCalendarSearchArgs(clean);
        formatCalendarSearchError(query, error.message, { json: true, status: error.status || 0 });
        return 1;
      }
    }
    return calendarCommandInner(subcommand, ...clean);
  });
}

async function calendarCommandInner(subcommand, ...args) {
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
    case 'search':
      await calendarSearch(args);
      break;
    case 'add':
    case 'create':
      await calendarAdd(args);
      break;
    default:
      console.log('Calendar commands:');
      console.log('  atris calendar today          - Show today\'s events');
      console.log('  atris calendar yesterday      - Show yesterday\'s events');
      console.log('  atris calendar week           - Show this week\'s events');
      console.log('  atris calendar date YYYY-MM-DD - Show events on a date');
      console.log('  atris calendar search <query> [--days 30] [--limit 20] [--timeout-ms 10000] [--json] - Search upcoming events');
      console.log('  atris calendar add \"Title\" --date YYYY-MM-DD --from HH:MM --to HH:MM - Create an event');
  }
}

// ============================================================================
// TWITTER
// ============================================================================

async function twitterPost(args = []) {
  const approved = args.includes('--approved') || args.includes('--confirm-approved');
  const cleaned = args.filter((a) => a !== '--approved' && a !== '--confirm-approved');
  if (!approved) {
    console.error('Refusing to post without --approved after the exact text is confirmed.');
    console.error('Usage: atris twitter post "<text>" --approved');
    process.exit(2);
  }

  const outbound = prepareOutboundSendTextOrExit('twitter', cleaned);
  let text = outbound.body;
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
    text = assertOutboundSendAllowedOrExit('twitter', text).body;
  }

  if (!text) {
    console.error('Tweet text is required');
    process.exit(1);
  }

  const token = await getAuthToken();

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
      await twitterPost(args);
      break;
    default:
      console.log('Twitter commands:');
      console.log('  atris twitter post "<text>" --approved  - Post a tweet');
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

async function slackSend(channel, textParts) {
  const target = String(channel || '').trim();
  const approved = (textParts || []).includes('--approved') || (textParts || []).includes('--confirm-approved');
  const cleaned = (textParts || []).filter((a) => a !== '--approved' && a !== '--confirm-approved');
  if (!approved) {
    console.error('Refusing to send without --approved after the exact channel and exact text are confirmed.');
    console.error('Usage: atris slack send <channel> "<message>" --approved');
    process.exit(2);
  }
  const text = prepareOutboundSendTextOrExit('slack', cleaned).body;
  if (!target || !text) {
    console.error('Usage: atris slack send <channel> "<message>" --approved');
    process.exit(1);
  }

  const token = await getAuthToken();

  console.log(`Sending to ${target}...`);

  const result = await apiRequestJson('/integrations/slack/me/send', {
    method: 'POST',
    token,
    body: { channel: target, text },
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to send'}`);
    process.exit(1);
  }

  console.log(`Sent to ${target} as you.`);
}

async function slackDm(userId, textParts) {
  const target = String(userId || '').trim();
  const approved = (textParts || []).includes('--approved') || (textParts || []).includes('--confirm-approved');
  const cleaned = (textParts || []).filter((a) => a !== '--approved' && a !== '--confirm-approved');
  if (!approved) {
    console.error('Refusing to send without --approved after the exact recipient and exact text are confirmed.');
    console.error('Usage: atris slack dm <slack_user_id> "<message>" --approved');
    process.exit(2);
  }
  const text = prepareOutboundSendTextOrExit('slack', cleaned).body;
  if (!target || !text) {
    console.error('Usage: atris slack dm <slack_user_id> "<message>" --approved');
    process.exit(1);
  }

  const token = await getAuthToken();

  console.log(`Sending DM to ${target}...`);

  const result = await apiRequestJson('/integrations/slack/me/dm', {
    method: 'POST',
    token,
    body: { slack_user_id: target, text },
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to send DM'}`);
    process.exit(1);
  }

  console.log(`DM sent to ${target} as you.`);
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
    case 'send':
      await slackSend(args[0], args.slice(1));
      break;
    case 'dm':
      await slackDm(args[0], args.slice(1));
      break;
    default:
      console.log('Slack commands:');
      console.log('  atris slack channels             - List Slack channels');
      console.log('  atris slack dms                  - List Slack DMs');
      console.log('  atris slack messages <channel>   - Read recent messages');
      console.log('  atris slack search <query>       - Search Slack messages');
      console.log('  atris slack send <channel> "<message>" --approved - Send a message as you');
      console.log('  atris slack dm <user_id> "<message>" --approved   - DM someone as you');
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
  return path.join(stateHome(), '.atris', 'cache', 'imessage-contacts.json');
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
    sleepSync(intervalMs);
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
  const outbound = extractOutboundGateOptions(args);
  const options = {
    approved: false,
    json: false,
    receipt: false,
    to: '',
    text: '',
    outboundGate: outbound.gate,
  };
  const positional = [];
  for (let i = 0; i < outbound.args.length; i += 1) {
    const arg = outbound.args[i];
    if (arg === '--approved' || arg === '--confirm-approved') {
      options.approved = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--receipt') {
      options.receipt = true;
    } else if (arg === '--to' || arg === '--handle') {
      options.to = outbound.args[i + 1] || '';
      i += 1;
    } else if (arg === '--text' || arg === '--message') {
      options.text = outbound.args[i + 1] || '';
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

  if (!options.to || (!options.text && !options.outboundGate.bodyFile)) {
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

  const gateResult = assertOutboundSendAllowedOrExit('imessage', options.text, options.outboundGate, {
    json: options.json,
    payload: basePayload,
  });
  options.text = gateResult.body;
  basePayload.text = options.text;
  if (!options.text) {
    printImessageSendPayload({
      ...basePayload,
      error: 'Usage: atris imessage send --to <phone-or-email> --text <message> --approved [--json] [--receipt]',
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

async function integrationsStatus(args = []) {
  const { parseScopeFlag } = require('../lib/cli-scope');
  const scope = parseScopeFlag(args);
  const json = scope.args.includes('--json') || args.includes('--json');

  if (!scope.global) {
    const localPath = path.join(process.cwd(), '.atris', 'integrations.json');
    let local = null;
    try {
      if (fs.existsSync(localPath)) local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    } catch {}
    const payload = {
      scope: 'workspace',
      workspace_root: process.cwd(),
      integrations: Array.isArray(local?.integrations) ? local.integrations : [],
      note: 'workspace scope only. pass --global for account-level mail/chat/code hosts.',
    };
    if (json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log('Integration Status (workspace)\n');
    if (!payload.integrations.length) {
      console.log('  (none configured in this workspace)');
    } else {
      for (const name of payload.integrations) console.log(`  • ${name}`);
    }
    console.log('\nPass --global to check account-level gmail/slack/github status.');
    return 0;
  }

  const token = await getAuthToken();
  const rows = [];

  console.log('🔌 Integration Status (global):\n');

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
      rows.push({ name, connected: Boolean(connected) });
    } catch {
      console.log(`  ❓ ${name}`);
      rows.push({ name, connected: null });
    }
  }

  const imessage = imessageDoctor();
  console.log(`  ${imessage.connected ? '✅' : '❌'} iMessage (local Mac)`);
  rows.push({ name: 'imessage', connected: Boolean(imessage.connected) });

  console.log('\nConnect integrations at: https://atris.ai/dashboard/settings');
  if (json) {
    console.log(JSON.stringify({ scope: 'global', integrations: rows }, null, 2));
  }
  return 0;
}

module.exports = {
  googleCommand,
  googleConnect,
  gmailConnectUnified,
  gmailCommand,
  gmailConnect,
  gmailVoice,
  gmailUse,
  extractGmailMailboxAccount,
  parseGmailArgs,
  gmailAccountStatePath,
  gmailVerdictsPath,
  appendGmailVerdicts,
  readGmailVerdicts,
  printGmailVerdicts,
  parseGmailTriageArgs,
  gmailTriageVerdict,
  gmailTriage,
  calendarCommand,
  twitterCommand,
  slackCommand,
  slackSend,
  imessageCommand,
  integrationsStatus,
  parseCalendarSearchArgs,
  filterCalendarEventsForSearch,
  formatCalendarEvents,
  formatCalendarSearchResults,
  formatCalendarSearchError,
};
