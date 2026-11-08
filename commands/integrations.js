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

const fs = require('fs');
const path = require('path');
const {
  assertOutboundSendAllowedOrExit,
  prepareOutboundSendTextOrExit,
} = require('../lib/outbound-send-gate');
const {
  googleContext,
  loadCredentials,
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
  imessageLookup,
  imessageSend,
} = require('../lib/integrations-core');

// ============================================================================
// GMAIL
// ============================================================================

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

  const reqPath = `/integrations/gmail/messages?max_results=${limit}&account_id=${encodeURIComponent(accountId)}`;

  const result = await apiRequestJson(reqPath, {
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

  const reqPath = `/integrations/gmail/messages/${messageId}?account_id=${encodeURIComponent(accountId)}`;

  const result = await apiRequestJson(reqPath, {
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
    if (deps.json) return googleSignInFailure(result, { error: detail, retry: deps.retry });
    console.error(`could not start gmail connection: ${detail}`);
    process.exit(1);
  }

  const authUrl = String(result.data?.auth_url || result.data?.url || '').trim();
  if (!authUrl) {
    if (deps.json) return googleSignInFailure(result, { error: 'the server did not return a sign-in url', retry: deps.retry });
    console.error('could not start gmail connection: the server did not return an auth url.');
    process.exit(1);
  }

  const openAuthUrl = deps.openAuthUrl || openGmailAuthUrl;
  const opened = openAuthUrl(authUrl, deps);
  if (deps.json) {
    console.log(JSON.stringify({ ok: false, status: 'unconfirmed', auth_url: authUrl, opened, notice: googleOldServer }, null, 2));
    return 1;
  }
  if (!opened) {
    console.log(`open this url in your browser: ${authUrl}`);
  }

  console.log(`${opened ? 'sign-in opened' : 'sign-in link is ready to open'}. it is not confirmed yet. finish in your browser and check with atris google accounts --account.`);
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

async function googleConnect(name, products, business, deps = {}) {
  if (name && (!/^[a-z0-9-]{1,32}$/.test(name) || name === 'all')) throw new Error('invalid google account name. use 1 to 32 lowercase letters, numbers, or hyphens');
  const retry = googleSignInRetry(name, products, business);
  const token = await getAuthToken();
  let before;
  try { before = await googleAccountsCapability(token); }
  catch (error) {
    if (!deps.json) throw error;
    return googleSignInFailure(error.result || { status: error.status }, { error: error.message, retry });
  }
  if (!before.supported) {
    if (!deps.quietOldServer && !deps.json) console.log(googleOldServer);
    if (!products || products.includes('gmail')) return gmailConnect(name, { ...deps, retry });
    if (deps.json) return googleSignInFailure({ status: before.status, data: before.data }, { error: googleOldServer, retry });
    return;
  }
  const body = {};
  if (name) body.account_id = name;
  if (products) body.products = products;
  if (business) body.business_id = business;
  const result = await apiRequestJson('/integrations/google/start', { method: 'POST', token, body });
  if (result.status === 404) {
    if (!deps.quietOldServer && !deps.json) console.log(googleOldServer);
    if (!products || products.includes('gmail')) return gmailConnect(name, { ...deps, retry });
    if (deps.json) return googleSignInFailure(result, { error: googleOldServer, retry });
    return;
  }
  if (!result.ok) {
    if (deps.json) return googleSignInFailure(result, { error: result.error || 'could not start google connection', retry });
    return googleFailure(result, 'start google connection');
  }
  const url = result.data?.auth_url;
  const state = result.data?.state;
  const missing = !url ? `the server did not return a sign-in url. start again with ${retry}.` : !state ? `the server did not return a sign-in state. start again with ${retry}.` : '';
  if (missing) {
    if (deps.json) return googleSignInFailure(result, { error: missing, retry });
    throw new Error(missing);
  }
  if (!(deps.openAuthUrl || openGmailAuthUrl)(url, deps)) (deps.json ? console.error : console.log)(`open this url in your browser: ${url}`);
  if (!deps.json) console.log('waiting for google sign-in...');
  const interval = deps.pollIntervalMs ?? GMAIL_CONNECT_POLL_MS;
  const timeout = deps.timeoutMs ?? GMAIL_CONNECT_TIMEOUT_MS;
  const count = Math.max(1, Math.ceil(timeout / interval));
  const now = deps.now || Date.now;
  const deadline = now() + timeout;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const id = result.data?.account_id || name;
  let lastFailure = null;
  for (let i = 0; i < count && now() < deadline; i += 1) {
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    const pollOptions = { method: 'GET', token, timeoutMs: Math.max(1, Math.min(interval, deadline - now())), retries: 0 };
    const check = await apiRequestJson(`/integrations/google/start/${encodeURIComponent(state)}`, pollOptions);
    if (check.status === 404) {
      if (deps.json) return googleSignInFailure(check, { error: 'sign_in_expired', retry });
      console.error(`google sign-in expired. start again with ${retry}.`);
      process.exit(1);
    }
    if (!check.ok) {
      if (check.status === 401 || check.status === 403) {
        if (deps.json) return googleSignInFailure(check, { error: check.error || 'could not check google sign-in', retry });
        return googleFailure(check, 'check google sign-in');
      }
      lastFailure = check;
      continue;
    }
    lastFailure = null;
    const status = check.data || {};
    if (status.status === 'error') {
      if (deps.json) return googleSignInFailure(check, { retry });
      for (const line of googleSignInErrorLines(status, business)) console.error(line);
      process.exit(1);
    }
    if (status.status === 'connected') {
      if (deps.json) { console.log(JSON.stringify({ ok: true, ...status }, null, 2)); return; }
      const accountId = status.account_id || id || 'account';
      const identity = status.email || accountId;
      const granted = Array.isArray(status.products) ? status.products : [];
      const missing = Array.isArray(status.missing) ? status.missing : [];
      console.log(`connected ${identity} as ${accountId}${granted.length ? `: ${granted.map((p) => p === 'gmail' ? 'mail' : p).join(', ')}` : ''}`);
      if (missing.length) console.log(`google did not grant: ${missing.map((p) => p === 'gmail' ? 'mail' : p).join(', ')}`);
      return;
    }
  }
  if (deps.json) return googleSignInFailure(lastFailure, { status: 'pending', error: 'sign_in_unconfirmed', retry, extra: { auth_url: url } });
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
    console.log('use --json to list accounts or report a sign-in result.');
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
    if (json && !['accounts', 'connect'].includes(action)) throw new Error('--json is available for google accounts and connect');
    if (action === 'connect') return googleConnect(positional[0], only, context.explicitBusiness ? context.business : null, { json });
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
          ? `atris google connect ${row.account_id} --only ${product === 'gmail' ? 'mail' : product} --account` : null;
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
      console.log('  atris calendar add "Title" --date YYYY-MM-DD --from HH:MM --to HH:MM - Create an event');
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
