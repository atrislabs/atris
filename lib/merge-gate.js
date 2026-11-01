'use strict';

const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_CHARS = 64 * 1024;

// A separate runner lets the synchronous ship command stop the entire gate
// process group on timeout, including a shell's children.
function runGateChild(script, timeout) {
  let output = '';
  let timedOut = false;
  let settled = false;
  const firstLine = fs.readFileSync(script, 'utf8').split(/\r?\n/, 1)[0];
  const interpreter = firstLine.startsWith('#!') ? firstLine.slice(2).trim().split(/\s+/) : ['sh'];
  const child = spawn(interpreter[0], [...interpreter.slice(1), script], {
    cwd: process.cwd(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => { output = (output + chunk.toString()).slice(-MAX_OUTPUT_CHARS); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const finish = (code, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({ code, timedOut, output, error: error || '' }));
  };
  child.on('error', (error) => finish(null, error.message));
  child.on('close', (code, signal) => {
    const signalCode = signal && os.constants.signals[signal];
    finish(code === null && signalCode && !timedOut ? 128 + signalCode : code,
      signal && !timedOut ? `signal ${signal.toLowerCase()}` : '');
  });
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }, timeout);
}

function runMergeGate(root, script) {
  const raw = process.env.ATRIS_MERGE_GATE_TIMEOUT_MS;
  const timeout = raw === undefined ? DEFAULT_TIMEOUT_MS : Number(raw);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) {
    return { code: null, error: 'invalid atris_merge_gate_timeout_ms', output: '' };
  }
  const result = spawnSync(process.execPath, [__filename, script, String(timeout)], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_OUTPUT_CHARS * 8,
  });
  if (result.status !== 0) return { code: null, error: result.error?.message || result.stderr || 'could not run gate', output: '' };
  try { return JSON.parse(result.stdout); } catch { return { code: null, error: 'could not read gate result', output: '' }; }
}

if (require.main === module) runGateChild(process.argv[2], Number(process.argv[3]));

module.exports = { runMergeGate };
