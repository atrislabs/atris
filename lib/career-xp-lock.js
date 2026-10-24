'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleepSync } = require('./sleep-sync');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Callers resolve the shared root before entering. Do not acquire recursively.
function withCareerXpLock(workspace, action, { timeoutMs = 10000 } = {}) {
  const file = path.join(workspace, '.atris', 'state', 'career_xp.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const holder = JSON.stringify({ pid: process.pid, host: os.hostname() });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (fd !== undefined) {
      try {
        fs.writeFileSync(fd, holder);
        return action();
      } finally {
        fs.closeSync(fd);
        fs.unlinkSync(file);
      }
    }
    try {
      const before = fs.statSync(file);
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      // A newly created file may still be receiving its owner record.
      const stale = owner ? owner.host === os.hostname() && !alive(owner.pid)
        : Date.now() - before.mtimeMs > 30000;
      if (stale) {
        const after = fs.statSync(file);
        if (before.ino === after.ino && before.mtimeMs === after.mtimeMs) fs.unlinkSync(file);
        continue;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue;
    }
    if (Date.now() >= deadline) throw new Error('xp ledger is busy; retry');
    sleepSync(20);
  }
}

module.exports = { withCareerXpLock };
