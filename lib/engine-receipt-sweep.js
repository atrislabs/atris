'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ENGINE_ASK_RECEIPT_SCHEMA = 'atris.engine_ask_receipt.v1';
const DEFAULT_GRACE_MS = 10 * 60 * 1000;
const SWEEP_NOTE = 'stale receipt sweep marked this engine ask presumed dead.';

function receiptStartedMs(receipt, stat) {
  const parsed = Date.parse(receipt.started_at || receipt.at || '');
  return Number.isFinite(parsed) ? parsed : stat.mtimeMs;
}

function processIsAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== 'ESRCH';
  }
}

function atomicWriteReceipt(receiptPath, receipt, fsModule = fs) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(
    path.dirname(receiptPath),
    `.${path.basename(receiptPath)}.${process.pid}.${suffix}.tmp`,
  );
  try {
    fsModule.writeFileSync(tmpPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsModule.renameSync(tmpPath, receiptPath);
  } finally {
    try { fsModule.unlinkSync(tmpPath); } catch {}
  }
}

function sweepEngineAskReceipts(root, deps = {}) {
  const fsModule = deps.fs || fs;
  const kill = deps.kill || process.kill;
  const now = deps.now ? deps.now() : new Date();
  const nowMs = now.getTime();
  const graceMs = deps.graceMs === undefined ? DEFAULT_GRACE_MS : Number(deps.graceMs);
  const summary = {
    scanned: 0,
    finalized: 0,
    skipped_alive: 0,
    skipped_young: 0,
  };
  const runsDir = path.join(root, 'atris', 'runs');
  let names;
  try {
    names = fsModule.readdirSync(runsDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return summary;
  }

  for (const name of names) {
    const receiptPath = path.join(runsDir, name);
    let receipt;
    let stat;
    try {
      receipt = JSON.parse(fsModule.readFileSync(receiptPath, 'utf8'));
      stat = fsModule.statSync(receiptPath);
    } catch {
      continue;
    }
    if (!receipt || receipt.schema !== ENGINE_ASK_RECEIPT_SCHEMA || receipt.status !== 'running') continue;

    summary.scanned += 1;
    if (nowMs - receiptStartedMs(receipt, stat) < graceMs) {
      summary.skipped_young += 1;
      continue;
    }
    if (processIsAlive(Number(receipt.pid), kill)) {
      summary.skipped_alive += 1;
      continue;
    }

    atomicWriteReceipt(receiptPath, {
      ...receipt,
      status: 'presumed_dead',
      swept_at: now.toISOString(),
      note: SWEEP_NOTE,
    }, fsModule);
    summary.finalized += 1;
  }

  return summary;
}

// Fleet and dispatch flights write a running receipt with the driver's pid
// and rewrite it when they finish. A crashed flight never rewrites it, so the
// receipt read as running forever. Flights run long, so the age bar is an hour
// and a live pid always keeps the receipt as it is.
const DISPATCH_RECEIPT_SCHEMA = 'atris.dispatch_receipt.v1';
const FLEET_GRACE_MS = 60 * 60 * 1000;
const FLEET_SWEEP_NOTE = 'stale receipt sweep marked this flight presumed dead: its process is gone and it never finished.';

function isFleetReceipt(name, receipt) {
  if (receipt.schema === DISPATCH_RECEIPT_SCHEMA) return name.startsWith('dispatch-');
  return !receipt.schema && name.startsWith('fleet-') && Array.isArray(receipt.results);
}

function sweepFleetReceipts(root, deps = {}) {
  const fsModule = deps.fs || fs;
  const kill = deps.kill || process.kill;
  const now = deps.now ? deps.now() : new Date();
  const nowMs = now.getTime();
  const graceMs = deps.graceMs === undefined ? FLEET_GRACE_MS : Number(deps.graceMs);
  const summary = { scanned: 0, finalized: 0, skipped_alive: 0, skipped_young: 0 };
  const runsDir = path.join(root, 'atris', 'runs');
  let names;
  try {
    names = fsModule.readdirSync(runsDir)
      .filter((name) => name.endsWith('.json') && (name.startsWith('fleet-') || name.startsWith('dispatch-')))
      .sort();
  } catch {
    return summary;
  }
  for (const name of names) {
    const receiptPath = path.join(runsDir, name);
    let receipt;
    let stat;
    try {
      receipt = JSON.parse(fsModule.readFileSync(receiptPath, 'utf8'));
      stat = fsModule.statSync(receiptPath);
    } catch {
      continue;
    }
    if (!receipt || typeof receipt !== 'object' || receipt.status !== 'running' || !isFleetReceipt(name, receipt)) continue;
    summary.scanned += 1;
    // Age from the last write, not the start: a long flight rewrites its
    // receipt as tasks land.
    const lastWriteMs = Math.max(receiptStartedMs(receipt, stat), stat.mtimeMs);
    if (nowMs - lastWriteMs < graceMs) {
      summary.skipped_young += 1;
      continue;
    }
    if (processIsAlive(Number(receipt.pid), kill)) {
      summary.skipped_alive += 1;
      continue;
    }
    atomicWriteReceipt(receiptPath, {
      ...receipt,
      status: 'presumed_dead',
      swept_at: now.toISOString(),
      note: FLEET_SWEEP_NOTE,
    }, fsModule);
    summary.finalized += 1;
  }
  return summary;
}

module.exports = {
  sweepEngineAskReceipts,
  sweepFleetReceipts,
};
