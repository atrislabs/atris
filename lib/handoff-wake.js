'use strict';

// A handoff wakes the member it hands to.
//
// `atris member handoff <from> <to> "<step>"` used to only write the baton
// down, so the phone said "validator has it" while no validator run existed
// (live 2026-10-22, mission #266). Now the receiver is started on the
// handed-off step through the member runtime (member run, detached), the same
// bounded work step `atris member wake <name>` runs, and only when the team
// rules allow it: not asleep, not a person, under the limit of members
// working at once (the `atris member up` limit), with an engine named in the
// roster. When it cannot start, the outcome says why in plain words and is
// written onto the handoff, so nothing claims the member has the work.
//
// The team, the engine lookup and the start are passed in, so tests drive the
// decision without starting anything.

const fs = require('fs');
const path = require('path');
const { DEFAULT_MAX } = require('./member-up');

// Two handoffs at the same moment once both counted 5 working and both
// started one, past the limit of 6. Count-and-start now holds one lock file
// in the state folder, and each start is written to a short list of recent
// wakes, so the next handoff counts it even before its mission says running.
const LOCK_FILE = 'handoff-wake.lock';
const RECENT_FILE = 'handoff-wakes.json';
// A holder that died, or one stuck past this long, no longer holds.
const STALE_LOCK_MS = 5 * 60 * 1000;
const WAIT_LOCK_MS = 3 * 60 * 1000;
const RECENT_MS = 30 * 60 * 1000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function takeLock(file, { staleMs, waitMs, now }) {
  const until = now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
      return fd;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try {
      const stat = fs.statSync(file);
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const dead = owner && Number.isInteger(owner.pid) && !pidAlive(owner.pid);
      const old = now() - stat.mtimeMs > staleMs;
      if ((dead || old) && fs.statSync(file).ino === stat.ino) {
        fs.unlinkSync(file);
        continue;
      }
    } catch {
      continue;
    }
    if (now() >= until) return null;
    sleepSync(100);
  }
}

// Runs fn({ recent, record }) while holding the wake lock. recent: wakes from
// the last half hour whose run is still alive; record(entry) adds one.
// Returns { busy: true } when the lock stayed held past waitMs.
function withWakeReservation(stateDir, fn, { staleMs = STALE_LOCK_MS, waitMs = WAIT_LOCK_MS, now = Date.now } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, LOCK_FILE);
  const recentFile = path.join(stateDir, RECENT_FILE);
  const fd = takeLock(lockFile, { staleMs, waitMs, now });
  if (fd === null) return { busy: true };
  try {
    let recent = [];
    try { recent = JSON.parse(fs.readFileSync(recentFile, 'utf8')).wakes || []; } catch {}
    recent = recent.filter((w) => w && w.member && now() - Number(w.at || 0) < RECENT_MS && pidAlive(w.pid));
    const out = fn({ recent, record: (entry) => recent.push({ ...entry, at: now() }) });
    const tmp = `${recentFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ wakes: recent }));
    fs.renameSync(tmp, recentFile);
    return out;
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

function notStarted(to, reason, why) {
  return {
    status: 'not_started',
    reason,
    text: `${to} did not start: ${why}. nobody is working on this step yet. to start it: atris member wake ${to}`,
  };
}

// deps: { listMembers() -> [{ name, live, sleeping, parked, human }],
//         awake(name), engine(name), start(name, step) -> { ok, mission_id, pid, worktree, error },
//         max }
// deps.reserve(fn), when given, holds the shared wake lock around the
// count-and-start (withWakeReservation); without it the decision runs bare.
function wakeHandoffReceiver(handoff, deps) {
  const to = String(handoff && handoff.to || '').trim();
  if (typeof deps.reserve !== 'function') return decideAndStart(handoff, deps, { recent: [], record: () => {} });
  const out = deps.reserve((reservation) => decideAndStart(handoff, deps, reservation));
  if (out && out.busy) return notStarted(to, 'busy', 'another handoff held the start lock for minutes, so this one gave up');
  return out;
}

function decideAndStart(handoff, deps, { recent, record }) {
  const to = String(handoff && handoff.to || '').trim();
  const step = String(handoff && handoff.summary || '').trim();
  const recentNames = new Set(recent.map((w) => w.member));
  const team = (deps.listMembers() || []).map((member) => (member && recentNames.has(member.name) ? { ...member, live: true } : member));
  const seat = team.find((member) => member && member.name === to);
  if (!seat) return notStarted(to, 'not_on_team', `${to} is not on the team`);
  if (seat.human) return notStarted(to, 'person', `${to} is a person, so no engine starts for them`);
  if (seat.live) {
    return {
      status: 'already_working',
      reason: 'already_working',
      text: `${to} is already working; the step is queued as its next push`,
    };
  }
  if (seat.sleeping || deps.awake(to) === false) return notStarted(to, 'asleep', `${to} is asleep`);
  if (seat.parked) return notStarted(to, 'parked', `${to} is parked`);
  const max = Math.max(1, Number(deps.max) || DEFAULT_MAX);
  const working = team.filter((member) => member && member.live).length;
  if (working >= max) {
    return notStarted(to, 'at_limit', `${working} members are already working and the limit is ${max}`);
  }
  const engine = deps.engine(to);
  if (!engine) return notStarted(to, 'no_engine', `the roster names no engine for ${to}`);
  let run;
  try {
    run = deps.start(to, step) || {};
  } catch (error) {
    run = { ok: false, error: error && error.message };
  }
  if (!run.ok || !run.mission_id) {
    const why = String(run.error || 'the run did not start').split('\n')[0].trim().slice(0, 200);
    return notStarted(to, 'start_failed', why);
  }
  record({ member: to, mission_id: run.mission_id, pid: run.pid || null });
  return {
    status: 'started',
    reason: 'started',
    mission_id: run.mission_id,
    pid: run.pid || null,
    worktree: run.worktree || null,
    engine: (engine.engine && engine.engine.id) || engine.id || null,
    text: `${to} is working on it now (mission ${run.mission_id})`,
  };
}

module.exports = {
  notStarted,
  wakeHandoffReceiver,
  withWakeReservation,
};
