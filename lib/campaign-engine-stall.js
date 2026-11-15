// When the owner's engine gives a campaign nothing (no judge draft, no
// missions), say which engine was asked and why it likely failed, then one
// next step. Used by campaign new (lib/campaign-new.js) and propose and step
// (lib/campaign-loop.js). It never invents work; it only ends the stall in
// something a person can do.

'use strict';

const NOT_INSTALLED = /not installed|command not found|\benoent\b/i;
const SIGNED_OUT = /not (?:logged|signed) in|please log ?in|log ?in required|login required|not authenticated|unauthori[sz]ed|auth(?:entication)? (?:expired|required)|\b401\b/i;
const USAGE_LIMIT = /usage[ _-]?limit|rate[ _-]?limit|insufficient credits|purchase more credits|quota|payment required/i;

// The ask runner's answer, cut to what the stall line needs. A clean answer
// stays { text, engine, ok }; the runner's reason, exit and stderr ride along
// only when it failed and said something.
function askSummary(answer, engine, extra = {}) {
  const a = answer || {};
  const summary = { text: a.stdout || '', engine, ok: Boolean(a.ok) };
  if (!summary.ok) {
    if (a.reason) summary.reason = a.reason;
    if (Number.isInteger(a.exit_code)) summary.exit_code = a.exit_code;
    if (a.stderr) summary.stderr = String(a.stderr).slice(-2000);
    if (a.timed_out) summary.timed_out = true;
  }
  for (const [key, value] of Object.entries(extra)) if (value) summary[key] = value;
  return summary;
}

// What went wrong, from what the runner saw. Fakes and older callers pass
// only { text, engine }; those read as "ran but sent back nothing".
function stallCause(answer = {}) {
  const engine = answer.engine || 'unknown';
  const said = `${answer.reason || ''}\n${answer.stderr || ''}`;
  const text = String(answer.text || '').trim();
  if (answer.reason === 'spawn_error' || (!answer.ok && NOT_INSTALLED.test(said))) {
    // With no ready engine the ask falls back to one; say so when that one is missing too.
    return { kind: answer.no_engine ? 'no_engine' : 'not_installed', engine };
  }
  if (!answer.ok && SIGNED_OUT.test(said)) return { kind: 'signed_out', engine };
  if (!answer.ok && USAGE_LIMIT.test(said)) return { kind: 'usage_limit', engine };
  if (answer.reason === 'timeout' || answer.timed_out) return { kind: 'timed_out', engine };
  if (/^exit_/.test(answer.reason || '') && answer.exit_code !== 0) return { kind: 'exited', engine, exit: answer.exit_code };
  if (!text) return { kind: 'empty', engine };
  return { kind: 'unusable', engine };
}

// The engine's own sign-in command, from the login table engine login uses.
function signInStep(engine) {
  try {
    const { ENGINE_LOGIN_MANIFESTS } = require('../commands/engine');
    const hint = ENGINE_LOGIN_MANIFESTS[engine] && ENGINE_LOGIN_MANIFESTS[engine].missingHint;
    if (hint) return hint.replace(/\s+first$/, '');
  } catch {}
  return `sign in to ${engine}`;
}

// The engine is the problem when it never ran or could not answer; then the
// next step is to fix it. Otherwise it ran and the next step is by hand.
const ENGINE_KINDS = new Set(['no_engine', 'not_installed', 'signed_out', 'exited']);

// owner: the member asked. wanted: what it was asked for ("a judge script",
// "missions"). byHand: the exact command to do it without the engine.
// again: what to run once the engine works.
function explainStall({ owner, answer, wanted, byHand, again }) {
  const cause = stallCause(answer);
  const e = cause.engine;
  const why = {
    no_engine: `no engine on this computer is ready to do ${owner}'s work and the fallback ${e} is not installed`,
    not_installed: `${owner}'s engine is ${e} and ${e} is not installed on this computer`,
    signed_out: `${owner}'s engine is ${e} and ${e} is not signed in`,
    usage_limit: `${owner}'s engine is ${e} and ${e} hit its usage limit`,
    timed_out: `${owner}'s engine is ${e} and ${e} ran out of time before it answered`,
    exited: `${owner}'s engine is ${e} and ${e} stopped with exit ${cause.exit} before it answered`,
    empty: `${owner}'s engine is ${e} and ${e} ran but sent back nothing`,
    unusable: `${owner}'s engine is ${e} and ${e} answered without ${wanted} atris could use`,
  }[cause.kind];
  const fix = {
    no_engine: 'install codex or claude code',
    not_installed: `install ${e}`,
    signed_out: signInStep(e),
    exited: `run atris engine test ${e} to see why it stopped`,
  }[cause.kind];
  const next = ENGINE_KINDS.has(cause.kind) && again
    ? `${fix}, then run ${again} again`
    : byHand;
  return { kind: cause.kind, engine: e, why, next, line: `${why}.\nnext: ${next}`, inline: `${why}. next: ${next}` };
}

// True when asking again cannot help: the engine never ran.
function engineCannotRun(answer) {
  const kind = stallCause(answer).kind;
  return kind === 'no_engine' || kind === 'not_installed' || kind === 'signed_out';
}

module.exports = { askSummary, engineCannotRun, explainStall };
