/**
 * Pay commands for Atris CLI, send credits to another Atris account.
 *
 * Usage:
 *   atris pay <to> <amount> [memo...]   Pay someone in credits (100 credits = $1)
 *   atris pay history                   Your payments, newest first
 *   atris pay show <id>                 One payment
 *   atris pay accept <id>               Accept a payment someone sent you
 *   atris pay cancel <id>               Cancel a payment that is still waiting
 *
 * <to> can be @handle, handle, a user id, or an email. A leading @ is
 * stripped before it is sent. Every payment carries a request_id, so the one
 * retry after a network error can never pay twice.
 *
 * Backend: POST /api/pay, GET /api/pay/history, GET /api/pay/{id},
 * POST /api/pay/{id}/accept, POST /api/pay/{id}/cancel.
 */

const { randomUUID } = require('crypto');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { isHelpToken, argsWantHelp } = require('../lib/noninteractive');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBCOMMANDS = new Set(['history', 'show', 'accept', 'cancel']);
// Status 0 is a dropped connection; 502 and 504 mean a gateway lost the reply.
// In all three the payment may or may not have landed, so retry once with the
// same request_id and let the server dedupe.
const RETRY_STATUS = new Set([0, 502, 504]);

// Plain words for each error code, used when the server sends no message.
const ERROR_TEXT = {
  insufficient_credits: 'You do not have enough credits for this payment.',
  over_payment_cap: 'That is more than one payment can be.',
  over_daily_cap: 'You hit your daily payment limit. Try again tomorrow.',
  blocked: 'You cannot pay this account.',
  self_payment: 'You cannot pay yourself.',
  payment_not_found: 'No payment with that id.',
  not_pending: 'That payment is no longer waiting.',
  already_settled: 'That payment already went through.',
  request_id_reused: 'That request id was already used for a different payment.',
  expired: 'That payment expired.',
  payments_unavailable: 'Payments are down right now. Try again in a minute.',
  ledger_unavailable: 'Payments are down right now. Try again in a minute.',
  scope_required: 'This key cannot make payments.',
  invalid_amount: 'The amount must be a whole number of credits above 0.',
};

const HINTS = {
  insufficient_credits: 'Check your credits: atris balance · Buy more: atris topup',
};

function getToken() {
  const creds = loadCredentials();
  if (!creds || !creds.token) return null;
  return creds.token;
}

function errorCode(res) {
  const detail = res && res.data && res.data.detail;
  if (detail && typeof detail === 'object') return detail.code || detail.error || null;
  return null;
}

function apiErrorMessage(res, fallback) {
  const data = res && res.data;
  const detail = data && (data.detail || data.error);
  if (typeof detail === 'string') return detail;
  const code = errorCode(res);
  if (detail && typeof detail.message === 'string' && detail.message) return detail.message;
  if (detail && detail.error && typeof detail.error === 'object' && detail.error.message) return detail.error.message;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (res && res.status === 0) return 'Could not reach Atris. Check your connection and try again.';
  return fallback;
}

function formatCredits(amount) {
  const n = Number(amount) || 0;
  return `${n} credits ($${(n / 100).toFixed(2)})`;
}

// "@nora" -> "nora". Emails and ids pass through untouched.
function cleanTarget(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^@+/, '');
}

function targetLabel(raw) {
  const clean = cleanTarget(raw);
  if (!clean) return '';
  if (clean.includes('@') || UUID_RE.test(clean)) return clean;
  return `@${clean}`;
}

function parseAmount(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n > 0 ? n : null;
}

function whenText(value) {
  const s = String(value || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s;
}

function splitFlags(args) {
  const list = Array.isArray(args) ? args : [];
  return {
    json: list.includes('--json'),
    rest: list.filter((a) => a !== '--json'),
  };
}

function createIo(io = {}) {
  return {
    request: io.request || apiRequestJson,
    token: io.token !== undefined ? io.token : undefined,
    log: io.log || console.log,
    error: io.error || console.error,
    newId: io.newId || randomUUID,
  };
}

async function call(io, pathname, options = {}) {
  const token = io.token !== undefined ? io.token : getToken();
  if (!token) {
    return { ok: false, status: 401, data: null, notLoggedIn: true };
  }
  return io.request(pathname, { ...options, token });
}

// Print the error in plain words and return the exit code.
function reportError(io, res, fallback) {
  if (res && res.notLoggedIn) {
    io.error('Not logged in. Run: atris login');
    return 1;
  }
  if (res && res.status === 401) {
    io.error('Session expired. Run: atris login');
    return 1;
  }
  io.error(apiErrorMessage(res, fallback));
  const hint = HINTS[errorCode(res)];
  if (hint) io.error(hint);
  return 1;
}

function receiptLine(receipt, label) {
  const r = receipt || {};
  const amount = formatCredits(r.amount_credits);
  const who = label || r.to || 'them';
  switch (r.status) {
    case 'settled':
      return `Paid ${who} ${amount}. Settled.`;
    case 'settling':
      return `Paid ${who} ${amount}. Settling, it finishes on its own.`;
    case 'pending':
      return `Sent ${who} ${amount}. Waiting for them to accept. id ${r.id}`;
    case 'refunded':
      return `Payment to ${who} of ${amount} was refunded. id ${r.id}`;
    case 'failed':
      return `Payment to ${who} of ${amount} failed. id ${r.id}`;
    default:
      return `Payment to ${who} of ${amount}: ${r.status || 'unknown'}. id ${r.id}`;
  }
}

async function send(io, args, json) {
  const [rawTo, rawAmount, ...memoParts] = args;
  const to = cleanTarget(rawTo);
  if (!to || rawAmount === undefined) {
    io.error('Usage: atris pay <to> <amount> [memo]');
    return 2;
  }
  const amount = parseAmount(rawAmount);
  if (amount === null) {
    io.error(`"${rawAmount}" is not an amount. Use a whole number of credits (100 credits = $1).`);
    io.error('Example: atris pay @nora 500 for the logo');
    return 2;
  }
  const memo = memoParts.join(' ').trim();
  const body = { to, amount_credits: amount, request_id: io.newId() };
  if (memo) body.memo = memo;

  // The API helper's own retry is off so this one retry is the only one, and
  // it carries the same request_id.
  const options = { method: 'POST', body, retries: 0 };
  let res = await call(io, '/pay', options);
  if (!res.notLoggedIn && RETRY_STATUS.has(res.status)) {
    res = await call(io, '/pay', options);
  }
  if (!res.ok) return reportError(io, res, `Payment failed (${res.status})`);
  const receipt = res.data || {};
  if (json) {
    io.log(JSON.stringify(receipt, null, 2));
  } else {
    io.log(receiptLine(receipt, targetLabel(rawTo)));
  }
  return receipt.status === 'failed' ? 1 : 0;
}

function historyRows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.payments)) return data.payments;
  return [];
}

async function history(io, json) {
  const res = await call(io, '/pay/history');
  if (!res.ok) return reportError(io, res, `Could not load payments (${res.status})`);
  const rows = historyRows(res.data);
  if (json) {
    io.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    io.log('No payments yet. Pay someone: atris pay @handle 500');
    return 0;
  }
  io.log(`Payments (${rows.length}):`);
  for (const r of rows) {
    const incoming = r.direction === 'in';
    const verb = incoming ? 'got' : 'sent';
    const who = incoming ? `from ${r.from}` : `to ${r.to}`;
    const memo = r.memo ? `  "${r.memo}"` : '';
    io.log(`  ${whenText(r.created_at)}  ${verb} ${formatCredits(r.amount_credits)} ${who}  ${r.status}${memo}`);
    io.log(`      id ${r.id}`);
  }
  return 0;
}

function printReceipt(io, r) {
  io.log(`Payment ${r.id}`);
  io.log(`  Status   ${r.status}`);
  io.log(`  Amount   ${formatCredits(r.amount_credits)}`);
  io.log(`  From     ${r.from}`);
  io.log(`  To       ${r.to}`);
  if (r.memo) io.log(`  Memo     ${r.memo}`);
  if (r.created_at) io.log(`  Made     ${whenText(r.created_at)}`);
  if (r.settled_at) io.log(`  Settled  ${whenText(r.settled_at)}`);
  if (r.expires_at) io.log(`  Expires  ${whenText(r.expires_at)}`);
}

async function show(io, id, json) {
  if (!id || isHelpToken(id)) {
    io.error('Usage: atris pay show <id>');
    return 2;
  }
  const res = await call(io, `/pay/${encodeURIComponent(id)}`);
  if (!res.ok) return reportError(io, res, `Could not load that payment (${res.status})`);
  const receipt = res.data || {};
  if (json) io.log(JSON.stringify(receipt, null, 2));
  else printReceipt(io, receipt);
  return 0;
}

async function act(io, action, id, json) {
  if (!id || isHelpToken(id)) {
    io.error(`Usage: atris pay ${action} <id>`);
    return 2;
  }
  const res = await call(io, `/pay/${encodeURIComponent(id)}/${action}`, { method: 'POST', retries: 0 });
  if (!res.ok) return reportError(io, res, `Could not ${action} that payment (${res.status})`);
  const r = res.data || {};
  if (json) {
    io.log(JSON.stringify(r, null, 2));
    return 0;
  }
  const amount = formatCredits(r.amount_credits);
  if (action === 'accept') {
    io.log(r.status === 'settled' || r.status === 'settling'
      ? `Accepted. ${amount} ${r.status === 'settling' ? 'are on the way' : 'are yours'}.`
      : `Payment ${r.id} is ${r.status}.`);
  } else {
    io.log(r.status === 'refunded'
      ? `Canceled. ${amount} went back to the sender.`
      : `Payment ${r.id} is ${r.status}.`);
  }
  return 0;
}

function printHelp(log = console.log) {
  log(`atris pay, send credits to another Atris account (100 credits = $1)

  atris pay <to> <amount> [memo]   Pay someone, like: atris pay @nora 500 for the logo
  atris pay history                Your payments, newest first
  atris pay show <id>              One payment
  atris pay accept <id>            Take a payment someone sent you
  atris pay cancel <id>            Cancel a payment that is still waiting

  <to> is @handle, a user id, or an email.
  Some payments wait for the other person to accept. You get an id to check on it.
  Add --json for the raw receipt.
  See who you trust first: atris trust <handle>`);
}

async function payCommand(argv, ioOverrides) {
  const io = createIo(ioOverrides);
  const { json, rest } = splitFlags(argv || process.argv.slice(3));
  const sub = rest[0];
  if (sub === undefined || isHelpToken(sub)) {
    printHelp(sub === undefined ? io.error : io.log);
    return sub === undefined ? 2 : 0;
  }
  if (argsWantHelp(rest)) {
    printHelp(io.log);
    return 0;
  }
  // Subcommand words always win, so a typo never sends money. To pay someone
  // whose handle is one of these words, write it with the @: atris pay @history 500.
  if (SUBCOMMANDS.has(sub)) {
    if (sub === 'history') return history(io, json);
    if (sub === 'show') return show(io, rest[1], json);
    return act(io, sub, rest[1], json);
  }
  return send(io, rest, json);
}

module.exports = {
  payCommand,
  apiErrorMessage,
  formatCredits,
  cleanTarget,
  targetLabel,
  createIo,
  call,
  reportError,
};
