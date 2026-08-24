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
  rejectUnsupportedJson,
};
