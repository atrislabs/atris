const { AsyncLocalStorage } = require('async_hooks');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { resolveBusiness } = require('./business-target');
const {
  assertOutboundSendAllowedOrExit,
  extractOutboundGateOptions,
} = require('./outbound-send-gate');
const { stateHome } = require('./state-home');
const { sleepSync } = require('./sleep-sync');

const googleContext = new AsyncLocalStorage();

function loadCredentials() {
  return require('../utils/auth').loadCredentials();
}

function ensureValidCredentials(...args) {
  return require('../utils/auth').ensureValidCredentials(...args);
}

function rawApiRequestJson(...args) {
  return require('../utils/api').apiRequestJson(...args);
}

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

function calendarCachePath() {
  return path.join(stateHome(), '.atris', 'calendar-events-cache.json');
}

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
    error.result = result;
    throw error;
  }
  if (result.ok && !Array.isArray(result.data?.accounts)) {
    const error = new Error('could not check google accounts: the server returned an incomplete account list');
    error.status = result.status || 0;
    error.result = result;
    throw error;
  }
  const capability = { supported: result.ok, data: result.data || {}, status: result.status || 0 };
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

function openGmailAuthUrl(authUrl, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const platform = deps.platform || process.platform;
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  const opened = run(command, [authUrl], { stdio: 'ignore' });
  return !opened.error && opened.status === 0;
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

function googleSignInRetry(name, products, business) {
  return ['atris google connect', name, products && `--only ${products.map((p) => p === 'gmail' ? 'mail' : p).join(',')}`, business ? `--business ${business}` : '--account'].filter(Boolean).join(' ');
}

function googleSignInFailure(result, { error, retry, status = 'error', extra = {} } = {}) {
  const data = result?.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {};
  console.log(JSON.stringify({ ok: false, status, http_status: result?.status || 0, error: error || result?.error || 'google sign-in did not finish', retry, ...extra, ...data }, null, 2));
  return 1;
}

function googleSignInErrorLines(status, business) {
  const reason = String(status.error || 'unknown error').replace(/_/g, ' ').toLowerCase();
  const lines = [status.error === 'superseded'
    ? 'the google connection changed before sign-in finished.'
    : `google sign-in did not finish: ${reason}.`];
  if (status.account_id) lines.push(`account: ${status.account_id}.`);
  if (Array.isArray(status.products)) {
    const products = status.products.map((p) => p === 'gmail' ? 'mail' : p);
    lines.push(products.length ? `products still connected: ${products.join(', ')}.` : 'no products remain connected.');
  } else lines.push('which products remain connected is unknown.');
  if (Array.isArray(status.failed) && status.failed.length) {
    const failed = status.failed.map((p) => p === 'gmail' ? 'mail' : p === 'result' ? 'saving the sign-in result' : p);
    lines.push(`could not finish: ${failed.join(', ')}.`);
  }
  if (Array.isArray(status.missing) && status.missing.length) lines.push(`google did not grant: ${status.missing.map((p) => p === 'gmail' ? 'mail' : p).join(', ')}.`);
  if (status.cleanup_incomplete) lines.push('some changes could not be undone.');
  if (status.business_assignment_unknown) lines.push('the business account choice may not have been saved.');
  const check = business ? `atris google accounts --business ${business}` : 'atris google accounts --account';
  lines.push(`check ${check} before trying again.`);
  return lines;
}

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
  const cachePath = calendarCachePath();
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(calendarCachePacket(rows, meta), null, 2)}\n`, 'utf8');
    return cachePath;
  } catch {
    return '';
  }
}

function readCalendarEventsCache() {
  const cachePath = calendarCachePath();
  try {
    const packet = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const events = Array.isArray(packet.events) ? packet.events : [];
    return {
      ok: true,
      path: cachePath,
      updatedAt: packet.updatedAt || '',
      accounts: Array.isArray(packet.accounts) ? packet.accounts : [],
      errors: Array.isArray(packet.errors) ? packet.errors : [],
      partial: Boolean(packet.partial || packet.errors?.length),
      events,
    };
  } catch {
    return { ok: false, path: cachePath, updatedAt: '', events: [] };
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

module.exports = {
  googleContext,
  loadCredentials,
  ensureValidCredentials,
  apiRequestJson,
  takeContext,
  GMAIL_CONNECT_POLL_MS,
  GMAIL_CONNECT_TIMEOUT_MS,
  GMAIL_SEND_USAGE,
  gmailVerdictsPath,
  appendGmailVerdicts,
  readGmailVerdicts,
  printGmailVerdicts,
  parseGmailTriageArgs,
  parseGmailVerdictsArgs,
  gmailAccountStatePath,
  googleAccountsCapability,
  prepareMailDefaults,
  resolveGmailAccountId,
  gmailAccountIdentity,
  sortGmailAccounts,
  formatGmailAccountRows,
  fetchGmailAccounts,
  resolveAccountSelector,
  promptForGmailAccount,
  getAuth,
  getAuthToken,
  extractGmailMailboxAccount,
  parseGmailArgs,
  gmailTriageVerdict,
  parseGmailSendArgs,
  parseGmailVoiceArgs,
  editGmailVoice,
  openGmailAuthUrl,
  googleOldServer,
  googleProductNames,
  googleProducts,
  googleFailure,
  saveGoogleDefault,
  googleSignInRetry,
  googleSignInFailure,
  googleSignInErrorLines,
  localDayBounds,
  localDateBounds,
  compareCalendarEvents,
  calendarReadMetadata,
  formatCalendarEvents,
  parseCalendarSearchArgs,
  filterCalendarEventsForSearch,
  writeCalendarEventsCache,
  readCalendarEventsCache,
  formatCalendarSearchResults,
  formatCalendarSearchError,
  parseLimit,
  argsWithoutLimit,
  resolveSlackChannel,
  formatSlackMessages,
  imessageDoctor,
  printImessageDoctor,
  imessageRecent,
  normalizeImessageHandle,
  scoreImessageContact,
  imessageLookup,
  imessageSend,
};
