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

const { DEFAULT_MAX } = require('./member-up');

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
function wakeHandoffReceiver(handoff, deps) {
  const to = String(handoff && handoff.to || '').trim();
  const step = String(handoff && handoff.summary || '').trim();
  const team = deps.listMembers() || [];
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
  wakeHandoffReceiver,
};
