'use strict';

// atris film: see film projects and suggest edits. Agents only suggest; the
// person approves in their film editor. Backend: /api/film-studio/*.

const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, wantsHelp, wantsJson, tokenFrom, oneLine } = require('../lib/developer-api');

const BASE = '/film-studio';
const POLL_MS = 2000;
const MAX_POLLS = 30; // 60 seconds
const DONE_STATES = new Set(['done', 'refused', 'expired']);

function showFilmHelp(log = console.log) {
  log('usage: atris film [list] [--json]');
  log('       atris film show <slug> [--json]');
  log('       atris film propose <slug> \'<op json>\' --why "<one line>" [--wait] [--json]');
  log('       atris film status <id> [--json]');
  log('see film projects and suggest edits. Times are frames (30 a second).');
  log('proposals change nothing until the person approves them in their editor.');
}

function parseArgs(args) {
  const out = { positional: [], why: '', wait: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === '--json') continue;
    if (a === '--wait') out.wait = true;
    else if (a === '--why') { out.why = String(args[i + 1] == null ? '' : args[i + 1]); i += 1; }
    else if (a.startsWith('--why=')) out.why = a.slice(6);
    else out.positional.push(a);
  }
  return out;
}

const secs = (f, fps) => (Number(f) / (fps || 30)).toFixed(2);

function describeEdit(e) {
  if (!e || typeof e !== 'object') return String(e);
  const who = e.by || 'someone';
  const text = e.summary || (e.op ? JSON.stringify(e.op) : 'an edit');
  const label = e.n != null ? `#${e.n}` : (e.id ? `#${e.id}` : '-');
  const state = e.status ? ` (${e.status})` : '';
  const why = e.why ? ` Why: ${oneLine(e.why)}` : '';
  return `${label} ${who}${state}: ${oneLine(text)}${why}`;
}

function showLines(d) {
  const tl = d.timeline && typeof d.timeline === 'object' ? d.timeline : {};
  const fps = Number(tl.fps) || 30;
  const bubbles = Array.isArray(tl.bubbles) ? tl.bubbles : [];
  const lines = [`${d.title || d.slug} (${d.slug})  version ${d.version == null ? '?' : d.version}`];
  lines.push(`Editor Mac: ${d.mac_online ? 'online' : 'off'}${d.render_status ? `, render: ${d.render_status}` : ''}`);
  lines.push(`${tl.width || '?'}x${tl.height || '?'} at ${fps} fps, ${tl.duration_f || 0} frames (${secs(tl.duration_f || 0, fps)} s), ${bubbles.length} bubbles`);
  const order = (Array.isArray(tl.tracks) ? tl.tracks.map((t) => t.id) : []);
  for (const b of bubbles) if (!order.includes(b.track)) order.push(b.track);
  for (const track of order) {
    const rows = bubbles.filter((b) => b.track === track).sort((a, b) => a.start_f - b.start_f);
    lines.push('', track);
    if (!rows.length) lines.push('  (empty)');
    for (const b of rows) {
      const what = b.label || (b.source && (b.source.file || b.source.kind)) || '';
      lines.push(`  ${b.id}  frames ${b.start_f}-${b.end_f}  ${secs(b.start_f, fps)}-${secs(b.end_f, fps)} s  ${what}${b.locked ? '  [locked]' : ''}`);
    }
  }
  const notes = Array.isArray(tl.notes) ? tl.notes : [];
  if (notes.length) {
    lines.push('', 'notes');
    for (const n of notes) lines.push(`  ${n.id}  frame ${n.t_f} (${secs(n.t_f, fps)} s)  ${oneLine(n.text)}`);
  }
  const edits = (Array.isArray(d.edits) ? d.edits : []).slice(-10);
  lines.push('', 'last edits');
  if (!edits.length) lines.push('  none yet');
  for (const e of edits) lines.push(`  ${describeEdit(e)}`);
  const pending = Array.isArray(d.pending) ? d.pending : [];
  lines.push('', `pending proposals: ${pending.length}`);
  for (const e of pending) lines.push(`  ${describeEdit(e)}`);
  return lines;
}

function commandLines(c, id) {
  const status = c.status || 'unknown';
  if (status === 'done') return ['Done. Your suggestion reached the editor and is waiting for the person to approve it.'];
  if (status === 'refused') return [`Refused: ${oneLine(c.error)}`];
  if (status === 'expired') return ['Expired: the editor Mac did not pick it up in time. Try again when it is on.'];
  return [`${status}. Check later: atris film status ${id}`];
}

async function filmCommand(args = [], deps = {}) {
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  if (wantsHelp(args)) { showFilmHelp(io.log); return 0; }
  const json = wantsJson(args);
  const request = deps.apiRequestJson || apiRequestJson;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fail = (message, extra = {}) => {
    if (json) io.log(JSON.stringify({ ok: false, error: message, ...extra }));
    else io.err(message);
    return 1;
  };
  const ok = (payload, lines) => {
    if (json) io.log(JSON.stringify({ ok: true, ...payload }));
    else for (const l of lines) io.log(l);
    return 0;
  };
  const token = tokenFrom((deps.loadCredentials || loadCredentials)());
  if (!token) return fail(NOT_LOGGED_IN);
  const call = async (path, options = {}) => {
    try {
      const res = await request(`${BASE}${path}`, { token, ...options });
      return res || { ok: false, error: 'request failed' };
    } catch (e) {
      return { ok: false, error: oneLine(e && e.message) };
    }
  };

  const { positional, why, wait } = parseArgs(args);
  const sub = positional[0] || 'list';

  if (sub === 'list') {
    const res = await call('/projects');
    if (!res.ok) return fail(oneLine(res.error), { status: res.status });
    const d = res.data || {};
    const projects = Array.isArray(d.projects) ? d.projects : [];
    const lines = [`Editor Mac: ${d.mac_online ? 'online' : 'off'}`];
    if (!projects.length) lines.push('No film projects yet.');
    for (const p of projects) {
      lines.push(`${p.slug}  ${p.title || ''}  version ${p.version == null ? '?' : p.version}  ${p.pending_count || 0} pending  updated ${p.updated_at || '?'}`);
    }
    return ok({ mac_online: Boolean(d.mac_online), projects }, lines);
  }

  if (sub === 'show') {
    const slug = positional[1];
    if (!slug) return fail('usage: atris film show <slug>');
    const res = await call(`/projects/${encodeURIComponent(slug)}`);
    if (!res.ok) return fail(oneLine(res.error), { status: res.status });
    return ok({ project: res.data }, showLines({ slug, ...(res.data || {}) }));
  }

  if (sub === 'status') {
    const id = positional[1];
    if (!id) return fail('usage: atris film status <id>');
    const res = await call(`/commands/${encodeURIComponent(id)}`);
    if (!res.ok) return fail(oneLine(res.error), { status: res.status });
    return ok({ command_id: id, ...(res.data || {}) }, commandLines(res.data || {}, id));
  }

  if (sub === 'propose') {
    const [, slug, raw] = positional;
    if (!slug || !raw) return fail('usage: atris film propose <slug> \'<op json>\' --why "<one line>" [--wait]');
    if (!why.trim()) return fail('add --why "<one line>" so the person knows the reason for this edit');
    let op;
    try { op = JSON.parse(raw); } catch { return fail('the edit is not valid JSON. Example: \'{"op":"move","id":"<bubble id>","start_f":30}\''); }
    if (!op || typeof op !== 'object' || Array.isArray(op) || typeof op.op !== 'string') {
      return fail('the edit must be a JSON object with an "op" name, like {"op":"move","id":"<bubble id>","start_f":30}');
    }
    const res = await call(`/projects/${encodeURIComponent(slug)}/commands`, {
      method: 'POST',
      body: { kind: 'op', payload: { op, propose: true }, why: why.trim() },
    });
    if (!res.ok) return fail(oneLine(res.error), { status: res.status });
    const id = res.data && res.data.command_id;
    if (!id) return fail('the server did not return a command id');
    if (!wait) {
      return ok({ command_id: id, status: 'pending' }, [`Queued proposal ${id}. It changes nothing until the person approves it in their editor.`, `Check it: atris film status ${id}`]);
    }
    let last = { status: 'pending' };
    for (let i = 0; i < MAX_POLLS; i += 1) {
      await sleep(POLL_MS);
      const poll = await call(`/commands/${encodeURIComponent(id)}`);
      if (poll.ok && poll.data) {
        last = poll.data;
        if (DONE_STATES.has(last.status)) break;
      }
    }
    const lines = DONE_STATES.has(last.status)
      ? commandLines(last, id)
      : [`Still ${last.status || 'pending'} after 60 s. The editor Mac may be off.`, `Check later: atris film status ${id}`];
    const finished = DONE_STATES.has(last.status);
    const payload = { command_id: id, ...last, status: last.status || 'pending' };
    if (json) io.log(JSON.stringify({ ok: last.status === 'done', ...payload }));
    else for (const l of lines) (last.status === 'done' || !finished ? io.log : io.err)(l);
    if (last.status === 'done') return 0;
    return finished ? 1 : 2;
  }

  return fail(`unknown film command "${sub}". Try: atris film --help`);
}

module.exports = { filmCommand };
