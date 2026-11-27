'use strict';

// The caller makes the model call; this computer keeps the files.
//
// With ATRIS_FEED_TURNS=caller (exactly), every turn the feed would send to an
// Atris cloud model (atris-fast, atris-pro, atris-max) is written to a file
// instead of the network, and the answer is read back from a file. The
// website, which holds the sign-in, reads the request with `atris feed turns`,
// makes the call, and answers with `atris feed turns answer`. Anything else in
// ATRIS_FEED_TURNS leaves the feed as it was.
//
// Files, under <project>/.atris/state/feed/turns/:
//   <id>.json          the request (written atomically; <id> is lowercase hex)
//   <id>.partial       the answer so far, appended by `turns answer --append-b64`
//   <id>.answer.json   the answer: {"ok":true,"text"} or {"ok":false,"reason","needs_sign_in"?}
//   live/<pid>.json    a background teammate process started while the switch is on
//
// The one seam is runCallerTurn: it takes what lib/sentinel-cloud.js
// runAtrisTurn takes and returns what it returns for the same outcome.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 'atris.feed.v1';
const WAIT_MS = 90 * 1000;
const POLL_MS = 150;
const LIVE_MAX_MS = 20 * 60 * 1000;
const ID = /^[0-9a-f]{16,64}$/;
const PURPOSES = new Set(['think', 'talk', 'discuss', 'ask', 'setup', 'other']);
const NOT_WAITING = 'That turn is not waiting.';

function callerTurns(env = process.env) {
  return Boolean(env) && env.ATRIS_FEED_TURNS === 'caller';
}

function turnsDir(root) {
  return path.join(root, '.atris', 'state', 'feed', 'turns');
}

function fileOf(root, id, suffix = '.json') {
  return path.join(turnsDir(root), `${id}${suffix}`);
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data)}\n`);
  fs.renameSync(temp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function removeQuietly(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

function removeTurn(root, id) {
  for (const suffix of ['.json', '.partial', '.answer.json']) removeQuietly(fileOf(root, id, suffix));
}

function waitMsOf(env, timeoutMs) {
  const set = Number(env && env.ATRIS_FEED_TURN_WAIT_MS);
  if (Number.isFinite(set) && set > 0) return Math.round(set);
  // The turn's own limit still holds: a caller never waits longer than the network call would have.
  const limit = Number(timeoutMs);
  return Number.isFinite(limit) && limit > 0 ? Math.min(WAIT_MS, limit) : WAIT_MS;
}

// One model turn through files. Same arguments and same return shape as
// runAtrisTurn ({ ok, stdout, reason, credits_charged, billed }); the whole
// answer reaches onText as one piece.
async function runCallerTurn({ model, prompt, timeoutMs = null, maxOutputTokens = null, onText = null, root, member = null, purpose = 'other', env = process.env, sleep = null }) {
  const { redactOutgoing } = require('./sentinel-cloud');
  const { text: message } = redactOutgoing(prompt);
  const body = { message, model, max_turns: 1, disable_connector_tools: true };
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens >= 16) body.max_output_tokens = Math.min(8192, maxOutputTokens);
  const wait = waitMsOf(env, timeoutMs);
  const id = crypto.randomBytes(12).toString('hex');
  const created = Date.now();
  const request = {
    version: VERSION,
    id,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + wait).toISOString(),
    member: member || null,
    purpose: PURPOSES.has(purpose) ? purpose : 'other',
    model: body.model,
    message: body.message,
    max_turns: body.max_turns,
    disable_connector_tools: body.disable_connector_tools,
    body,
  };
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    writeAtomic(fileOf(root, id), request);
  } catch (error) {
    return { ok: false, stdout: '', reason: error.message, credits_charged: 0, billed: false };
  }
  let answer = null;
  while (Date.now() - created < wait) {
    answer = readJson(fileOf(root, id, '.answer.json'));
    if (answer) break;
    await pause(POLL_MS);
  }
  if (!answer) answer = readJson(fileOf(root, id, '.answer.json'));
  removeTurn(root, id);
  if (!answer) return { ok: false, stdout: '', reason: 'took too long', credits_charged: 0, billed: false };
  if (answer.ok !== true) {
    const said = String(answer.reason || '').trim();
    // Said the way the server says a refused sign-in, so the feed reads it the same way.
    const reason = answer.needs_sign_in === true ? `the server said 401${said ? `: ${said}` : ''}` : (said || 'no answer');
    return { ok: false, stdout: '', reason, credits_charged: 0, billed: false };
  }
  const stdout = typeof answer.text === 'string' ? answer.text : '';
  if (stdout && onText) { try { onText(stdout); } catch {} }
  return { ok: Boolean(stdout), stdout, reason: stdout ? undefined : 'empty answer', credits_charged: 0, billed: false };
}

// ------------------------------------------------------------- waiting turns

function expired(request, now = Date.now()) {
  const at = Date.parse(request && request.expires_at);
  return !Number.isFinite(at) || at <= now;
}

// A request still waiting for its answer, or null. An expired one is cleaned up.
function waitingRequest(root, id) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  const request = readJson(fileOf(root, id));
  if (!request || request.id !== id) return null;
  if (expired(request)) { removeTurn(root, id); return null; }
  if (fs.existsSync(fileOf(root, id, '.answer.json'))) return null;
  return request;
}

function listWaiting(root) {
  let names = [];
  try { names = fs.readdirSync(turnsDir(root)); } catch { return []; }
  const out = [];
  for (const name of names) {
    const match = /^([0-9a-f]{16,64})\.json$/.exec(name);
    if (!match) continue;
    const request = waitingRequest(root, match[1]);
    if (request) out.push(request);
  }
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
}

// ------------------------------------------------------------- in flight

function liveDir(root) {
  return path.join(turnsDir(root), 'live');
}

// A background teammate process (a thought, a discussion, a queued wake) the
// feed just started while the switch is on. Cleaned once its process is gone.
function noteLive(root, pid, what, env = process.env) {
  if (!callerTurns(env) || !root || !Number.isInteger(pid) || pid <= 0) return;
  try { writeAtomic(path.join(liveDir(root), `${pid}.json`), { pid, what: String(what || ''), at: new Date().toISOString() }); } catch {}
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

function liveProcesses(root, alive = pidAlive) {
  let names = [];
  try { names = fs.readdirSync(liveDir(root)); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(liveDir(root), name);
    const mark = readJson(file);
    const pid = Number(mark && mark.pid);
    const old = Date.now() - (Date.parse(mark && mark.at) || 0) > LIVE_MAX_MS;
    if (!mark || old || !alive(pid)) { removeQuietly(file); continue; }
    count += 1;
  }
  return count;
}

// True while any teammate thought, talk or discussion this project started is
// still in flight: a turn waiting for its answer, a teammate marked as thinking
// whose process is alive (the feed's own thinking-<member>.json marks), or a
// background teammate process started under the switch that is still running.
function thinking(root, { alive = pidAlive } = {}) {
  if (listWaiting(root).length) return true;
  try {
    const stateDir = path.join(root, '.atris', 'state', 'feed');
    for (const name of fs.readdirSync(stateDir)) {
      if (!/^thinking-.+\.json$/.test(name)) continue;
      const mark = readJson(path.join(stateDir, name));
      if (!mark) continue;
      if (Date.now() - (Date.parse(mark.at || '') || 0) > 150 * 1000) continue; // a crashed thought (the feed's own limit)
      if (alive(Number(mark.pid))) return true;
    }
  } catch {}
  return liveProcesses(root, alive) > 0;
}

// ------------------------------------------------------------- the commands

class TurnError extends Error {}

function view(root) {
  const now = Date.now();
  return {
    version: VERSION,
    turns: listWaiting(root).map((r) => ({
      id: r.id,
      member: r.member || null,
      purpose: r.purpose,
      model: r.model,
      max_turns: r.max_turns,
      message_chars: String(r.message || '').length,
      age_ms: Math.max(0, now - (Date.parse(r.created_at) || now)),
    })),
    thinking: thinking(root),
  };
}

function show(root, id) {
  const request = waitingRequest(root, id);
  if (!request) throw new TurnError(NOT_WAITING);
  return request;
}

function append(root, id, b64) {
  if (!waitingRequest(root, id)) throw new TurnError(NOT_WAITING);
  const raw = String(b64 || '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) throw new TurnError('That is not base64 text.');
  const text = Buffer.from(raw, 'base64').toString('utf8');
  const file = fileOf(root, id, '.partial');
  fs.appendFileSync(file, text);
  return { ok: true, chars: fs.readFileSync(file, 'utf8').length };
}

function done(root, id) {
  if (!waitingRequest(root, id)) throw new TurnError(NOT_WAITING);
  let text = '';
  try { text = fs.readFileSync(fileOf(root, id, '.partial'), 'utf8'); } catch {}
  writeAtomic(fileOf(root, id, '.answer.json'), { ok: true, text });
  removeQuietly(fileOf(root, id, '.partial'));
  return { ok: true };
}

function failed(root, id, reason, { needsSignIn = false } = {}) {
  if (!waitingRequest(root, id)) throw new TurnError(NOT_WAITING);
  const said = String(reason || '').trim();
  if (!said) throw new TurnError('Say why the turn failed in one plain sentence.');
  writeAtomic(fileOf(root, id, '.answer.json'), { ok: false, reason: said, ...(needsSignIn ? { needs_sign_in: true } : {}) });
  removeQuietly(fileOf(root, id, '.partial'));
  return { ok: true };
}

// `atris feed turns ...`: positional is everything after "turns". Returns
// { code, out } with out printed as JSON by the command.
function command(root, positional, flags) {
  try {
    if (!positional.length) return { code: 0, out: view(root) };
    if (positional[0] === 'show') return { code: 0, out: show(root, positional[1]) };
    if (positional[0] === 'answer') {
      const id = positional[1];
      if (flags['append-b64'] !== undefined) return { code: 0, out: append(root, id, flags['append-b64']) };
      if (flags.done) return { code: 0, out: done(root, id) };
      if (flags.failed !== undefined) return { code: 0, out: failed(root, id, flags.failed, { needsSignIn: flags['needs-sign-in'] === true }) };
      throw new TurnError('usage: atris feed turns answer <id> --append-b64 <text> | --done | --failed "<plain sentence>" [--needs-sign-in]');
    }
    throw new TurnError('usage: atris feed turns [--json] | turns show <id> | turns answer <id> ...');
  } catch (error) {
    if (error instanceof TurnError) return { code: 1, out: { error: error.message } };
    throw error;
  }
}

module.exports = {
  callerTurns,
  command,
  listWaiting,
  noteLive,
  runCallerTurn,
  thinking,
  turnsDir,
};
