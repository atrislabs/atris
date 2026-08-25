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
  console.log('show developer api usage for the logged-in account.');
}

function renderUsage(data = {}) {
  const raw = data && typeof data === 'object' ? data : {};
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : raw;
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

async function usageCommand(args = [], deps = {}) {
  if (wantsHelp(args)) {
    showUsageHelp();
    return 0;
  }

  const json = wantsJson(args);
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  const load = deps.loadCredentials || loadCredentials;
  const request = deps.apiRequestJson || apiRequestJson;
  const token = tokenFrom(load());
  if (!token) {
    printResult({ json, ok: false, error: NOT_LOGGED_IN, payload: { ok: false, error: NOT_LOGGED_IN } }, io);
    return 1;
  }

  try {
    const result = await request('/developer/usage', { method: 'GET', token });
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
      const error = oneLine(result && result.error);
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
