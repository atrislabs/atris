'use strict';

const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const {
  NOT_LOGGED_IN,
  wantsHelp,
  wantsJson,
  tokenFrom,
  oneLine,
  printResult,
  formatDollars,
  normalizeBalance,
} = require('../lib/developer-api');

function showBalanceHelp() {
  console.log('usage: atris balance [--json]');
  console.log('show your credit balance in dollars, with credits on the next line.');
}

async function balanceCommand(args = [], deps = {}) {
  if (wantsHelp(args)) {
    showBalanceHelp();
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
    const result = await request('/credits/balance', { method: 'GET', token });
    if (!result || !result.ok) {
      const error = oneLine(result && result.error);
      printResult({ json, ok: false, error, payload: { ok: false, error, status: result && result.status } }, io);
      return 1;
    }
    const balance = normalizeBalance(result.data || {});
    const text = `${formatDollars(balance.dollars)}\n${balance.credits} credits`;
    printResult({ json, ok: true, text, payload: { ok: true, ...balance } }, io);
    return 0;
  } catch (error) {
    const message = oneLine(error && error.message);
    printResult({ json, ok: false, error: message, payload: { ok: false, error: message } }, io);
    return 1;
  }
}

module.exports = { balanceCommand, showBalanceHelp };
