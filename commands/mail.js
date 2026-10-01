'use strict';

// atris mail inboxes | read <inbox> | send <inbox> --to --subject --body
// Your agents' own email inboxes (the @atrismail.com ones), not your Gmail.
// For Gmail use `atris gmail`. Backend: /api/business/{id}/mail/...

const readline = require('readline');
const { apiRequestJson } = require('../utils/api');
const { NOT_LOGGED_IN } = require('../lib/developer-api');
const {
  NO_BUSINESS, parseArgs, resolveBusiness, loginToken, errorText, clip,
} = require('../lib/business-target');

function mailHelp(log = console.log) {
  log(`usage: atris mail inboxes [--business <slug>] [--json]
       atris mail read <inbox> [--limit 10] [--json]
       atris mail send <inbox> --to <address> --subject "<subject>" --body "<text>" [--yes]

your agents' own email inboxes (not your Gmail; for that use atris gmail).
<inbox> is the address, the part before the @, or the inbox id.

  inboxes   list every agent inbox in this business
  read      newest messages first (--limit 1 to 200, default 10)
  send      send one email from an agent inbox. asks before sending unless --yes`);
}

function toList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { return JSON.parse(value).map(String); } catch { /* fall through */ }
  }
  return value ? [String(value)] : [];
}

function renderInboxes(rows = []) {
  if (!rows.length) return 'No agent inboxes yet. Hiring an agent makes one: atris hire "<name>" --job "<idea>"';
  return rows.map((r) => `${r.email_address}${r.display_name ? `  (${r.display_name})` : ''}`).join('\n');
}

function renderMessages(inbox, rows = []) {
  if (!rows.length) return `No mail in ${inbox.email_address} yet.`;
  const lines = [];
  for (const m of rows) {
    const when = String(m.created_at || '').slice(0, 16).replace('T', ' ');
    const out = m.direction === 'outbound';
    const who = out ? `to ${toList(m.to_addresses).join(', ')}` : `from ${m.from_address || '?'}`;
    lines.push(`${when}  ${out ? 'sent' : 'got '}  ${who}`);
    lines.push(`  ${clip(m.subject || '(no subject)', 100)}`);
    const body = clip(m.body_text || '', 160);
    if (body) lines.push(`  ${body}`);
  }
  return lines.join('\n');
}

// address, local part, or id -> the inbox row
function findInbox(rows, wanted) {
  const w = String(wanted || '').trim().toLowerCase();
  if (!w) return null;
  return rows.find((r) => String(r.id).toLowerCase() === w)
    || rows.find((r) => String(r.email_address || '').toLowerCase() === w)
    || rows.find((r) => String(r.email_address || '').toLowerCase().split('@')[0] === w)
    || null;
}

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer || '').trim()));
    });
  });
}

async function mailCommand(args = [], deps = {}) {
  const out = { log: deps.log || console.log, err: deps.err || console.error };
  const { flags, pos } = parseArgs(args);
  const sub = pos[0];
  if (flags.help || !sub || sub === 'help') { mailHelp(out.log); return sub || flags.help ? 0 : 1; }
  if (!['inboxes', 'read', 'send'].includes(sub)) {
    out.err(`unknown mail command: ${sub}. try: atris mail inboxes | read | send`);
    return 1;
  }

  const business = resolveBusiness(flags, deps);
  if (!business) { out.err(NO_BUSINESS); return 1; }
  const token = await loginToken(deps);
  if (!token) { out.err(NOT_LOGGED_IN); return 1; }
  const request = deps.apiRequestJson || apiRequestJson;
  const base = `/business/${encodeURIComponent(business.id)}/mail`;

  const listed = await request(`${base}/inboxes`, { method: 'GET', token });
  if (!listed || !listed.ok) { out.err(`Could not load inboxes: ${errorText(listed)}`); return 1; }
  const inboxes = Array.isArray(listed.data) ? listed.data : [];

  if (sub === 'inboxes') {
    out.log(flags.json ? JSON.stringify(inboxes) : renderInboxes(inboxes));
    return 0;
  }

  if (!pos[1]) { out.err(`which inbox? atris mail ${sub} <inbox>`); return 1; }
  const inbox = findInbox(inboxes, pos[1]);
  if (!inbox) { out.err(`No inbox matches "${pos[1]}". See them all: atris mail inboxes`); return 1; }

  if (sub === 'read') {
    const limit = flags.limit == null ? 10 : Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) { out.err('--limit must be a number from 1 to 200'); return 1; }
    const res = await request(`${base}/inboxes/${encodeURIComponent(inbox.id)}/messages?limit=${limit}`, { method: 'GET', token });
    if (!res || !res.ok) { out.err(`Could not read ${inbox.email_address}: ${errorText(res)}`); return 1; }
    const rows = Array.isArray(res.data) ? res.data : [];
    out.log(flags.json ? JSON.stringify(rows) : renderMessages(inbox, rows));
    return 0;
  }

  // send
  const to = typeof flags.to === 'string' ? flags.to.trim() : '';
  const subject = typeof flags.subject === 'string' ? flags.subject : '';
  const text = typeof flags.body === 'string' ? flags.body : '';
  if (!to || !subject || !text) { out.err('send needs --to, --subject, and --body'); return 1; }
  if (!flags.yes) {
    out.log(`From:    ${inbox.email_address}\nTo:      ${to}\nSubject: ${subject}\n\n${text}\n`);
    const ok = await (deps.confirm || askYesNo)('Send this email? (y/N) ');
    if (!ok) {
      out.log(process.stdin.isTTY || deps.confirm ? 'Not sent.' : 'Not sent. Add --yes to send without asking.');
      return 1;
    }
  }
  const res = await request(`${base}/inboxes/${encodeURIComponent(inbox.id)}/messages/send`, {
    method: 'POST', token, body: { to, subject, text }, retries: 0, timeoutMs: 30000,
  });
  if (!res || !res.ok) { out.err(`Not sent: ${errorText(res)}`); return 1; }
  if (flags.json) out.log(JSON.stringify(res.data));
  else out.log(`Sent from ${inbox.email_address} to ${to}.`);
  return 0;
}

module.exports = { mailCommand, findInbox, renderInboxes, renderMessages };
