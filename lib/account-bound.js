'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNT_GLOBAL_MESSAGE = 'account-global; pass --account to continue';

function isBoundBusinessWorkspace(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  return fs.existsSync(path.join(root, '.atris', 'business.json'))
    && fs.existsSync(path.join(root, 'atris'));
}

function isHelpArg(arg) {
  return arg === '--help' || arg === '-h' || arg === 'help';
}

/**
 * Account-scoped verbs dump live CRM/cloud state. Outside a bound business
 * workspace they must opt in with --account. Help always passes.
 * Returns { ok, args } where args has --account stripped when continuing.
 */
function requireAccountBound(args = [], options = {}) {
  const list = Array.isArray(args) ? [...args] : [];
  const cwd = options.cwd || process.cwd();
  if (list.some(isHelpArg)) {
    return { ok: true, args: list, help: true };
  }
  if (isBoundBusinessWorkspace(cwd)) {
    return { ok: true, args: list.filter((arg) => arg !== '--account'), bound: true };
  }
  if (list.includes('--account')) {
    return { ok: true, args: list.filter((arg) => arg !== '--account'), account: true };
  }
  return { ok: false, args: list, message: ACCOUNT_GLOBAL_MESSAGE };
}

function refuseAccountGlobal(write = console.error) {
  write(ACCOUNT_GLOBAL_MESSAGE);
  return 2;
}

module.exports = {
  ACCOUNT_GLOBAL_MESSAGE,
  isBoundBusinessWorkspace,
  requireAccountBound,
  refuseAccountGlobal,
};
