'use strict';

const ROLLOUT_MESSAGE = 'backend rolling out, try again shortly';
const NOT_LOGGED_IN = 'not logged in. run: atris login';

function wantsJson(args = []) {
  return Array.isArray(args) && args.includes('--json');
}

function wantsHelp(args = []) {
  if (!Array.isArray(args) || args.length === 0) return false;
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

function tokenFrom(creds) {
  if (!creds || typeof creds !== 'object') return '';
  const token = typeof creds.token === 'string' ? creds.token.trim() : '';
  return token;
}

function isNotFound(result) {
  return Boolean(result && Number(result.status) === 404);
}

function oneLine(value) {
  if (value && typeof value === 'object') {
    const detail = value.detail || value.error || value.message;
    if (detail) return oneLine(detail);
    try {
      return JSON.stringify(value).replace(/\s+/g, ' ').trim();
    } catch {
      return 'request failed';
    }
  }
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text || 'request failed';
}

function printResult(result, io = {}) {
  const log = io.log || console.log;
  const err = io.err || console.error;
  if (result.json) {
    const payload = result.payload != null
      ? result.payload
      : { ok: false, error: result.error || result.text || 'request failed' };
    log(JSON.stringify(payload));
    return;
  }
  if (result.ok) log(result.text);
  else err(result.error || result.text || 'request failed');
}

function creditsToDollars(credits) {
  const n = Number(credits);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function formatDollars(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function normalizeBalance(data = {}) {
  const raw = data && typeof data === 'object' ? data : {};
  const credits = Number(raw.balance != null ? raw.balance : raw.credits);
  const safeCredits = Number.isFinite(credits) ? credits : 0;
  const usd = Number(raw.balance_usd);
  const dollars = Number.isFinite(usd) ? usd : creditsToDollars(safeCredits);
  return {
    dollars,
    credits: safeCredits,
    balance_usd: dollars,
    balance: safeCredits,
    lifetime_purchased: raw.lifetime_purchased != null ? raw.lifetime_purchased : null,
    lifetime_spent: raw.lifetime_spent != null ? raw.lifetime_spent : null,
  };
}

function checkoutUrl(data = {}) {
  const raw = data && typeof data === 'object' ? data : {};
  return String(raw.checkout_url || raw.url || raw.checkoutUrl || '').trim();
}

function parseAmountUsd(args = [], fallback = 10) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--json' || arg === '--help' || arg === '-h' || arg === 'help') continue;
    if (arg.startsWith('--')) continue;
    values.push(arg);
  }
  if (values.length === 0) return { ok: true, amount: fallback };
  const raw = String(values[0]).replace(/^\$/, '');
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount < 5 || amount > 500) {
    return { ok: false, error: 'amount must be a whole dollar from 5 to 500' };
  }
  return { ok: true, amount };
}

module.exports = {
  ROLLOUT_MESSAGE,
  NOT_LOGGED_IN,
  wantsJson,
  wantsHelp,
  tokenFrom,
  isNotFound,
  oneLine,
  printResult,
  formatDollars,
  normalizeBalance,
  checkoutUrl,
  parseAmountUsd,
};
