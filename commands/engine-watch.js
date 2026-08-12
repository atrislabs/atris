'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TAIL_LINES = 20;
const DEFAULT_POLL_MS = 250;
const MAX_TAIL_BYTES = 128 * 1024;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
}

function readReceipt(receiptPath, fsModule = fs) {
  try {
    const receipt = JSON.parse(fsModule.readFileSync(receiptPath, 'utf8'));
    return receipt && typeof receipt === 'object' ? receipt : null;
  } catch {
    return null;
  }
}

function receiptStartedMs(receipt, stat) {
  const parsed = Date.parse(receipt.started_at || receipt.at || '');
  return Number.isFinite(parsed) ? parsed : stat.mtimeMs;
}

function listWatchableReceipts(root, fsModule = fs) {
  const runsDir = path.join(root, 'atris', 'runs');
  let names;
  try {
    names = fsModule.readdirSync(runsDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const receiptPath = path.join(runsDir, name);
    const receipt = readReceipt(receiptPath, fsModule);
    if (!receipt || !receipt.live_log) continue;
    let stat;
    try { stat = fsModule.statSync(receiptPath); } catch { continue; }
    rows.push({
      id: path.basename(name, '.json'),
      receipt,
      receiptPath,
      startedMs: receiptStartedMs(receipt, stat),
    });
  }
  return rows.sort((left, right) => right.startedMs - left.startedMs);
}

function resolveWatchReceipt(root, id, fsModule = fs) {
  const rows = listWatchableReceipts(root, fsModule);
  if (id === 'latest') return rows[0] || null;
  const wanted = String(id || '').replace(/\.json$/, '');
  return rows.find((row) => row.id === wanted || row.receipt.id === id) || null;
}

function liveLogPathForReceipt(root, row) {
  const value = String(row.receipt.live_log || '');
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function receiptDisplayStatus(receipt, pidIsAlive = processIsAlive) {
  const status = String(receipt.status || 'unknown').trim().toLowerCase();
  if (status === 'running' && !pidIsAlive(Number(receipt.pid))) return 'presumed dead';
  return status;
}

function formatAge(value, nowMs = Date.now()) {
  const elapsedMs = Math.max(0, nowMs - Number(value || 0));
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 2) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function lastLogAge(root, row, nowMs, fsModule = fs) {
  try {
    const logPath = liveLogPathForReceipt(root, row);
    const stat = fsModule.statSync(logPath);
    if (stat.size === 0) return 'none';
    return formatAge(stat.mtimeMs, nowMs);
  } catch {
    return 'none';
  }
}

function readLastLines(filePath, count = DEFAULT_TAIL_LINES, fsModule = fs) {
  let descriptor;
  try {
    const stat = fsModule.statSync(filePath);
    if (!stat.size) return [];
    const bytes = Math.min(stat.size, MAX_TAIL_BYTES);
    const start = stat.size - bytes;
    const buffer = Buffer.alloc(bytes);
    descriptor = fsModule.openSync(filePath, 'r');
    fsModule.readSync(descriptor, buffer, 0, bytes, start);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift();
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-count);
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) fsModule.closeSync(descriptor);
  }
}

function writeNewLogBytes(filePath, offset, write, fsModule = fs) {
  let descriptor;
  try {
    const stat = fsModule.statSync(filePath);
    let position = stat.size < offset ? 0 : offset;
    if (stat.size <= position) return position;
    descriptor = fsModule.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    while (position < stat.size) {
      const bytes = fsModule.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytes) break;
      write(buffer.subarray(0, bytes).toString('utf8'));
      position += bytes;
    }
    return position;
  } catch {
    return offset;
  } finally {
    if (descriptor !== undefined) fsModule.closeSync(descriptor);
  }
}

function followReceipt(row, root, deps = {}) {
  const fsModule = deps.fs || fs;
  const pidIsAlive = deps.pidIsAlive || processIsAlive;
  const write = deps.write || process.stdout.write.bind(process.stdout);
  const pollMs = deps.pollMs || DEFAULT_POLL_MS;
  const liveLogPath = liveLogPathForReceipt(root, row);
  let offset = 0;
  try { offset = fsModule.statSync(liveLogPath).size; } catch {}
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      offset = writeNewLogBytes(liveLogPath, offset, write, fsModule);
      const receipt = readReceipt(row.receiptPath, fsModule);
      if (!receipt || receiptDisplayStatus(receipt, pidIsAlive) !== 'running') {
        offset = writeNewLogBytes(liveLogPath, offset, write, fsModule);
        clearInterval(interval);
        resolve(0);
      }
    }, pollMs);
  });
}

function printRunningRoster(root, deps = {}) {
  const fsModule = deps.fs || fs;
  const pidIsAlive = deps.pidIsAlive || processIsAlive;
  const log = deps.log || console.log;
  const nowMs = deps.nowMs === undefined ? Date.now() : deps.nowMs;
  const rows = listWatchableReceipts(root, fsModule)
    .filter((row) => String(row.receipt.status || '').toLowerCase() === 'running');
  if (!rows.length) {
    log('no engine work is running.');
    return 0;
  }
  for (const row of rows) {
    const engine = String(row.receipt.engine || 'unknown');
    const status = receiptDisplayStatus(row.receipt, pidIsAlive);
    const started = row.receipt.started_at || row.receipt.at || 'unknown';
    log(`${row.id}  ${engine}  ${status}  started ${started}  last log ${lastLogAge(root, row, nowMs, fsModule)}`);
  }
  return 0;
}

async function runEngineWatchCommand(args = [], root = process.cwd(), deps = {}) {
  const fsModule = deps.fs || fs;
  const pidIsAlive = deps.pidIsAlive || processIsAlive;
  const log = deps.log || console.log;
  const noFollow = args.includes('--no-follow');
  const id = args.find((arg) => !String(arg).startsWith('--')) || '';
  if (!id) return printRunningRoster(root, deps);

  const row = resolveWatchReceipt(root, id, fsModule);
  if (!row) {
    log(`engine watch: no receipt found for ${id}`);
    return 2;
  }
  const status = receiptDisplayStatus(row.receipt, pidIsAlive);
  const engine = String(row.receipt.engine || 'unknown');
  const started = row.receipt.started_at || row.receipt.at || 'unknown';
  log(`${row.id}  ${engine}  ${status}  started ${started}`);
  const liveLogPath = liveLogPathForReceipt(root, row);
  const lines = readLastLines(liveLogPath, DEFAULT_TAIL_LINES, fsModule);
  if (lines.length) lines.forEach((line) => log(line));
  else log('no live output yet.');

  if (noFollow || status !== 'running') return 0;
  return followReceipt(row, root, deps);
}

module.exports = {
  runEngineWatchCommand,
};
