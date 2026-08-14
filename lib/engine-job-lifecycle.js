'use strict';

// Shared once-only terminal gate for local engine jobs.
// This is not a job store: callers keep using existing ask/dispatch receipts.
// Each engine process reports answered, failed, timed out, or cancelled
// exactly once, at the moment that process ends.

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
  const exit = engineTerminalExitCode(result);
  if (exit == null) return 'unknown';
  if (exit !== 0) return `exit_${exit}`;
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

function createEngineTerminalEmitter(onTerminal) {
  const seen = new Set();
  return function emitEngineTerminal(jobKey, payload) {
    const key = String(jobKey || '');
    if (!key || seen.has(key)) return null;
    seen.add(key);
    const event = {
      ...payload,
      status: payload.status || engineTerminalStatus(payload),
      job_key: key,
    };
    if (typeof onTerminal === 'function') onTerminal(event);
    return event;
  };
}

module.exports = {
  engineTerminalReason,
  engineTerminalStatus,
  createEngineTerminalEmitter,
};
