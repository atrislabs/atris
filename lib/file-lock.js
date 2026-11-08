'use strict';

// One exclusive lock file per resource, shared by the loops that must not run
// twice at once (autoland tick, autopilot, mission, campaign run).
//
// - Create is exclusive (`wx`), so two takers never both win.
// - The file records { pid, host, token, at }. Release removes it only while
//   the token (or the open file) is still ours, so a tick that lost its lock
//   to a stale-steal never deletes the next owner's lock.
// - A stale lock is stolen by renaming it to a unique tombstone first. If the
//   renamed file turns out not to be the one judged stale (someone replaced
//   it in between), it is linked back without clobbering. Two waiters that
//   both judged the same lock stale can no longer delete each other's fresh
//   lock.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

function readRaw(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function parseHolder(raw) {
  if (raw == null) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function sameFile(a, b) {
  return Boolean(a && b) && a.ino === b.ino && a.dev === b.dev;
}

// Remove `file` only if it is still the file described by `judged` (stat) and
// `judgedRaw` (contents). Returns true when the caller should retry create.
function stealStaleLock(file, judged, judgedRaw) {
  const tomb = `${file}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, tomb);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
  let moved = null;
  try { moved = fs.statSync(tomb); } catch {}
  const movedRaw = readRaw(tomb);
  if (!sameFile(moved, judged) || (judgedRaw != null && movedRaw !== judgedRaw)) {
    // We grabbed a lock that was replaced after we judged it. Put it back
    // without overwriting anything created since.
    try { fs.linkSync(tomb, file); } catch {}
  }
  try { fs.unlinkSync(tomb); } catch {}
  return true;
}

// Decide whether a lock someone else holds may be taken over.
function judgeHolder(holder, ageMs, { host, isAlive, staleAfterMs, unreadableGraceMs }) {
  if (!holder) return ageMs > unreadableGraceMs ? 'stale' : 'held';
  const holderPid = Number(holder.pid);
  const atMs = typeof holder.at === 'number' ? holder.at : Date.parse(holder.at || holder.started_at || '');
  const heldFor = Number.isFinite(atMs) ? Date.now() - atMs : ageMs;
  if (Number.isFinite(staleAfterMs) && heldFor > staleAfterMs) return 'stale';
  if (holder.host && holder.host !== host) return 'held';
  if (!Number.isInteger(holderPid) || holderPid <= 0) return ageMs > unreadableGraceMs ? 'stale' : 'held';
  return isAlive(holderPid) ? 'held' : 'stale';
}

// Returns { ok: true, file, token, fd?, release() } or { ok: false, file, holder }.
// Options:
//   meta              extra fields written into the lock record
//   pid, host         identity written into the record (defaults: this process)
//   staleAfterMs      a lock older than this is stale even with a live pid
//   unreadableGraceMs an empty/unreadable lock younger than this is held
//                     (its owner may still be writing the record)
//   keepOpen          return the open fd (release then checks the inode)
//   isAlive           pid liveness probe (tests)
function acquireFileLock(file, options = {}) {
  const {
    meta = {},
    pid = process.pid,
    host = os.hostname(),
    staleAfterMs = Infinity,
    unreadableGraceMs = 5000,
    keepOpen = false,
    isAlive = pidAlive,
    attempts = 5,
  } = options;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const record = JSON.stringify({ ...meta, pid, host, token, at: new Date().toISOString() });
  let lastHolder = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    if (fd !== undefined) {
      try {
        fs.writeSync(fd, record);
      } catch (error) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(file); } catch {}
        throw error;
      }
      let ino = null;
      try { ino = fs.fstatSync(fd); } catch {}
      if (!keepOpen) {
        try { fs.closeSync(fd); } catch {}
        fd = undefined;
      }
      const lock = { ok: true, file, token, fd, stat: ino, record };
      lock.release = () => releaseFileLock(lock);
      return lock;
    }
    let judged;
    try {
      judged = fs.statSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    const raw = readRaw(file);
    const holder = parseHolder(raw);
    lastHolder = holder;
    const verdict = judgeHolder(holder, Date.now() - judged.mtimeMs, { host, isAlive, staleAfterMs, unreadableGraceMs });
    if (verdict === 'held') return { ok: false, file, holder };
    stealStaleLock(file, judged, raw);
  }
  return { ok: false, file, holder: lastHolder || parseHolder(readRaw(file)) };
}

// Remove the lock only while it is still ours.
function releaseFileLock(lock) {
  if (!lock || !lock.ok || lock.released) return false;
  lock.released = true;
  let ours = false;
  if (lock.fd != null) {
    try {
      ours = sameFile(fs.fstatSync(lock.fd), fs.statSync(lock.file));
    } catch {
      ours = false;
    }
    try { fs.closeSync(lock.fd); } catch {}
  } else {
    const holder = parseHolder(readRaw(lock.file));
    ours = Boolean(holder) && holder.token === lock.token;
  }
  if (!ours) return false;
  try { fs.unlinkSync(lock.file); } catch { return false; }
  return true;
}

module.exports = {
  acquireFileLock,
  releaseFileLock,
  stealStaleLock,
  pidAlive,
};
