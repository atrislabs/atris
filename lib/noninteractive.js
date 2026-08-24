'use strict';

/**
 * Shared headless/agent guard. When true, commands must not open a prompt.
 * Covers: ATRIS_NONINTERACTIVE / ATRIS_NO_INTERACTIVE, --yes/-y, --json.
 * Non-TTY stdin alone is usually non-interactive, but callers that accept
 * piped batch input (like `atris log`) should use isForcedNonInteractive
 * and handle empty vs piped stdin themselves.
 */
function isForcedNonInteractive(args = process.argv.slice(2)) {
  const list = Array.isArray(args) ? args : [];
  if (process.env.ATRIS_NONINTERACTIVE === '1') return true;
  if (process.env.ATRIS_NO_INTERACTIVE === '1') return true;
  if (list.includes('--yes') || list.includes('-y')) return true;
  if (list.includes('--json')) return true;
  return false;
}

function isNonInteractive(args = process.argv.slice(2)) {
  if (isForcedNonInteractive(args)) return true;
  if (!process.stdin.isTTY) return true;
  return false;
}

function wantsJson(args = process.argv.slice(2)) {
  return Array.isArray(args) && args.includes('--json');
}

function isHelpToken(arg) {
  return arg === '--help' || arg === '-h' || arg === 'help' || arg === '-?';
}

function argsWantHelp(args = []) {
  const list = Array.isArray(args) ? args : [];
  return list.some(isHelpToken);
}

function hasYesFlag(args = []) {
  const list = Array.isArray(args) ? args : [];
  return list.includes('--yes') || list.includes('-y');
}

/**
 * Headless / agent sessions must not hang on interactive runners.
 * Non-TTY, ATRIS_NONINTERACTIVE=1, and ATRIS_NO_INTERACTIVE=1 all refuse
 * unless the caller passed an explicit proceed flag (--yes, or --once for serve).
 */
function refuseHeadlessUnless(args, { allowYes = true, allowOnce = false, usage = '' } = {}) {
  const list = Array.isArray(args) ? args : [];
  const headless = Boolean(
    process.env.ATRIS_NONINTERACTIVE === '1'
    || process.env.ATRIS_NO_INTERACTIVE === '1'
    || !process.stdin.isTTY
    || !process.stdout.isTTY
  );
  if (!headless) return false;
  if (allowYes && hasYesFlag(list)) return false;
  if (allowOnce && list.includes('--once')) return false;
  const lines = [];
  if (usage) lines.push(usage);
  else lines.push('This command needs a terminal, or an explicit proceed flag.');
  lines.push('Pass --yes to run headless' + (allowOnce ? ', or --once for a single serve op.' : '.'));
  console.error(lines.join('\n'));
  return true;
}

function rejectUnsupportedJson(commandName, args = process.argv.slice(2)) {
  if (!wantsJson(args)) return false;
  console.log(JSON.stringify({
    ok: false,
    error: `${commandName} does not support --json`,
    command: commandName,
    usage: `atris ${commandName}`,
  }, null, 2));
  process.exit(2);
  return true;
}

module.exports = {
  isForcedNonInteractive,
  isNonInteractive,
  wantsJson,
  isHelpToken,
  argsWantHelp,
  hasYesFlag,
  refuseHeadlessUnless,
  rejectUnsupportedJson,
};
