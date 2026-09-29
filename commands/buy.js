'use strict';

// atris buy: quote a purchase or trade, start the person's approval, check status.
//
//   atris buy quote --kind ticket --event-url <vividseats url> --quantity 2
//   atris buy approve ord_<id> --pick 1 --delivery-email sam@example.com
//   atris buy status ord_<id>
//
// Nothing is ever charged by this command. Approve only starts the human step:
// a tap in their Link app, a payment page, or a reply to the confirm code Atris
// texts to their own phone. The code never comes back to this command.

const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, oneLine, printResult } = require('../lib/developer-api');
const { parseFlags, formatCents, untilText, errorFrom, commerceToken } = require('../lib/commerce');

const KINDS = ['ticket', 'shop', 'trade', 'flight'];
const NOTHING_CHARGED = 'Nothing is charged until the person approves it themselves.';
const CONTROL_FLAGS = new Set(['json', 'help', 'intent', 'details']);
const TRADE_CONFIRM = 'We texted you a confirm code. Reply to that text to place the trade.';

function showBuyHelp(log = console.log) {
  log(`usage: atris buy <quote|approve|status> [flags] [--json]

get a real quote, then hand the person the approval step. nothing is charged
until the person approves it themselves (Link app, payment page, or a text
from their own phone).

  atris buy quote --kind ticket|shop|trade|flight [fields] [--intent '<json>']
  atris buy approve <id> [fields] [--details '<json>']
  atris buy status <id>

quote fields (flags, kebab-case is fine):
  ticket  --event-url <vividseats.com url> --quantity N [--min-each-usd N] [--max-each-usd N]
  shop    --query "<item>" | --url <product url>  [--quantity N]
  trade   --side buy|sell --symbol VTI (--quantity N | --dollars N) [--order-type market|limit --limit-price N]
  flight  not wired yet, quotes are refused

approve fields:
  ticket  --pick 1 --delivery-email you@example.com
  shop    --delivery-email you@example.com [--options '<json>'] [--address '<json>'] [--accept-extras]
  trade   none. Atris texts the person a confirm code; they reply to that text.

examples:
  atris buy quote --kind trade --side buy --symbol VTI --dollars 25
  atris buy quote --intent '{"kind":"shop","query":"uniqlo supima crew tee navy"}'
  atris buy approve ord_1234 --pick 1 --delivery-email sam@example.com
  atris buy status ord_1234 --json`);
}

function fieldsFrom(flags) {
  const out = {};
  for (const [key, value] of Object.entries(flags)) {
    if (!CONTROL_FLAGS.has(key)) out[key] = value;
  }
  return out;
}

function jsonFlag(flags, name) {
  if (flags[name] == null) return { ok: true, value: {} };
  const value = flags[name];
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
  return { ok: false, error: `--${name} must be a JSON object, like --${name} '{"kind":"shop","query":"navy tee"}'` };
}

function approvalLines(approval) {
  if (!approval || typeof approval !== 'object') return [];
  const lines = [];
  // The backend sends trade confirm codes only to the person's own texts.
  if (approval.how === 'text_confirm') return [TRADE_CONFIRM];
  if (approval.url) {
    const label = approval.how === 'connect_link' ? 'Connect Link first'
      : approval.how === 'payment_page' ? 'Pay on this page'
        : 'Approve in Link';
    lines.push(`${label}: ${approval.url}`);
  }
  if (approval.text) lines.push(approval.text);
  return lines;
}

function moneyLines(data) {
  const lines = [];
  if (data.total_cents != null) lines.push(`Total: ${formatCents(data.total_cents, data.currency)}`);
  if (data.fee_cents != null) lines.push(`Atris fee: ${formatCents(data.fee_cents, data.currency)}`);
  return lines;
}

function renderQuote(data = {}, now = Date.now()) {
  const lines = [];
  if (data.status !== 'quoted') return renderOutcome(data, now);
  lines.push(data.summary || 'Quote ready.');
  lines.push('');
  lines.push(...moneyLines(data));
  if (data.expires_at) lines.push(`Expires: ${data.expires_at} (${untilText(data.expires_at, now)})`);
  if (data.id) lines.push(`Quote id: ${data.id}`);
  if (data.product_url) lines.push(`Product: ${data.product_url}`);
  const choices = data.options && typeof data.options === 'object' && !Array.isArray(data.options)
    ? Object.entries(data.options) : [];
  if (choices.length) {
    lines.push('Choices:');
    for (const [name, values] of choices) {
      lines.push(`  ${name}: ${Array.isArray(values) ? values.join(', ') : oneLine(values)}`);
    }
  }
  if (data.note) lines.push('', String(data.note));
  lines.push('');
  lines.push(NOTHING_CHARGED);
  const approval = data.approval && data.approval.text ? data.approval.text : '';
  if (approval) lines.push(approval);
  if (data.id) {
    const hints = data.approve_with && typeof data.approve_with === 'object'
      ? Object.keys(data.approve_with).map((key) => `--${key.replace(/_/g, '-')} <${key}>`).join(' ')
      : '';
    lines.push(`Once they say yes: atris buy approve ${data.id}${hints ? ` ${hints}` : ''}`);
  }
  return lines.join('\n');
}

function renderOutcome(data = {}, now = Date.now()) {
  const lines = [];
  const status = String(data.status || '');
  if (status === 'pending_approval') {
    lines.push(data.message || 'Waiting for the person to approve.');
    lines.push('');
    lines.push(...moneyLines(data));
    if (data.expires_at) lines.push(`Expires: ${data.expires_at} (${untilText(data.expires_at, now)})`);
    if (data.id) lines.push(`Id: ${data.id}`);
    lines.push('');
    lines.push('Next, the person does this themselves:');
    for (const line of approvalLines(data.approval)) lines.push(`  ${line}`);
    if (data.fee_card && data.fee_card.url) lines.push(`  Fee card: ${data.fee_card.url}`);
    lines.push('');
    lines.push('Nothing has been charged yet. Money moves only after the person acts themselves.');
    if (data.id) lines.push(`Check it: atris buy status ${data.id}`);
    return lines.join('\n');
  }
  if (status === 'needs_setup') {
    lines.push(data.message || 'Setup needed first.');
    for (const line of approvalLines(data.approval)) lines.push(`  ${line}`);
    lines.push('Nothing was charged.');
    return lines.join('\n');
  }
  if (status === 'needs_input') {
    lines.push(data.message || 'More details needed.');
    if (Array.isArray(data.fields) && data.fields.length) lines.push(`Needed: ${data.fields.join(', ')}`);
    if (data.extra_usd != null) lines.push(`Extra: $${data.extra_usd}`);
    if (data.total_usd != null) lines.push(`New total: $${data.total_usd}`);
    lines.push('Nothing was charged.');
    return lines.join('\n');
  }
  if (status === 'refused') {
    lines.push(data.message || 'That did not go through.');
    if (!/nothing was/i.test(String(data.message || ''))) lines.push('Nothing was charged.');
    return lines.join('\n');
  }
  return data.message || oneLine(data);
}

function renderStatus(data = {}) {
  const lines = [];
  lines.push(`${data.id || ''}  ${data.kind || ''}  ${String(data.state || 'unknown').toUpperCase()}`.trim());
  if (data.what) lines.push(`What: ${data.what}`);
  if (data.amount_cents != null) lines.push(`Amount: ${formatCents(data.amount_cents, data.currency)}`);
  if (data.when) lines.push(`When: ${data.when}`);
  if (data.detail) lines.push(`Detail: ${data.detail}`);
  if (data.counterparty) lines.push(`With: ${data.counterparty}`);
  if (data.receipt_url) lines.push(`Receipt: ${data.receipt_url}`);
  if (data.fee_payment_url) lines.push(`Pay the Atris fee: ${data.fee_payment_url}`);
  const approval = approvalLines(data.approval);
  if (approval.length) {
    lines.push('Waiting on the person:');
    for (const line of approval) lines.push(`  ${line}`);
  }
  if (data.state === 'unknown') lines.push('Money may have moved. Check the store or Robinhood app. Do not buy again to fix it.');
  return lines.join('\n');
}

function buildRequest(sub, pos, flags) {
  if (sub === 'quote') {
    const base = jsonFlag(flags, 'intent');
    if (!base.ok) return base;
    const body = { ...base.value, ...fieldsFrom(flags) };
    const kind = String(body.kind || '').toLowerCase();
    if (!KINDS.includes(kind)) return { ok: false, error: `--kind must be one of ${KINDS.join(', ')}` };
    body.kind = kind;
    return { ok: true, path: '/commerce/quote', method: 'POST', body };
  }
  if (sub === 'approve' || sub === 'status') {
    const id = String(pos[1] || '').trim();
    if (!id) return { ok: false, error: `usage: atris buy ${sub} <id>` };
    const path = `/commerce/${encodeURIComponent(id)}`;
    if (sub === 'status') return { ok: true, path, method: 'GET' };
    const base = jsonFlag(flags, 'details');
    if (!base.ok) return base;
    return { ok: true, path: `${path}/approve`, method: 'POST', body: { ...base.value, ...fieldsFrom(flags) } };
  }
  return { ok: false, error: 'usage: atris buy <quote|approve|status>. run: atris buy --help' };
}

async function buyCommand(args = [], deps = {}) {
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  const { flags, pos } = parseFlags(args);
  const sub = String(pos[0] || '').toLowerCase();
  if (!sub || sub === 'help' || flags.help) {
    showBuyHelp(io.log);
    return 0;
  }

  const json = flags.json === true;
  const fail = (error, status) => {
    printResult({ json, ok: false, error, payload: { ok: false, error, ...(status ? { status } : {}) } }, io);
    return 1;
  };

  const req = buildRequest(sub, pos, flags);
  if (!req.ok) return fail(req.error);

  const load = deps.loadCredentials || loadCredentials;
  const request = deps.apiRequestJson || apiRequestJson;
  const token = commerceToken(load(), 'commerce:quote', deps.now ? deps.now() : Date.now());
  if (!token) return fail(NOT_LOGGED_IN);

  try {
    // No retries: a quote or approval must never be sent twice by accident.
    const options = { method: req.method, token, retries: 0 };
    if (req.body) options.body = req.body;
    const result = await request(req.path, options);
    if (!result || !result.ok) return fail(errorFrom(result), result && result.status);
    const data = result.data || {};
    const now = deps.now ? deps.now() : Date.now();
    const text = sub === 'quote' ? renderQuote(data, now)
      : sub === 'approve' ? renderOutcome(data, now)
        : renderStatus(data);
    printResult({ json, ok: true, text, payload: { ok: true, ...data } }, io);
    return 0;
  } catch (error) {
    return fail(oneLine(error && error.message));
  }
}

module.exports = { buyCommand };
