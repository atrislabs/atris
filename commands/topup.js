'use strict';

const { apiRequestJson } = require('../utils/api');
const { loadCredentials, openBrowser } = require('../utils/auth');
const {
  NOT_LOGGED_IN,
  wantsHelp,
  wantsJson,
  tokenFrom,
  oneLine,
  printResult,
  formatDollars,
  checkoutUrl,
  parseAmountUsd,
} = require('../lib/developer-api');

function showTopupHelp() {
  console.log('usage: atris topup [amount_usd] [--json]');
  console.log('create a stripe checkout for credits and print the url. default amount is 10.');
}

async function topupCommand(args = [], deps = {}) {
  if (wantsHelp(args)) {
    showTopupHelp();
    return 0;
  }

  const json = wantsJson(args);
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  const parsed = parseAmountUsd(args, 10);
  if (!parsed.ok) {
    printResult({ json, ok: false, error: parsed.error, payload: { ok: false, error: parsed.error } }, io);
    return 1;
  }

  const load = deps.loadCredentials || loadCredentials;
  const request = deps.apiRequestJson || apiRequestJson;
  const open = deps.openBrowser || openBrowser;
  const token = tokenFrom(load());
  if (!token) {
    printResult({ json, ok: false, error: NOT_LOGGED_IN, payload: { ok: false, error: NOT_LOGGED_IN } }, io);
    return 1;
  }

  try {
    const result = await request('/credits/purchase', {
      method: 'POST',
      token,
      body: { amount_usd: parsed.amount },
    });
    if (!result || !result.ok) {
      const error = oneLine(result && result.error);
      printResult({ json, ok: false, error, payload: { ok: false, error, status: result && result.status } }, io);
      return 1;
    }
    const data = result.data || {};
    const url = checkoutUrl(data);
    if (!url) {
      const error = 'checkout url was missing from the response';
      printResult({ json, ok: false, error, payload: { ok: false, error } }, io);
      return 1;
    }
    const credits = data.credits_to_add != null ? data.credits_to_add : parsed.amount * 100;
    const text = `open this checkout to add ${formatDollars(parsed.amount)} (${credits} credits):\n${url}`;
    printResult({
      json,
      ok: true,
      text,
      payload: {
        ok: true,
        amount_usd: parsed.amount,
        credits_to_add: credits,
        checkout_url: url,
      },
    }, io);
    if (!json) {
      const tty = deps.isTty != null ? deps.isTty : Boolean(process.stdout && process.stdout.isTTY);
      if (tty) open(url);
    }
    return 0;
  } catch (error) {
    const message = oneLine(error && error.message);
    printResult({ json, ok: false, error: message, payload: { ok: false, error: message } }, io);
    return 1;
  }
}

module.exports = { topupCommand, showTopupHelp };
