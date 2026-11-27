'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ops = require('./element-ops');
const feed = require('./feed-core');
const team = require('./feed-team');
const { holdsKey } = require('./feed-plain-words');

const file = (root) => ops.stateFile(root, 'mirror.json');
const read = (root) => ops.readJson(file(root), { on: false, sent: [] });
const save = (root, state) => ops.writeJsonAtomic(file(root), state);
function on(root, channel, env) {
  const viewer = feed.viewerOf(env);
  if (viewer.agent) throw new feed.FeedError(403, 'Only a person can turn the mirror on.');
  if (!String(channel || '').trim()) throw new feed.FeedError(400, 'Choose a channel.');
  const now = new Date().toISOString();
  const state = { target: 'slack', channel: String(channel).trim(), on: true, set_by: viewer.person, set_at: now, cursor: now, sent: [] };
  state.baseline = team.readEvents(root, { limit: Number.MAX_SAFE_INTEGER }).filter((event) => event.at === now).map((event) => event.id).filter(Boolean);
  save(root, state);
  return state;
}
function off(root) { const state = read(root); state.on = false; save(root, state); return state; }
function lineFor(ev) {
  const verbs = { task: 'posted a task', claimed: 'took a task', progress: 'reported progress', result: 'handed in a result, waiting for the owner to accept', asked: 'asked the owner', passed: 'passed a task on', reply: 'replied', decision: 'made a decision' };
  if (!verbs[ev.type]) return null;
  const clean = (value) => String(value || '').replace(/\b(?:task|post|card|result|work|proposal|idea|ask|session):[^\s]+/gi, '').replace(/(?:\/[\w.~-]+){2,}/g, '').replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/gi, '').replace(/\s+/g, ' ').trim();
  const who = clean(ev.member) || 'Someone';
  const text = clean(ev.text).replace(/^took:\s*/i, '');
  return `${who} ${verbs[ev.type]}: ${text}`.slice(0, 299);
}
function pending(root, state) {
  if (!state.cursor) return [];
  const sent = new Set([...(state.sent || []), ...(state.baseline || [])]);
  const events = team.readEvents(root, { limit: Number.MAX_SAFE_INTEGER }).map((event, index) => ({ event, key: event.id || crypto.createHash('sha256').update(JSON.stringify(event) + index).digest('hex') }));
  const position = state.cursor_key ? events.findIndex(({ key }) => key === state.cursor_key) : -1;
  return events.filter(({ event, key }, index) => event.at && (event.at > state.cursor || (event.at === state.cursor && (position < 0 || index > position))) && !sent.has(key));
}
function status(root) {
  const state = read(root);
  return { on: !!state.on, channel: state.channel || null, last_sent_at: state.last_sent_at || null, waiting: pending(root, state).filter(({ event }) => lineFor(event) && !holdsKey(lineFor(event)) && !holdsKey(String(event.text || '')) && !holdsKey(String(event.member || ''))).length };
}
async function tick(root, { dry = false, limit = 20, deps = {} } = {}) {
  limit = Number(limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new feed.FeedError(400, 'Limit must be between 1 and 50.');
  const lock = ops.stateFile(root, 'mirror.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 120000) { fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx'); } } catch (e) { if (e.code !== 'EEXIST' && e.code !== 'ENOENT') throw e; }
    if (fd === undefined) return { ok: false, error: 'another tick is running', lines: [], held_back: 0, left: 0 };
  }
  try {
    let state = read(root);
    if (!dry && !state.on) return { ok: true, on: false, lines: [], held_back: 0, left: status(root).waiting };
    const events = pending(root, state);
    const lines = [];
    let held = 0;
    let error = null;
    let index = 0;
    for (; index < events.length; index++) {
      const { event, key } = events[index];
      const line = lineFor(event);
      const secret = line && (holdsKey(line) || holdsKey(String(event.text || '')) || holdsKey(String(event.member || '')));
      if (line && !secret && lines.length >= limit) break;
      if (secret) held++;
      else if (line) {
        if (!dry) {
          const current = read(root);
          if (!current.on || current.set_at !== state.set_at) break;
          try {
            const result = await (deps.mirrorSend || require('./slack-send').send)(state.channel, line);
            if (result && result.ok === false) throw new Error(result.error || 'Failed to send');
          } catch (e) { error = String(e.message || e); break; }
        }
        lines.push(line);
      }
      if (!dry) {
        const current = read(root);
        if (current.set_at !== state.set_at) break;
        state.on = current.on;
        state.sent = [...(state.sent || []), key].slice(-500);
        state.cursor = event.at;
        state.cursor_key = key;
        if (line && !secret) state.last_sent_at = new Date().toISOString();
        save(root, state);
      }
    }
    const left = events.slice(index).filter(({ event }) => { const line = lineFor(event); return line && !holdsKey(line) && !holdsKey(String(event.text || '')) && !holdsKey(String(event.member || ''));  }).length;
    return { ok: !error, on: !!state.on, dry, lines, held_back: held, left, ...(error ? { error } : {}) };
  } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
}
module.exports = { on, off, status, tick };
