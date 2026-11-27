'use strict';

// Resumable JSONL session store shared between ax CLI and Atris Desktop.
// Stored under ~/.atris/sessions/ (fenced via stateHome() during tests).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateHome } = require('./state-home');

const SESSION_SCHEMA = 'atris.ax_session.v1';

function sessionsDir(baseDir) {
  return baseDir ? path.resolve(baseDir) : path.join(stateHome(), '.atris', 'sessions');
}

function sanitizeSessionId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);
}

function createSessionId() {
  return `ax-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function sessionFilePath(sessionId, { baseDir } = {}) {
  return path.join(sessionsDir(baseDir), `${sanitizeSessionId(sessionId)}.jsonl`);
}

function indexFilePath({ baseDir } = {}) {
  return path.join(sessionsDir(baseDir), 'index.json');
}

function canonicalCwd(cwd) {
  const abs = path.resolve(String(cwd || process.cwd()));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function readIndex(options = {}) {
  const file = indexFilePath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.sessions)) return parsed.sessions;
  } catch {}
  return [];
}

function writeIndex(sessions, options = {}) {
  const dir = sessionsDir(options.baseDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = indexFilePath(options);
  const trimmed = sessions.slice(0, 200);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: SESSION_SCHEMA, sessions: trimmed }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function upsertIndexEntry(entry, options = {}) {
  const current = readIndex(options).filter((item) => item && item.id !== entry.id);
  current.unshift(entry);
  current.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  writeIndex(current, options);
}

function appendSessionRecord(sessionId, record, options = {}) {
  const id = sanitizeSessionId(sessionId);
  if (!id) return;
  const dir = sessionsDir(options.baseDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = sessionFilePath(id, options);
  const entry = {
    ts: new Date().toISOString(),
    ...record,
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });

  const existing = readIndex(options).find((item) => item && item.id === id) || {};
  const cwd = entry.cwd ? canonicalCwd(entry.cwd) : (existing.cwd || canonicalCwd(options.cwd));
  const title = existing.title
    || (entry.type === 'turn' && entry.user ? String(entry.user).replace(/\s+/g, ' ').trim().slice(0, 72) : '')
    || entry.title
    || 'Untitled session';
  const turnCount = (existing.turns || 0) + (entry.type === 'turn' ? 1 : 0);
  const credits = (existing.credits || 0) + (Number(entry.credits) || 0);
  upsertIndexEntry({
    id,
    cwd,
    mode: entry.mode || existing.mode || 'pro',
    title,
    turns: turnCount,
    credits,
    createdAt: existing.createdAt || entry.ts,
    updatedAt: entry.ts,
  }, options);
}

function listSessions({ cwd = '', limit = 20, baseDir } = {}) {
  const all = readIndex({ baseDir });
  const targetCwd = cwd ? canonicalCwd(cwd) : '';
  const filtered = targetCwd
    ? all.filter((item) => item && item.cwd === targetCwd)
    : all;
  return filtered.slice(0, Math.max(1, limit));
}

function loadSession(idOrPrefix, options = {}) {
  const query = String(idOrPrefix || '').trim();
  if (!query) return null;
  const all = readIndex(options);
  const hit = all.find((item) => item.id === query)
    || all.find((item) => item.id.startsWith(query));
  const targetId = hit ? hit.id : sanitizeSessionId(query);
  const file = sessionFilePath(targetId, options);
  if (!fs.existsSync(file)) return null;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }

  let history = [];
  const diffs = [];
  let mode = (hit && hit.mode) || 'pro';
  let credits = 0;
  let cwd = (hit && hit.cwd) || '';

  for (const ev of events) {
    if (ev.cwd && !cwd) cwd = ev.cwd;
    if (ev.mode) mode = ev.mode;
    if (ev.type === 'compact' && ev.digest) {
      history = [{ role: 'assistant', content: String(ev.digest) }];
    } else if (ev.type === 'turn') {
      if (ev.user) history.push({ role: 'user', content: String(ev.user) });
      if (ev.assistant) history.push({ role: 'assistant', content: String(ev.assistant) });
      if (Number.isFinite(Number(ev.credits))) credits += Number(ev.credits);
      if (Array.isArray(ev.diffs)) diffs.push(...ev.diffs);
    }
  }

  return {
    id: targetId,
    cwd,
    mode,
    title: (hit && hit.title) || 'Resumed session',
    turns: Math.floor(history.length / 2),
    credits,
    history,
    diffs,
    events,
  };
}

function latestSessionForCwd(cwd, options = {}) {
  const sessions = listSessions({ cwd, limit: 1, baseDir: options.baseDir });
  if (!sessions.length) return null;
  return loadSession(sessions[0].id, options);
}

function exportSessionMarkdown(session) {
  if (!session) return '';
  const lines = [
    `# Atris Session: ${session.title || session.id}`,
    '',
    `- Session: \`${session.id}\``,
    session.cwd ? `- Workspace: \`${session.cwd}\`` : '',
    `- Mode: ${session.mode || 'pro'}`,
    `- Turns: ${session.turns || 0}`,
    '',
  ].filter((l) => l !== '');

  for (const msg of session.history || []) {
    lines.push(msg.role === 'user' ? '## User' : '## Assistant');
    lines.push('');
    lines.push(String(msg.content || '').trim());
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

module.exports = {
  createSessionId,
  appendSessionRecord,
  listSessions,
  loadSession,
  latestSessionForCwd,
  exportSessionMarkdown,
};
