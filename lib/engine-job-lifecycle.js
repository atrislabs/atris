'use strict';

function engineTerminalExitCode(result = {}) {
  for (const key of ['exit_code', 'exitCode', 'status']) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    return Number.isInteger(result[key]) ? result[key] : null;
  }
  return null;
}

function engineTerminalOutput(result = {}) {
  return [result.report, result.stdout, result.stderr]
    .map((value) => String(value || ''))
    .join('\n')
    .trim();
}

function engineTerminalReason(result = {}) {
  if (result.cancelled || result.reason === 'cancelled') return 'cancelled';
  if (result.timed_out || result.reason === 'timeout') return 'timeout';
  if (result.ok === false) return String(result.reason || 'failed');
  const exitCode = engineTerminalExitCode(result);
  if (exitCode == null) return 'unknown';
  if (exitCode !== 0) return `exit_${exitCode}`;
  if (!engineTerminalOutput(result)) return 'no_output';
  return 'ok';
}

function engineTerminalStatus(result = {}) {
  const reason = engineTerminalReason(result);
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'timeout') return 'timed out';
  if (reason === 'ok') return 'answered';
  return 'failed';
}

module.exports = {
  engineTerminalReason,
  engineTerminalStatus,
};
