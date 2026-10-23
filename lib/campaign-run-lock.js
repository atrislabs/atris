'use strict';

// One driver per campaign on a computer. Two `campaign run` loops on the same
// campaign each planned and started missions, so they raced for the same
// budget and edited the same files (2026-10-15, cmp-suite-3min). The lock is
// a file beside the store naming the process that holds it; a lock whose
// process is gone is stale and is taken over.

const fs = require('fs');
const os = require('os');
const path = require('path');

function lockPath(home, campaignId) {
  return path.join(home, 'campaigns', campaignId, 'run.lock');
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Returns { ok: true, release } or { ok: false, holder } when a live run holds it.
function acquireRunLock(home, campaignId, { pid = process.pid, host = os.hostname(), cwd = process.cwd(), isAlive = alive } = {}) {
  const file = lockPath(home, campaignId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { pid, host, cwd, started_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(mine)}\n`, { flag: 'wx' });
      const release = () => {
        const holder = readHolder(file);
        if (holder && holder.pid === pid && holder.host === host) fs.rmSync(file, { force: true });
      };
      return { ok: true, release };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readHolder(file);
    if (holder && holder.host === host && isAlive(holder.pid)) return { ok: false, holder };
    if (holder && holder.host !== host) return { ok: false, holder };
    fs.rmSync(file, { force: true });
  }
  return { ok: false, holder: readHolder(file) };
}

// Who drives this campaign right now, or null. Same rules as acquireRunLock, nothing written.
function liveHolder(home, campaignId, { host = os.hostname(), isAlive = alive } = {}) {
  const holder = readHolder(lockPath(home, campaignId));
  if (!holder) return null;
  if (holder.host !== host) return holder;
  return isAlive(holder.pid) ? holder : null;
}

module.exports = { acquireRunLock, liveHolder, lockPath };
