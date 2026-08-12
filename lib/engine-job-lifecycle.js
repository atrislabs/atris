'use strict';

const fs = require('node:fs');
const path = require('node:path');

function engineLiveLogPath(receiptPath) {
  const extension = path.extname(receiptPath);
  const stem = extension ? receiptPath.slice(0, -extension.length) : receiptPath;
  return `${stem}.live.log`;
}

function createEngineLiveLog(receiptPath, fsModule = fs) {
  const liveLogPath = engineLiveLogPath(receiptPath);
  fsModule.mkdirSync(path.dirname(liveLogPath), { recursive: true });
  const descriptor = fsModule.openSync(liveLogPath, 'a');
  fsModule.closeSync(descriptor);
  return liveLogPath;
}

function appendEngineLiveLogChunk(liveLogPath, chunk, fsModule = fs) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (!value.length) return;
  fsModule.appendFileSync(liveLogPath, value, { flag: 'a' });
}

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
  appendEngineLiveLogChunk,
  createEngineLiveLog,
  engineTerminalReason,
  engineTerminalStatus,
};
