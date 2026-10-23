// What your ai coding agents did in this folder today. Reads Claude Code
// and Codex session logs plus git, all local. Sends nothing anywhere and
// needs no atris/ folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATCH_FILE_RE = /\*\*\* (?:Add|Update|Delete) File: ([^\n\\"]+)/g;

function startOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // half-written last line while the agent is still running
    }
  }
  return rows;
}

// Only the first line, so a busy day of logs from other folders costs a
// small read each instead of the whole file.
function readFirstJsonLine(file, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total < maxBytes) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      total += n;
      if (nl !== -1) break;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function touchedSince(file, since) {
  try {
    return fs.statSync(file).mtimeMs >= since.getTime();
  } catch {
    return false;
  }
}

function isToday(row, since) {
  const t = Date.parse(row && row.timestamp);
  return Number.isFinite(t) && t >= since.getTime();
}

function realPrompt(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // harness wrappers and the project notes codex injects, not something
  // the person typed
  return !s.startsWith('<') && !s.startsWith('Caveat:') && !s.startsWith('# AGENTS.md instructions');
}

// Claude Code marks hook feedback, image notes, and the summary of a
// condensed chat on the row itself. None of those are asks.
function claudeHarnessRow(row) {
  return Boolean(row.isMeta || row.isCompactSummary || row.isVisibleInTranscriptOnly);
}

// A program started this chat (claude -p, the agent sdk), not a person
// typing in the app.
function claudeStartedByProgram(row) {
  return row.promptSource === 'sdk' || /^sdk/.test(String(row.entrypoint || ''));
}

// Codex helpers carry a parent link and belong to another session.
// codex exec is a program run; the desktop app and terminal app are chats.
function codexOrigin(meta) {
  const src = meta && meta.source;
  if (src && typeof src === 'object' && src.subagent) return 'helper';
  if ((meta && meta.originator) === 'codex_exec' || src === 'exec') return 'auto';
  return 'you';
}

// Claude Code keys each folder by its path with every non-alphanumeric
// character turned into a dash.
function claudeProjectDir(home, cwd, env = {}) {
  return path.join(claudeRoot(home, env), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

// Both tools let people move their log folder; look where they look.
function claudeRoot(home, env = {}) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

function codexRoot(home, env = {}) {
  return env.CODEX_HOME || path.join(home, '.codex');
}

function readClaude({ home, env, cwd, since }) {
  const dir = claudeProjectDir(home, cwd, env);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!touchedSince(file, since)) continue;
    const s = { tool: 'claude', origin: null, prompts: 0, files: new Set(), lastPrompt: '' };
    for (const row of readJsonl(file)) {
      if (!isToday(row, since) || row.isSidechain) continue;
      const content = row.message && row.message.content;
      if (row.type === 'user' && typeof content === 'string' && !claudeHarnessRow(row) && realPrompt(content)) {
        if (!s.origin) s.origin = claudeStartedByProgram(row) ? 'auto' : 'you';
        s.prompts += 1;
        s.lastPrompt = content.trim();
      }
      if (row.type === 'assistant' && Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_use' && CLAUDE_EDIT_TOOLS.has(c.name)) {
            const p = c.input && (c.input.file_path || c.input.notebook_path);
            if (p) s.files.add(p);
          }
        }
      }
    }
    if (!s.origin) s.origin = 'you';
    if (s.prompts || s.files.size) sessions.push(s);
  }
  return sessions;
}

function codexDayDirs(home, env, since, now) {
  const dirs = [];
  for (let d = new Date(since.getTime() - 24 * 60 * 60 * 1000); d <= now; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dirs.push(path.join(codexRoot(home, env), 'sessions', y, m, day));
  }
  return dirs;
}

function insideFolder(child, folder) {
  if (!child) return false;
  const rel = path.relative(folder, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readCodex({ home, env, cwd, since, now }) {
  const sessions = [];
  for (const dir of codexDayDirs(home, env, since, now)) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (!touchedSince(file, since)) continue;
      const first = readFirstJsonLine(file);
      if (first && first.type === 'session_meta' && !insideFolder(first.payload && first.payload.cwd, cwd)) continue;
      const rows = readJsonl(file);
      const meta = rows.find((r) => r.type === 'session_meta');
      if (!meta || !insideFolder(meta.payload && meta.payload.cwd, cwd)) continue;
      const s = { tool: 'codex', origin: codexOrigin(meta.payload), prompts: 0, files: new Set(), lastPrompt: '' };
      for (const row of rows) {
        if (!isToday(row, since) || row.type !== 'response_item') continue;
        const p = row.payload || {};
        if (p.type === 'message' && p.role === 'user') {
          const text = (p.content || []).map((c) => (c && c.text) || '').join('\n');
          if (realPrompt(text)) {
            s.prompts += 1;
            s.lastPrompt = text.trim();
          }
        }
        if (p.type === 'custom_tool_call' || p.type === 'function_call') {
          const raw = String(p.input || p.arguments || '');
          for (const m of raw.matchAll(PATCH_FILE_RE)) s.files.add(m[1].trim());
        }
      }
      if (s.prompts || s.files.size) sessions.push(s);
    }
  }
  return sessions;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout : null;
}

function readGit({ cwd, since }) {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) === null) return null;
  const log = git(cwd, ['log', `--since=${since.toISOString()}`, '--pretty=%s']) || '';
  const commits = log.split('\n').map((s) => s.trim()).filter(Boolean);
  const status = git(cwd, ['status', '--porcelain']) || '';
  const unsaved = status.split('\n').filter((l) => l.trim()).length;
  return { commits, unsaved };
}

function relativeTo(cwd, file) {
  const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
  const rel = path.relative(cwd, abs);
  return rel.startsWith('..') ? null : rel;
}

function topAreas(files, limit = 2) {
  const counts = new Map();
  for (const f of files) {
    const parts = f.split(path.sep);
    const area = parts.length > 1 ? parts[0] : 'the top folder';
    counts.set(area, (counts.get(area) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([a]) => a);
}

function buildAgentToday({ cwd = process.cwd(), home = os.homedir(), env = process.env, now = new Date() } = {}) {
  let folder = cwd;
  try {
    folder = fs.realpathSync(cwd);
  } catch {}
  const since = startOfToday(now);
  const sessions = [
    ...readClaude({ home, env, cwd: folder, since }),
    ...(folder !== cwd ? readClaude({ home, env, cwd, since }) : []),
    ...readCodex({ home, env, cwd: folder, since, now }),
  ];
  const files = new Set();
  for (const s of sessions) {
    for (const f of s.files) {
      const rel = relativeTo(folder, f);
      if (rel) files.add(rel);
    }
  }
  const gitInfo = readGit({ cwd: folder, since });
  const yours = sessions.filter((s) => s.origin === 'you');
  return {
    folder: path.basename(folder),
    since: since.toISOString(),
    sessions: {
      claude: yours.filter((s) => s.tool === 'claude').length,
      codex: yours.filter((s) => s.tool === 'codex').length,
    },
    prompts: yours.reduce((n, s) => n + s.prompts, 0),
    autoRuns: sessions.filter((s) => s.origin === 'auto').length,
    files: [...files].sort(),
    areas: topAreas([...files]),
    commits: gitInfo ? gitInfo.commits : [],
    unsaved: gitInfo ? gitInfo.unsaved : 0,
    isGit: Boolean(gitInfo),
  };
}

function hasActivity(t) {
  return Boolean(t && (ranAgent(t) || t.commits.length > 0));
}

function ranAgent(t) {
  return t.sessions.claude + t.sessions.codex + (t.autoRuns || 0) > 0;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function quote(text, width = 60) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > width ? `${s.slice(0, width - 3).trimEnd()}...` : s;
}

// Five lines at most, plain words, one idea each.
function renderAgentToday(t) {
  const lines = [`today in ${t.folder}`];
  const total = t.sessions.claude + t.sessions.codex;
  if (!hasActivity(t)) {
    lines.push('no ai sessions or saved changes here yet today.');
    lines.push('run this again after your agent does some work.');
    return lines.join('\n');
  }
  if (total) {
    const who = [
      t.sessions.claude ? `${plural(t.sessions.claude, 'session')} in claude code` : '',
      t.sessions.codex ? `${plural(t.sessions.codex, 'session')} in codex` : '',
    ].filter(Boolean).join(' and ');
    lines.push(`you asked your ai agent for ${plural(t.prompts, 'thing')}, across ${who}.`);
  }
  if (t.autoRuns) {
    lines.push(`your agents ${total ? 'also ' : ''}ran ${plural(t.autoRuns, 'job')} on their own.`);
  }
  if (t.files.length) {
    const where = t.files.length === 1 ? ` in ${t.areas[0]}` : `, mostly in ${t.areas.join(' and ')}`;
    lines.push(`it changed ${plural(t.files.length, 'file')}${where}.`);
  } else if (ranAgent(t)) {
    lines.push('it read and ran things but changed no files.');
  }
  const saved = t.commits.length
    ? `${plural(t.commits.length, 'change')} saved to git. latest: "${quote(t.commits[0])}"`
    : '';
  const unsaved = t.unsaved ? `${plural(t.unsaved, 'file')} changed but not saved to git yet.` : '';
  if (saved && unsaved && lines.length + 2 > 5) {
    // keep five lines: one git line says both
    lines.push(`${plural(t.commits.length, 'change')} saved to git, ${plural(t.unsaved, 'file')} not saved yet.`);
  } else {
    if (saved) lines.push(saved);
    if (unsaved) lines.push(unsaved);
    else if (t.isGit && t.files.length) lines.push('everything it changed is saved to git.');
  }
  return lines.slice(0, 5).join('\n');
}

module.exports = { buildAgentToday, renderAgentToday, hasActivity, ranAgent, claudeProjectDir, startOfToday, readFirstJsonLine };
