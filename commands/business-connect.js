'use strict';

/**
 * atris business connect [service] [--business slug]
 *
 * Connects a service to a business on the server, the same thing the
 * Integrations tab on the web does. With no service it shows what is
 * connected. Bot services take a token here; OAuth services open the
 * approval page in the browser.
 */

const { apiRequestJson } = require('../utils/api');
const { loadCredentials, openBrowser } = require('../utils/auth');
const { detectBusinessSlug } = require('../lib/business-core');
const { NOT_LOGGED_IN, wantsHelp, wantsJson, tokenFrom, oneLine, printResult } = require('../lib/developer-api');

/** Each business service: how to connect it, and the words to show for it. */
const SERVICES = {
  slack: { kind: 'oauth', label: 'Slack', fields: ['team_name'] },
  'google-drive': { kind: 'oauth', label: 'Google Drive', key: 'google_drive' },
  hubspot: { kind: 'oauth', label: 'HubSpot' },
  telegram: { kind: 'token', label: 'Telegram', body: (f) => ({ bot_token: f.token }), need: '--token <bot token from @BotFather>', fields: ['bot_username'] },
  discord: { kind: 'token', label: 'Discord', body: (f) => ({ bot_token: f.token, guild_id: f.guild || null }), need: '--token <bot token> [--guild <server id>]', fields: ['guild_name'] },
  whatsapp: { kind: 'token', label: 'WhatsApp', body: (f) => ({ access_token: f['access-token'], phone_number_id: f['phone-id'] }), need: '--access-token <token> --phone-id <id>', fields: ['phone_number_id'] },
};
const PERSONAL_ONLY = ['linear', 'notion', 'github', 'jira', 'salesforce', 'microsoft', 'gmail', 'calendar', 'mercury', 'brex', 'robinhood', 'x', 'twitter', 'linkedin'];

function showConnectHelp(log = console.log) {
  log('usage: atris business connect [business]                       what is connected');
  log('       atris business connect [business] slack                 opens the approval page');
  log('       atris business connect [business] google-drive | hubspot');
  log('       atris business connect [business] telegram --token <bot token>');
  log('       atris business connect [business] discord --token <bot token> [--guild <server id>]');
  log('       atris business connect [business] whatsapp --access-token <token> --phone-id <id>');
  log('       atris business connect [business] <service> --off      disconnect it');
  log('the business comes from the folder you are in when you leave it out. --no-open prints the url instead of opening it.');
  log('linear, notion, github and the rest connect to your own account, not a business: atris.ai/dashboard/integrations');
}

function readFlags(args, names) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (names.includes(arg)) {
      flags[arg.slice(2)] = args[i + 1];
      i += 1;
    } else if (!['--json', '--off', '--no-open'].includes(arg)) {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function failure(result) {
  const status = Number(result && result.status);
  if (status === 401) return NOT_LOGGED_IN;
  if (status === 403) return 'only the owner or an admin of this business can change its connections';
  if (status === 404) return 'no business with that name that you can see. try: atris business list';
  return oneLine(result && (result.errorMessage || result.error)) || `HTTP ${status || '?'}`;
}

/** The status as short lines: one per service, connected ones first with their detail. */
function statusText(business, status = {}) {
  const lines = [`${business}:`];
  for (const [name, svc] of Object.entries(SERVICES)) {
    const entry = status[svc.key || name] || {};
    if (entry.connected) {
      const detail = (svc.fields || []).map((f) => entry[f]).filter(Boolean).join(', ');
      lines.push(`  ${svc.label.padEnd(13)} connected${detail ? `, ${detail}` : ''}`);
    } else {
      lines.push(`  ${svc.label.padEnd(13)} not connected   atris business connect ${business} ${name}${svc.need ? ` ${svc.need}` : ''}`);
    }
  }
  const google = status.google || {};
  if (google.connected || google.account_email) lines.push(`  ${'Google'.padEnd(13)} ${google.account_email || 'connected'}`);
  return lines.join('\n');
}

async function connectCommand(args = [], deps = {}) {
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  if (wantsHelp(args)) {
    showConnectHelp(io.log);
    return 0;
  }
  const json = wantsJson(args);
  const fail = (error, extra = {}) => {
    printResult({ json, ok: false, error, payload: { ok: false, error, ...extra } }, io);
    return 1;
  };
  const { flags, rest } = readFlags(args, ['--business', '--token', '--guild', '--access-token', '--phone-id']);
  // The service is whichever word is a known service; the other word, if any, is the business.
  let service = null;
  let business = flags.business || null;
  for (const word of rest) {
    if (!service && (SERVICES[word] || PERSONAL_ONLY.includes(word))) service = word;
    else if (!business) business = word;
  }
  business = (deps.detectBusinessSlug || detectBusinessSlug)(business);
  if (!business) return fail('say which business: atris business connect sunset-ink');
  if (service && PERSONAL_ONLY.includes(service)) {
    return fail(`${service} connects to your own account, not to a business. open atris.ai/dashboard/integrations`);
  }
  const token = tokenFrom((deps.loadCredentials || loadCredentials)());
  if (!token) return fail(NOT_LOGGED_IN);
  const request = deps.apiRequestJson || apiRequestJson;
  const base = `/business/${encodeURIComponent(business)}/integrations`;

  try {
    if (!service) {
      const result = await request(base, { method: 'GET', token });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      printResult({ json, ok: true, text: statusText(business, result.data || {}), payload: { ok: true, business, integrations: result.data } }, io);
      return 0;
    }
    const svc = SERVICES[service];
    if (args.includes('--off')) {
      const result = await request(`${base}/${service}`, { method: 'DELETE', token });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      printResult({ json, ok: true, text: `${svc.label} is off for ${business}`, payload: { ok: true, business, service, connected: false } }, io);
      return 0;
    }
    if (svc.kind === 'token') {
      const body = svc.body(flags);
      if (Object.values(body).some((v) => v === undefined || v === '')) return fail(`${svc.label} needs ${svc.need}`);
      const result = await request(`${base}/${service}`, { method: 'POST', token, retries: 0, body });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      const data = result.data || {};
      const detail = (svc.fields || []).map((f) => data[f]).filter(Boolean).join(', ');
      printResult({ json, ok: true, text: `${svc.label} is connected to ${business}${detail ? ` as ${detail}` : ''}`, payload: { ok: true, business, service, ...data } }, io);
      return 0;
    }
    const result = await request(`${base}/${service}/start`, { method: 'POST', token, retries: 0, body: {} });
    if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
    const url = (result.data || {}).auth_url || (result.data || {}).url;
    if (!url) return fail(`the server gave no approval page for ${svc.label}`);
    const opened = !args.includes('--no-open') && Boolean((deps.openBrowser || openBrowser)(url));
    const text = opened
      ? `opening ${svc.label}'s approval page. finish there, then check: atris business connect ${business}\n${url}`
      : `open this to approve ${svc.label} for ${business}:\n${url}`;
    printResult({ json, ok: true, text, payload: { ok: true, business, service, auth_url: url, opened } }, io);
    return 0;
  } catch (error) {
    return fail(oneLine(error && error.message) || 'request failed');
  }
}

module.exports = { connectCommand, statusText, showConnectHelp, SERVICES };
