'use strict';

const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const {
  NOT_LOGGED_IN,
  ROLLOUT_MESSAGE,
  wantsHelp,
  wantsJson,
  tokenFrom,
  isNotFound,
  oneLine,
  printResult,
} = require('../lib/developer-api');

function showUsageHelp() {
  console.log('usage: atris usage [--json]');
  console.log('show developer api usage: every key you own when signed in, or one key with ATRIS_API_KEY.');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Signed in as a person, the server answers with every developer key you own
// plus a total. One line per key, then the total.
function renderKeyBreakdown(usage) {
  const total = usage.total && typeof usage.total === 'object' ? usage.total : {};
  const days = Number(total.period_days) || 30;
  const lines = [`last ${days} days, ${plural(usage.keys.length, 'developer key')}:`];
  for (const entry of usage.keys) {
    const u = (entry && entry.usage) || {};
    const label = `${entry.agent_name || 'key'} (${u.api_key || 'key'})`;
    const errors = Number(u.error_count) || 0;
    lines.push(`  ${label}: ${plural(Number(u.total_requests) || 0, 'request')}${errors ? `, ${plural(errors, 'error')}` : ''}`);
  }
  const totalErrors = Number(total.error_count) || 0;
  lines.push(`total: ${plural(Number(total.total_requests) || 0, 'request')}${totalErrors ? `, ${plural(totalErrors, 'error')} (${total.error_rate}%)` : ''}`);
  const endpoints = Object.entries(total.endpoints || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (endpoints.length) lines.push(`busiest: ${endpoints.map(([name, count]) => `${name} ${count}`).join(', ')}`);
  return lines.join('\n');
}

function renderUsage(data = {}) {
  const raw = data && typeof data === 'object' ? data : {};
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : raw;
  if (Array.isArray(usage.keys)) {
    return usage.keys.length ? renderKeyBreakdown(usage) : 'no developer keys yet. make one with atris api-key create';
  }
  const lines = [];
  if (raw.agent_name || raw.agent_id) {
    lines.push(`${raw.agent_name || 'agent'} ${raw.agent_id || ''}`.trim());
  }
  const keys = Object.keys(usage).filter((key) => key !== 'agent_name' && key !== 'agent_id');
  if (keys.length === 0) {
    lines.push('no usage recorded.');
    return lines.join('\n');
  }
  for (const key of keys) {
    const value = usage[key];
    if (value && typeof value === 'object') {
      lines.push(`${key}: ${oneLine(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

const USAGE_NEEDS_KEY = 'usage is counted per developer key, not per sign-in. make one with atris api-key create, then run ATRIS_API_KEY=<key> atris usage';

async function usageCommand(args = [], deps = {}) {
  if (wantsHelp(args)) {
    showUsageHelp();
    return 0;
  }

  const json = wantsJson(args);
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  const load = deps.loadCredentials || loadCredentials;
  const request = deps.apiRequestJson || apiRequestJson;
  const devKeyEarly = String(((deps.env || process.env).ATRIS_API_KEY) || '').trim();
  const token = tokenFrom(load());
  if (!token && !devKeyEarly) {
    printResult({ json, ok: false, error: NOT_LOGGED_IN, payload: { ok: false, error: NOT_LOGGED_IN } }, io);
    return 1;
  }

  try {
    // The usage endpoint reads only X-API-Key: it reports one developer key's
    // usage. Send a developer key when one is set; a sign-in token is refused.
    const env = deps.env || process.env;
    const devKey = String(env.ATRIS_API_KEY || '').trim();
    const result = devKey
      ? await request('/developer/usage', { method: 'GET', headers: { 'X-API-Key': devKey } })
      : await request('/developer/usage', { method: 'GET', token });
    if (isNotFound(result)) {
      printResult({
        json,
        ok: false,
        error: ROLLOUT_MESSAGE,
        payload: { ok: false, error: ROLLOUT_MESSAGE, status: 404 },
      }, io);
      return 1;
    }
    if (!result || !result.ok) {
      let error = oneLine(result && result.error);
      if (!devKey && [401, 403, 422].includes(result && result.status)) error = `${error}. ${USAGE_NEEDS_KEY}`;
      printResult({ json, ok: false, error, payload: { ok: false, error, status: result && result.status } }, io);
      return 1;
    }
    const data = result.data || {};
    printResult({
      json,
      ok: true,
      text: renderUsage(data),
      payload: { ok: true, ...data },
    }, io);
    return 0;
  } catch (error) {
    const message = oneLine(error && error.message);
    printResult({ json, ok: false, error: message, payload: { ok: false, error: message } }, io);
    return 1;
  }
}

module.exports = { usageCommand, showUsageHelp, renderUsage };
