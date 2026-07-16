'use strict';

// Self-contained flag reads so this helper can be shared by commands/mission.js
// and commands/member.js, which each define their own readFlag/hasFlag. Handles
// both `--flag value` and `--flag=value`.
function flagValue(args, name) {
  const list = Array.isArray(args) ? args : [];
  const eq = `${name}=`;
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i]);
    if (token === name) return i + 1 < list.length ? String(list[i + 1]) : '';
    if (token.startsWith(eq)) return token.slice(eq.length);
  }
  return '';
}

function hasFlag(args, name) {
  const list = Array.isArray(args) ? args : [];
  return list.some((token) => String(token) === name || String(token).startsWith(`${name}=`));
}

// A live codex session drives a run by passing its native goal slot state
// (--native-goal-* / --visible-goal-*) or by explicitly claiming the slot
// (--take-goal-slot). Absent those, nothing is on the other end.
function runHasLiveCodexSession(args) {
  return Boolean(
    flagValue(args, '--native-goal-status')
    || flagValue(args, '--visible-goal-status')
    || flagValue(args, '--native-goal-objective')
    || flagValue(args, '--visible-goal-objective')
    || hasFlag(args, '--take-goal-slot'),
  );
}

// Default runner for the run-objective path (`atris mission run "<objective>"`,
// `member run`). codex_goal hands the mission to a live codex session's native
// goal slot; with no such session (cron, fleet, a plain shell) it stalls forever
// waiting for a native goal start that never comes (proven footgun 2026-07-16).
// So codex_goal only when a live codex session is driving; otherwise claude,
// which drives itself headless. An explicit --runner always wins over this.
function defaultObjectiveRunner(args) {
  return runHasLiveCodexSession(args) ? 'codex_goal' : 'claude';
}

module.exports = { runHasLiveCodexSession, defaultObjectiveRunner };
