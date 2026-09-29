'use strict';

// atris transactions: every order, fee, trade, and wallet send, newest first.
// Read only. Backend: GET /api/transactions.

const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, tokenFrom, oneLine, printResult } = require('../lib/developer-api');
const { parseFlags, formatCents, errorFrom } = require('../lib/commerce');

const TX_KINDS = ['ticket', 'shop', 'flight', 'test_purchase', 'fee', 'trade', 'wallet_send'];

function showTransactionsHelp(log = console.log) {
  log(`usage: atris transactions [--since YYYY-MM-DD] [--kind k[,k]] [--limit n] [--json]

list what you bought, paid in fees, traded, or sent, newest first. read only.

  --since   only rows on or after this date, like 2026-09-01
  --kind    ${TX_KINDS.join(', ')}
  --limit   1 to 200 (default 50)`);
}

function clip(text, width) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

function whenText(value) {
  const s = String(value || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : clip(s, 16);
}

function renderTransactions(data = {}) {
  const rows = Array.isArray(data.transactions) ? data.transactions : [];
  const lines = [];
  if (!rows.length) lines.push('No transactions yet.');
  else {
    const table = rows.map((r) => [
      whenText(r.when),
      clip(r.kind, 12),
      clip(r.what, 40),
      formatCents(r.amount_cents, r.currency),
      clip(r.state, 16),
    ]);
    const head = ['WHEN', 'KIND', 'WHAT', 'AMOUNT', 'STATE'];
    const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
    const fmt = (row) => row.map((cell, i) => (i === 3 ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
      .join('  ').trimEnd();
    lines.push(fmt(head));
    for (const row of table) lines.push(fmt(row));
  }
  const down = Object.entries(data.sources || {}).filter(([, v]) => v !== 'ok').map(([k]) => k);
  if (down.length) lines.push('', `Partial list: could not load ${down.join(', ')}.`);
  return lines.join('\n');
}

function buildQuery(flags) {
  const params = new URLSearchParams();
  if (flags.since != null) {
    const since = String(flags.since).trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(since)) return { ok: false, error: '--since must be a date like 2026-09-01' };
    params.set('since', since);
  }
  const rawKind = flags.kind != null ? flags.kind : flags.kinds;
  if (rawKind != null) {
    const kinds = String(rawKind).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    const bad = kinds.filter((k) => !TX_KINDS.includes(k));
    if (bad.length || !kinds.length) return { ok: false, error: `--kind must be one of ${TX_KINDS.join(', ')}` };
    params.set('kinds', kinds.join(','));
  }
  if (flags.limit != null) {
    const limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: '--limit must be a number from 1 to 200' };
    params.set('limit', String(limit));
  }
  const qs = params.toString();
  return { ok: true, path: qs ? `/transactions?${qs}` : '/transactions' };
}

async function transactionsCommand(args = [], deps = {}) {
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  const { flags, pos } = parseFlags(args);
  if (flags.help || pos[0] === 'help') {
    showTransactionsHelp(io.log);
    return 0;
  }
  const json = flags.json === true;
  const fail = (error, status) => {
    printResult({ json, ok: false, error, payload: { ok: false, error, ...(status ? { status } : {}) } }, io);
    return 1;
  };

  const query = buildQuery(flags);
  if (!query.ok) return fail(query.error);

  const load = deps.loadCredentials || loadCredentials;
  const request = deps.apiRequestJson || apiRequestJson;
  const token = tokenFrom(load());
  if (!token) return fail(NOT_LOGGED_IN);

  try {
    const result = await request(query.path, { method: 'GET', token });
    if (!result || !result.ok) return fail(errorFrom(result), result && result.status);
    const data = result.data || {};
    printResult({ json, ok: true, text: renderTransactions(data), payload: { ok: true, ...data } }, io);
    return 0;
  } catch (error) {
    return fail(oneLine(error && error.message));
  }
}

module.exports = { transactionsCommand };
