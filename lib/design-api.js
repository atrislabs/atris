'use strict';

// Shared client for the Atris design API. Used by `atris design` and the
// `atris mcp` stdio server so both resolve keys and bill the same way.
//
// Key resolution order:
//   1. ATRIS_API_KEY env var
//   2. login credentials token (atris login)
//   3. ~/.atris/design-api-key file (raw key text, saved by hand)
//
// Endpoints (see https://api.atris.ai/llms.txt):
//   POST /design/extractions {"url"}            -> job; poll GET /design/extractions/{id}
//   POST /design/adherence  {source, reference} -> job; poll GET /design/adherence/{id}
//   POST /design/search     {"query", "limit"}  -> sync result

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getApiBaseUrl, httpRequest } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');

const DESIGN_KEY_FILE = path.join(os.homedir(), '.atris', 'design-api-key');

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

function readKeyFile(file = DESIGN_KEY_FILE) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

// Returns the bearer token for design calls, or null when nothing is set up.
function resolveDesignKey(env = process.env, deps = {}) {
  const fromEnv = env.ATRIS_API_KEY && env.ATRIS_API_KEY.trim();
  if (fromEnv) return fromEnv;
  const load = deps.loadCredentials || loadCredentials;
  const creds = load();
  const token = creds && typeof creds.token === 'string' ? creds.token.trim() : '';
  if (token) return token;
  return (deps.readKeyFile || readKeyFile)();
}

// One JSON call against the design API. Returns { ok, status, data, error }.
async function designRequest(pathname, options = {}) {
  const key = options.key;
  const url = `${getApiBaseUrl()}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  const headers = {
    'Authorization': `Bearer ${key}`,
    'Accept': 'application/json',
    ...(options.headers || {}),
  };
  let body;
  if (options.body !== undefined && options.body !== null) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await httpRequest(url, {
    method: options.method || 'GET',
    headers,
    body,
    timeoutMs: options.timeoutMs != null ? options.timeoutMs : 30000,
  });
  const text = res.body.toString('utf8');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const ok = res.status >= 200 && res.status < 300;
  const error = !ok
    ? (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text.slice(0, 200) || `http ${res.status}`
    : undefined;
  return { ok, status: res.status, data, error };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Poll a design job until it finishes. `fetchJob` returns the parsed job
// object; `onTick` fires once per wait so callers can draw a spinner.
// Resolves { ok, job, timedOut } and never throws on a bad status.
async function pollDesignJob(fetchJob, options = {}) {
  const intervalMs = options.intervalMs != null ? options.intervalMs : POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : POLL_TIMEOUT_MS;
  const wait = options.sleep || sleep;
  const onTick = typeof options.onTick === 'function' ? options.onTick : null;
  const start = Date.now();
  let job = await fetchJob();
  while (job && job.status && !isTerminalStatus(job.status)) {
    if (Date.now() - start >= timeoutMs) return { ok: false, job, timedOut: true };
    if (onTick) onTick(Date.now() - start, job);
    await wait(intervalMs);
    job = await fetchJob();
  }
  const ok = Boolean(job) && job.status === 'completed' && !job.error;
  return { ok, job, timedOut: false };
}

function isTerminalStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'completed' || s === 'failed' || s === 'error' || s === 'succeeded';
}

// Pull the billing block off any design response. Top-level credits_charged on
// jobs is the job's price; atris.credits_charged is what this call billed.
function billingOf(data = {}) {
  const raw = data && typeof data === 'object' ? data : {};
  const atris = raw.atris && typeof raw.atris === 'object' ? raw.atris : {};
  const charged = Number(atris.credits_charged != null ? atris.credits_charged : raw.credits_charged);
  const balance = Number(atris.balance_remaining_usd);
  return {
    credits: Number.isFinite(charged) ? charged : null,
    balanceUsd: Number.isFinite(balance) ? balance : null,
  };
}

function creditLine(data) {
  const bill = billingOf(data);
  const charged = bill.credits == null ? '?' : `${bill.credits} credit${bill.credits === 1 ? '' : 's'}`;
  const left = bill.balanceUsd == null ? '' : ` $${bill.balanceUsd.toFixed(2)} left.`;
  return `${charged} charged.${left}`;
}

module.exports = {
  resolveDesignKey,
  designRequest,
  pollDesignJob,
  billingOf,
  creditLine,
};
