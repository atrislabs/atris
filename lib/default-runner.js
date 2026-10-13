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

// Codex exports CODEX_THREAD_ID (and CODEX_SESSION_ID on some builds) into
// every shell command its agent runs, so a CLI started by a codex session can
// see it. ATRIS_CALLER_RUNTIME names the caller outright and wins over the
// sniffing: codex, agent (claude code, cursor, devin), or terminal.
const CODEX_SESSION_ENV = Object.freeze(['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
const AGENT_SESSION_ENV = Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CURSOR_AGENT', 'DEVIN_SESSION_ID']);

function envSet(env, name) {
  return String((env && env[name]) || '').trim() !== '';
}

function declaredCallerRuntime(env = process.env) {
  const named = String((env && env.ATRIS_CALLER_RUNTIME) || '').trim().toLowerCase();
  return ['codex', 'agent', 'terminal'].includes(named) ? named : '';
}

function codexSessionFromEnv(env = process.env) {
  const named = declaredCallerRuntime(env);
  if (named) return named === 'codex';
  return CODEX_SESSION_ENV.some((name) => envSet(env, name));
}

// A live codex session drives a run by passing its native goal slot state
// (--native-goal-* / --visible-goal-*), by explicitly claiming the slot
// (--take-goal-slot), or by being the process around this CLI (its session
// env). Absent those, nothing is on the other end.
function runHasLiveCodexSession(args, env = process.env) {
  return Boolean(
    flagValue(args, '--native-goal-status')
    || flagValue(args, '--visible-goal-status')
    || flagValue(args, '--native-goal-objective')
    || flagValue(args, '--visible-goal-objective')
    || hasFlag(args, '--take-goal-slot')
    || codexSessionFromEnv(env),
  );
}

// Who started this CLI: 'codex' (a codex session that can start a native
// goal), 'agent' (another agent session that does the work itself), or
// 'terminal' (a plain shell, cron, or launchd, where nothing else will do the
// work unless Atris starts an engine).
function callerRuntime(args = [], env = process.env) {
  if (runHasLiveCodexSession(args, env)) return 'codex';
  const named = declaredCallerRuntime(env);
  if (named) return named;
  return AGENT_SESSION_ENV.some((name) => envSet(env, name)) ? 'agent' : 'terminal';
}

// Default runner for the run-objective path (`atris mission run "<objective>"`,
// `member run`). codex_goal hands the mission to a live codex session's native
// goal slot; with no such session (cron, fleet, a plain shell) it stalls forever
// waiting for a native goal start that never comes (proven footgun 2026-07-16).
// So codex_goal only when a live codex session is driving; otherwise claude,
// which drives itself headless. An explicit --runner always wins over this.
function defaultObjectiveRunner(args, env = process.env) {
  return runHasLiveCodexSession(args, env) ? 'codex_goal' : 'claude';
}

module.exports = { callerRuntime, runHasLiveCodexSession, defaultObjectiveRunner };
