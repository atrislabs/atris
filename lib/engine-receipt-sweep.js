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

module.exports = {
  sweepEngineAskReceipts,
};
