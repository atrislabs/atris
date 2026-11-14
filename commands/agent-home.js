'use strict';

// atris agent pull | push | snapshot | spawn: carry an Atris agent's whole
// home folder between the server and this computer, so any engine that reads
// files and runs commands (Claude Code, Codex, Muse, Grok) can become the
// agent with nothing dropped. Backend: /api/agents/{id}/home/... and
// /api/agents/{id}/spawn. The server copy is the durable one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { apiRequestJson } = require('../utils/api');
const { NOT_LOGGED_IN, oneLine } = require('../lib/developer-api');
const { parseArgs, loginToken } = require('../lib/business-target');
const { frontmatterOf } = require('../lib/member-export');
const home = require('../lib/agent-home');

// The route for one part of an agent's stored folder.
const homeRoute = (id, leaf) => ['/agents', encodeURIComponent(id), 'home', leaf].join('/');

const HOME_VERBS = new Set(['pull', 'push', 'snapshot', 'publish', 'unpublish']);
// Twice the 2,000 file limit, even if every answer moves by one file.
const MAX_BUNDLE_ANSWERS = 4000;
const PUSH_BATCH_BYTES = 4000000;
const PUSH_BATCH_FILES = 200;

function homeHelp(log = console.log) {
  log(`usage: atris agent pull [<agent>] [--dir <folder>]   copy the agent's home folder here and set it up for any engine
       atris agent push [--dir <folder>]              send what changed here back to the agent's home
       atris agent snapshot [<agent>] [--reason "..."] save a version of the home you can restore later
       atris agent publish [<agent>] --as <name> [--lane <lane>] [--full-skills] [--library] [--price <usd>]
                                                      publish the agent as a model
       atris agent unpublish [<agent>]                remove the model name
       atris agent spawn [<parent>] --name <name> --budget <credits> [--role "..."] [--soul "..."] [--mission "..."]
                                                      make a child agent; its private key is saved to ~/.atris/agents/<name>.json

<agent> is an agent id, or a name saved by spawn. Inside a pulled folder it can be left off.
pull writes AGENTS.md and a CLAUDE.md block from MEMBER.md, SOUL.md and MISSION.md, so
Claude Code, Codex, Muse or Grok started in that folder boots as the agent.
--json prints the server's answer for scripts. Uses your sign-in (atris login, or an agent token).`);
}

// True for argv (after `agent`) that these verbs own. `spawn` is shared with
// the local worker request (`atris agent spawn <role> --task`); a budget makes
// it a child agent on the server.
function isHomeCommand(args = []) {
  const verb = args[0];
  if (HOME_VERBS.has(verb)) return true;
  return verb === 'spawn' && args.some((arg) => arg === '--budget' || String(arg).startsWith('--budget='));
}

// Which agent a word names: a spawned name in ~/.atris/agents, a local team
// member that records its agent id, or the id itself.
function resolveAgentRef(ref, { cwd, env }) {
  const handle = home.handleOf(ref);
  const saved = home.readKeyFile(handle, env);
  if (saved && saved.agent_id) return { id: String(saved.agent_id), handle };
  const memberFile = path.join(cwd, 'atris', 'team', ref, 'MEMBER.md');
  if (!ref.includes('/') && fs.existsSync(memberFile)) {
    const { fields } = frontmatterOf(fs.readFileSync(memberFile, 'utf8'));
    const id = fields.member_id || fields['agent-id'];
    if (typeof id === 'string' && id.trim()) return { id: id.trim(), handle };
  }
  return { id: ref, handle: null };
}

// The server's answer in one plain sentence.
function why(res, label) {
  if (!res || res.status === 0) return `could not reach the Atris server${res && res.error ? ` (${oneLine(res.error)})` : ''}`;
  if (res.status === 401) return 'your sign-in was refused. run: atris login';
  if (res.status === 404 || res.status === 405) {
    return `the server has no home for ${label}: agent homes are not turned on there yet, or this sign-in cannot see that agent`;
  }
  const detail = res.data && typeof res.data === 'object' ? (res.data.detail || res.data.error || res.data.message) : null;
  const text = typeof detail === 'string' ? detail : (typeof res.error === 'string' ? res.error : '');
  return oneLine(text || `the server answered ${res.status}`);
}

function codePoints(text) {
  return Array.from(text, (char) => char.codePointAt(0));
}

// The server walks paths in code point order; a cursor that does not move
// forward would loop forever.
function movesForward(after, next) {
  const a = codePoints(after);
  const b = codePoints(next);
  for (let i = 0; i < b.length; i += 1) {
    if (i >= a.length) return true;
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

function validBundle(data) {
  return data && Array.isArray(data.pages) && Array.isArray(data.gone) && Array.isArray(data.skipped)
    && (data.next == null || (typeof data.next === 'string' && data.next));
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

async function pull({ ref, flags, cwd, env, call, log, err }) {
  const insideDir = flags.dir ? null : home.findHomeDir(cwd);
  let agent;
  let dir;
  if (ref) {
    agent = resolveAgentRef(ref, { cwd, env });
    dir = path.resolve(cwd, flags.dir || agent.handle || ref);
  } else {
    dir = flags.dir ? path.resolve(cwd, flags.dir) : insideDir;
    const state = dir && home.loadState(dir);
    if (!state) { err('name the agent to pull, like: atris agent pull <agent> --dir <folder>'); return 1; }
    agent = { id: state.agent_id, handle: state.handle };
  }
  const label = agent.handle || agent.id;
  const made = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const rootReal = fs.realpathSync(dir);
  const previous = home.loadState(rootReal);
  if (previous && previous.agent_id !== agent.id) {
    err(`${dir} already holds the agent ${previous.handle || previous.agent_id}. pick another folder with --dir`);
    return 1;
  }
  const state = previous || { schema: 'atris.agent_home.v1', agent_id: agent.id, handle: agent.handle, files: {} };

  // Advertise only copies still here, so a file deleted here comes back.
  const have = {};
  for (const [rel, base] of Object.entries(state.files)) {
    if (home.homeRel(rel) && base && base.etag && home.readLocal(rootReal, rel) !== null) have[rel] = base.etag;
  }

  const out = { added: [], updated: [], unchanged: 0, kept: [], gone: [], skipped: [] };
  const take = (page) => {
    const rel = home.homeRel(page.path);
    if (!rel) { out.skipped.push({ path: String(page.path), why: 'unsafe name' }); return; }
    const local = home.readLocal(rootReal, rel);
    const base = state.files[rel];
    const editedHere = local !== null && (!base || base.sha256 !== home.sha256(local));
    if (editedHere && local !== page.text) { out.kept.push(rel); return; }
    state.files[rel] = { etag: page.etag, sha256: home.sha256(page.text) };
    if (local === page.text) { out.unchanged += 1; return; }
    home.writeText(rootReal, rel, page.text);
    (local === null ? out.added : out.updated).push(rel);
  };

  let after = '';
  let gone = [];
  for (let answers = 1; ; answers += 1) {
    const res = await call(homeRoute(agent.id, 'bundle'), { method: 'POST', body: { have, after } });
    if (!res || !res.ok) {
      if (answers > 1) home.saveState(rootReal, state);
      else if (made) fs.rmSync(rootReal, { recursive: true, force: true });
      err(`could not pull ${label}: ${why(res, label)}`);
      return 1;
    }
    const data = res.data;
    if (!validBundle(data) || data.pages.some((p) => !p || typeof p.path !== 'string' || typeof p.text !== 'string' || typeof p.etag !== 'string')) {
      err(`could not pull ${label}: the server sent an answer this version of atris cannot read`);
      return 1;
    }
    for (const page of data.pages) take(page);
    out.unchanged += Number(data.unchanged) || 0;
    if (answers === 1) gone = data.gone.filter((rel) => typeof rel === 'string');
    for (const item of data.skipped) if (item && typeof item.path === 'string') out.skipped.push({ path: item.path, why: item.why || item.reason || 'skipped' });
    if (!data.next) break;
    if (!movesForward(after, data.next) || answers >= MAX_BUNDLE_ANSWERS) {
      home.saveState(rootReal, state);
      err(`could not pull ${label}: the server's download did not move forward`);
      return 1;
    }
    after = data.next;
  }

  // Files removed on the server go here too, unless they were edited here.
  for (const rel of gone) {
    const base = state.files[rel];
    if (!base || !home.homeRel(rel)) continue;
    const local = home.readLocal(rootReal, rel);
    if (local !== null && home.sha256(local) !== base.sha256) { out.kept.push(rel); continue; }
    if (local !== null) fs.unlinkSync(path.join(rootReal, rel));
    delete state.files[rel];
    out.gone.push(rel);
  }

  const member = home.readLocal(rootReal, 'MEMBER.md');
  const name = member !== null ? String(frontmatterOf(member).fields.name || '').trim() : '';
  if (name) state.handle = home.handleOf(name) || state.handle;
  state.pulled_at = new Date().toISOString();
  home.saveState(rootReal, state);
  const adapters = home.writeAdapters(rootReal);

  const result = { ok: true, agent_id: agent.id, dir: rootReal, ...out, adapters };
  if (flags.json) { log(JSON.stringify(result, null, 2)); return 0; }
  const shown = path.relative(cwd, rootReal) || '.';
  const who = name || label;
  const moved = out.added.length + out.updated.length + out.gone.length;
  if (!moved && !out.kept.length) log(`Pulled ${who} into ${shown}: nothing changed, ${plural(out.unchanged, 'file')} already here.`);
  else {
    const bits = [`${out.added.length} new`, `${out.updated.length} updated`];
    if (out.gone.length) bits.push(`${out.gone.length} removed`);
    bits.push(`${out.unchanged} unchanged`);
    log(`Pulled ${who} into ${shown}: ${bits.join(', ')}.`);
  }
  for (const rel of out.kept) log(`Kept your copy of ${rel}. The server changed it too; push to send yours, or delete it here and pull again to take theirs.`);
  if (out.skipped.length) log(`${plural(out.skipped.length, 'file')} stayed on the server because they are not text or are too big: ${out.skipped.map((s) => s.path).join(', ')}.`);
  if (adapters.length) log(`Wrote ${adapters.join(' and ')} so an engine started in ${shown} boots as ${who}.`);
  else if (member === null) log('The home has no MEMBER.md yet, so no AGENTS.md or CLAUDE.md was written.');
  return 0;
}

function homeDirFor(flags, cwd, err) {
  const dir = flags.dir ? path.resolve(cwd, flags.dir) : home.findHomeDir(cwd);
  const state = dir && home.loadState(dir);
  if (!state) {
    err(`${flags.dir || 'this folder'} is not a pulled agent home. run: atris agent pull <agent> --dir <folder>`);
    return null;
  }
  return { dir: fs.realpathSync(dir), state };
}

function batches(files) {
  const out = [];
  let current = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.text);
    if (current.length && (current.length >= PUSH_BATCH_FILES || bytes + size > PUSH_BATCH_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

async function push({ flags, cwd, call, log, err }) {
  const found = homeDirFor(flags, cwd, err);
  if (!found) return 1;
  const { dir, state } = found;
  const label = state.handle || state.agent_id;
  const { changed, deleted, skipped } = home.localChanges(dir, state);
  const result = { ok: true, agent_id: state.agent_id, written: [], deleted: [], rejected: [], skipped };
  if (!changed.length && !deleted.length) {
    if (flags.json) log(JSON.stringify(result, null, 2));
    else log(`Nothing to push: ${label}'s home matches the server.`);
    return 0;
  }
  const sha = new Map(changed.map((f) => [f.path, home.sha256(f.text)]));
  const groups = batches(changed);
  if (!groups.length) groups.push([]);
  for (let i = 0; i < groups.length; i += 1) {
    const body = { files: groups[i], delete: i === 0 ? deleted : [] };
    const res = await call(homeRoute(state.agent_id, 'files'), { method: 'PUT', body });
    if (!res || !res.ok || !res.data || !Array.isArray(res.data.written)) {
      if (result.written.length || result.deleted.length) home.saveState(dir, state);
      err(`could not push ${label}: ${res && res.ok ? 'the server sent an answer this version of atris cannot read' : why(res, label)}`);
      return 1;
    }
    const rejected = Array.isArray(res.data.rejected) ? res.data.rejected.filter((r) => r && typeof r.path === 'string') : [];
    const refused = new Set(rejected.map((r) => r.path));
    for (const item of res.data.written) {
      if (!item || typeof item.path !== 'string' || !sha.has(item.path)) continue;
      state.files[item.path] = { etag: String(item.etag || ''), sha256: sha.get(item.path) };
      result.written.push(item.path);
    }
    for (const rel of body.delete) {
      if (refused.has(rel)) continue;
      delete state.files[rel];
      result.deleted.push(rel);
    }
    result.rejected.push(...rejected.map((r) => ({ path: r.path, reason: oneLine(r.reason || 'refused') })));
  }
  home.saveState(dir, state);
  result.ok = result.rejected.length === 0;
  if (flags.json) { log(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1; }
  const bits = [`${plural(result.written.length, 'file')} saved`];
  if (result.deleted.length) bits.push(`${result.deleted.length} removed`);
  log(`Pushed ${label}: ${bits.join(', ')}.`);
  for (const r of result.rejected) {
    const reason = r.path === 'MEMBER.md' && r.reason === 'refused' ? 'only the owner may change the manifest' : r.reason;
    err(`Not saved: ${r.path}. ${reason.replace(/[.\s]*$/, '')}.`);
  }
  if (skipped.length) log(`Left out ${plural(skipped.length, 'file')}: ${skipped.map((s) => `${s.path} ${s.reason}`).join('; ')}.`);
  return result.ok ? 0 : 1;
}

function agentFromArgsOrHome(ref, flags, cwd, env, err, usage) {
  if (ref) return resolveAgentRef(ref, { cwd, env });
  const dir = flags.dir ? path.resolve(cwd, flags.dir) : home.findHomeDir(cwd);
  const state = dir && home.loadState(dir);
  if (state) return { id: state.agent_id, handle: state.handle };
  err(usage);
  return null;
}

async function snapshot({ ref, flags, cwd, env, call, log, err }) {
  const agent = agentFromArgsOrHome(ref, flags, cwd, env, err, 'name the agent, like: atris agent snapshot <agent>, or run it inside a pulled home');
  if (!agent) return 1;
  const label = agent.handle || agent.id;
  const reason = typeof flags.reason === 'string' ? flags.reason : 'saved with atris agent snapshot';
  const res = await call(homeRoute(agent.id, 'snapshots'), { method: 'POST', body: { reason } });
  if (!res || !res.ok) { err(`could not save a snapshot of ${label}: ${why(res, label)}`); return 1; }
  const id = res.data && (res.data.snapshot_id || res.data.id);
  if (flags.json) { log(JSON.stringify({ ok: true, agent_id: agent.id, snapshot_id: id || null }, null, 2)); return 0; }
  log(`Saved a snapshot of ${label}${id ? `: ${id}` : ''}. Every file's version is kept, so you can restore it later.`);
  return 0;
}

async function publish({ ref, flags, cwd, env, call, log, err, unpublish = false }) {
  const agent = agentFromArgsOrHome(ref, flags, cwd, env, err, `name the agent, like: atris agent ${unpublish ? 'unpublish' : 'publish'} <agent>, or run it inside a pulled home`);
  if (!agent) return 1;
  const label = agent.handle || agent.id;
  const route = `/agent/${encodeURIComponent(agent.id)}/publish`;
  const body = { api_model: flags.as };
  if (flags.lane) body.api_lane = flags.lane;
  if (flags.full_skills) body.api_skills = 'full';
  if (flags.library) body.api_library = true;
  const res = await call(route, unpublish ? { method: 'DELETE' } : { method: 'POST', body });
  if (!res || !res.ok) { err(`could not ${unpublish ? 'unpublish' : 'publish'} ${label}: ${why(res, label)}`); return 1; }
  if (!unpublish && flags.price !== undefined) {
    const price = await call(`/agent-wallet/${encodeURIComponent(agent.id)}/price`, { method: 'POST', body: { price_usdc: Number(flags.price) } });
    if (!price || !price.ok) { err(`published ${label}, but could not set the price: ${why(price, label)}`); return 1; }
  }
  const data = res.data || {};
  const answer = Object.fromEntries(['agent_id', 'api_model', 'api_lane', 'api_skills', 'api_library', 'granted', 'serving']
    .filter((key) => Object.prototype.hasOwnProperty.call(data, key)).map((key) => [key, data[key]]));
  if (flags.json) { log(JSON.stringify(answer, null, 2)); return 0; }
  if (unpublish) { log(`unpublished ${label}.`); return 0; }
  log(`published ${label} as ${data.api_model}.`);
  log(flags.price !== undefined ? `price: $${Number(flags.price).toFixed(2)} a call.` : 'price: unchanged.');
  log(data.serving ? 'live: yes.' : 'live: no.');
  if (data.granted === false) log('waiting for Atris to switch the name on.');
  return 0;
}

async function spawn({ ref, flags, cwd, env, call, log, err }) {
  const parent = agentFromArgsOrHome(ref, flags, cwd, env, err, 'name the parent agent, like: atris agent spawn <parent> --name scout --budget 20');
  if (!parent) return 1;
  const name = typeof flags.name === 'string' ? flags.name.trim() : '';
  const handle = home.handleOf(name);
  if (!handle) { err('give the child a name, like: --name scout'); return 1; }
  const budget = Number(flags.budget);
  if (!Number.isInteger(budget) || budget < 0) { err('--budget takes a whole number of credits, 0 or more'); return 1; }

  // A retry after a lost answer reuses the first request's key, so the server
  // replays it instead of spending the budget twice.
  const saved = home.readKeyFile(handle, env);
  if (saved && saved.private_key) {
    err(`you already have an agent saved as ${handle} (${saved.agent_id}). pick another --name`);
    return 1;
  }
  const idempotencyKey = saved && saved.status === 'pending' && saved.parent_agent_id === parent.id && saved.idempotency_key
    ? saved.idempotency_key
    : crypto.randomUUID();
  const keyFile = home.writeKeyFile(handle, {
    schema: 'atris.agent_key.v1', status: 'pending', name, handle, parent_agent_id: parent.id,
    idempotency_key: idempotencyKey, created_at: new Date().toISOString(),
  }, env);

  const body = { name, role: typeof flags.role === 'string' ? flags.role : name, budget_credits: budget, idempotency_key: idempotencyKey };
  if (typeof flags.soul === 'string') body.soul = flags.soul;
  if (typeof flags.mission === 'string') body.mission = flags.mission;
  const res = await call(`/agents/${encodeURIComponent(parent.id)}/spawn`, { method: 'POST', body });
  const label = parent.handle || parent.id;
  if (!res || !res.ok) {
    const sentence = res && (res.status === 404 || res.status === 405)
      ? `the server cannot spawn from ${label}: spawning is not turned on there yet, or this sign-in cannot see that agent`
      : why(res, label);
    err(`could not spawn ${name}: ${sentence}`);
    if (res && res.status !== 0 && res.status < 500) fs.rmSync(keyFile, { force: true });
    return 1;
  }
  const data = res.data || {};
  const childId = String(data.agent_id || data.id || (data.agent && data.agent.id) || '');
  const privateKey = typeof data.private_key === 'string' && data.private_key ? data.private_key : '';
  const record = {
    schema: 'atris.agent_key.v1', status: privateKey ? 'ready' : 'no-key', name, handle,
    agent_id: childId, parent_agent_id: parent.id, public_key: data.public_key || null,
    idempotency_key: idempotencyKey, created_at: new Date().toISOString(),
  };
  if (privateKey) record.private_key = privateKey;
  home.writeKeyFile(handle, record, env);

  const shown = { ok: true, agent_id: childId, name, parent_agent_id: parent.id, budget_credits: budget, public_key: record.public_key, key_file: keyFile, key_saved: Boolean(privateKey) };
  if (flags.json) { log(JSON.stringify(shown, null, 2)); return 0; }
  log(`Spawned ${name} (${childId}) from ${label} with ${plural(budget, 'credit')}.`);
  if (privateKey) log(`Its private key is saved to ${keyFile}, readable only by you. It is never shown and the server does not keep it.`);
  else log('The server sent no private key (it only sends it once), so none was saved.');
  log(`Pull its home with: atris agent pull ${handle}`);
  return 0;
}

async function agentHomeCommand(args = [], deps = {}) {
  let secret = '';
  const hide = (line) => (secret ? String(line).split(secret).join('[hidden]') : String(line));
  const log = (line) => (deps.log || console.log)(hide(line));
  const err = (line) => (deps.err || console.error)(hide(line));
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;

  const verb = args[0];
  const { flags, pos, error } = parseArgs(args.slice(1), {
    switches: ['account', 'full_skills', 'library'],
    values: ['dir', 'reason', 'name', 'budget', 'role', 'soul', 'mission', 'as', 'lane', 'price'],
  });
  if (flags.help || pos[0] === 'help') { homeHelp(log); return 0; }
  if (error) { err(`${error}. see: atris agent ${verb} --help`); return 1; }
  if (pos.length > 1) { err(`atris agent ${verb} takes one agent, got: ${pos.join(' ')}`); return 1; }
  if (verb === 'publish' && !flags.as) { err('usage: atris agent publish [<agent>] --as <name>'); return 1; }
  if (verb === 'publish' && flags.price !== undefined && (!Number.isFinite(Number(flags.price)) || Number(flags.price) < 0 || Number(flags.price) > 1000)) {
    err('--price must be a number from 0 to 1000'); return 1;
  }

  const token = await loginToken(deps);
  if (!token) { err(NOT_LOGGED_IN); return 1; }
  secret = token;
  const request = deps.apiRequestJson || apiRequestJson;
  const call = (route, options) => request(route, { ...options, token });
  const ctx = { ref: pos[0] || '', flags, cwd, env, call, log, err };
  if (verb === 'pull') return pull(ctx);
  if (verb === 'push') return push(ctx);
  if (verb === 'snapshot') return snapshot(ctx);
  if (verb === 'publish') return publish(ctx);
  if (verb === 'unpublish') return publish({ ...ctx, unpublish: true });
  if (verb === 'spawn') return spawn(ctx);
  homeHelp(log);
  return 1;
}

module.exports = {
  agentHomeCommand,
  isHomeCommand,
  movesForward,
};
