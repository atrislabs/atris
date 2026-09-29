'use strict';

// Shared helpers for `atris buy` and `atris transactions`.
// Backend: /api/commerce/* and /api/transactions (commerce_router.py).

const { ROLLOUT_MESSAGE, oneLine } = require('./developer-api');

// Flags whose values the backend reads as numbers.
const NUMERIC_KEYS = new Set(['quantity', 'dollars', 'limit_price', 'min_each_usd', 'max_each_usd', 'limit']);

function snake(key) {
  return String(key).replace(/-/g, '_');
}

function coerce(key, value) {
  if (value === true) return true;
  const text = String(value);
  if (/^[[{]/.test(text.trim())) {
    try { return JSON.parse(text); } catch { /* keep as text */ }
  }
  if (NUMERIC_KEYS.has(key) && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  return text;
}

// --event-url x --quantity 2 --accept-extras  ->  { event_url: 'x', quantity: 2, accept_extras: true }
function parseFlags(argv = []) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '-h') { flags.help = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const rawKey = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      const key = snake(rawKey);
      if (eq > 0) { flags[key] = coerce(key, arg.slice(eq + 1)); continue; }
      const next = argv[i + 1];
      if (next != null && !String(next).startsWith('--')) { flags[key] = coerce(key, next); i += 1; } else flags[key] = true;
      continue;
    }
    pos.push(arg);
  }
  return { flags, pos };
}

function formatCents(cents, currency = 'usd') {
  if (cents == null || cents === '' || !Number.isFinite(Number(cents))) return '-';
  const n = Number(cents) / 100;
  const sign = n < 0 ? '-' : '';
  const body = `$${Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  const code = String(currency || 'usd').toLowerCase();
  return code === 'usd' ? `${sign}${body}` : `${sign}${body} ${code.toUpperCase()}`;
}

// "2026-09-29T18:04:00Z" -> "in 30 min" / "expired"
function untilText(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const mins = Math.round((at - now) / 60000);
  if (mins <= 0) return 'expired';
  if (mins < 90) return `in ${mins} min`;
  return `in ${Math.round(mins / 60)} h`;
}

// The backend's error envelope is {"error": {"message", "type"}, "atris": {...}}.
// A bare 404 with no envelope means the route itself is not deployed yet.
function errorFrom(result) {
  const data = result && result.data;
  const envelope = data && typeof data === 'object' && data.error && typeof data.error === 'object';
  if (result && Number(result.status) === 404 && !envelope) return ROLLOUT_MESSAGE;
  if (envelope) return oneLine(data.error.message || data.error);
  return oneLine(result && result.error);
}

module.exports = { parseFlags, formatCents, untilText, errorFrom };
