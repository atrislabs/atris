'use strict';

// Workspace context helpers for ax:
// - @file / @file:start-end / @dir/ inline mention expansion
// - @path Tab completion
// - Project memory loader (AGENTS.md, CLAUDE.md, ATRIS.md, atris/MAP.md)
// - /compact [focus] structured history compaction

const fs = require('fs');
const path = require('path');

const IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
]);

const PROJECT_MEMORY_CANDIDATES = [
  'CLAUDE.md',
  'AGENTS.md',
  'ATRIS.md',
  'atris/MAP.md',
];

const MAX_ATTACHMENT_BYTES = 24 * 1024;
const MAX_TOTAL_ATTACHMENT_CHARS = 48 * 1024;
const MAX_MEMORY_CHARS = 6000;

function safeResolveInWorkspace(cwd, rawTarget) {
  const root = path.resolve(String(cwd || process.cwd()));
  const target = String(rawTarget || '').trim();
  if (!target || target.startsWith('/') || target.includes('..')) return null;
  const full = path.resolve(root, target);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { root, full, rel: rel.split(path.sep).join('/') };
}

function expandAtMentions(message, cwd = process.cwd()) {
  const raw = String(message || '');
  const mentionRe = /(^|[\s(])@([a-zA-Z0-9._/-]+(?::\d+(?:-\d+)?)?)/g;
  const attachments = [];
  const seen = new Set();
  let totalChars = 0;

  let match;
  while ((match = mentionRe.exec(raw)) !== null) {
    const token = match[2];
    const [rawPath, rangePart] = token.split(':');
    const cleanPath = rawPath.replace(/[.,;!?)]+$/, '');
    if (!cleanPath || seen.has(token)) continue;
    const resolved = safeResolveInWorkspace(cwd, cleanPath);
    if (!resolved || !fs.existsSync(resolved.full)) continue;
    let stat;
    try {
      stat = fs.statSync(resolved.full);
    } catch {
      continue;
    }

    seen.add(token);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved.full)
        .filter((name) => !IGNORED_NAMES.has(name))
        .sort()
        .slice(0, 60);
      const body = entries.join('\n');
      if (totalChars + body.length > MAX_TOTAL_ATTACHMENT_CHARS) continue;
      totalChars += body.length;
      attachments.push({
        token: `@${token}`,
        path: `${resolved.rel}/`,
        kind: 'dir',
        lines: entries.length,
        content: body,
      });
      continue;
    }

    if (!stat.isFile()) continue;
    let buf;
    try {
      buf = fs.readFileSync(resolved.full);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    const text = buf.slice(0, MAX_ATTACHMENT_BYTES).toString('utf8');
    const allLines = text.split(/\r?\n/);
    let start = 1;
    let end = allLines.length;
    if (rangePart) {
      const [s, e] = rangePart.split('-').map((n) => Number(n));
      if (Number.isInteger(s) && s >= 1) {
        start = Math.min(s, allLines.length);
        end = Number.isInteger(e) && e >= start ? Math.min(e, allLines.length) : start;
      }
    }
    const snippet = allLines.slice(start - 1, end).map((line, idx) => `${start + idx}: ${line}`).join('\n');
    if (totalChars + snippet.length > MAX_TOTAL_ATTACHMENT_CHARS) continue;
    totalChars += snippet.length;
    attachments.push({
      token: `@${token}`,
      path: rangePart ? `${resolved.rel}:${start}-${end}` : resolved.rel,
      kind: 'file',
      lines: Math.max(0, end - start + 1),
      content: snippet,
    });
  }

  if (!attachments.length) {
    return { prompt: raw, attachments: [] };
  }

  const block = attachments
    .map((item) => `--- ${item.path} (${item.kind === 'dir' ? `${item.lines} entries` : `${item.lines} lines`}) ---\n${item.content}`)
    .join('\n\n');

  return {
    prompt: `${raw}\n\n[Attached workspace context]\n${block}`,
    attachments,
  };
}

function completeAtPath(line, cwd = process.cwd()) {
  const text = String(line || '');
  const match = text.match(/(^|\s)@([^\s]*)$/);
  if (!match) return null;
  const prefix = match[2] || '';
  const root = path.resolve(String(cwd || process.cwd()));
  const slashIdx = prefix.lastIndexOf('/');
  const dirRel = slashIdx >= 0 ? prefix.slice(0, slashIdx) : '';
  const basePrefix = slashIdx >= 0 ? prefix.slice(slashIdx + 1) : prefix;
  const scanDir = dirRel ? path.resolve(root, dirRel) : root;
  const relCheck = path.relative(root, scanDir);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return [[], `@${prefix}`];

  let entries;
  try {
    entries = fs.readdirSync(scanDir, { withFileTypes: true });
  } catch {
    return [[], `@${prefix}`];
  }

  const hits = [];
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    if (!entry.name.toLowerCase().startsWith(basePrefix.toLowerCase())) continue;
    const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
    hits.push(`@${rel}${entry.isDirectory() ? '/' : ''}`);
  }
  hits.sort();
  return [hits.slice(0, 30), `@${prefix}`];
}

function loadProjectMemory(cwd = process.cwd()) {
  const root = path.resolve(String(cwd || process.cwd()));
  const found = [];
  const chunks = [];
  let used = 0;

  for (const rel of PROJECT_MEMORY_CANDIDATES) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size === 0) continue;
      const raw = fs.readFileSync(full, 'utf8').trim();
      if (!raw) continue;
      found.push(rel);
      const budget = Math.min(2000, MAX_MEMORY_CHARS - used);
      if (budget > 200) {
        const excerpt = raw.length > budget ? `${raw.slice(0, budget)}\n...` : raw;
        chunks.push(`# ${rel}\n${excerpt}`);
        used += excerpt.length;
      }
    } catch {}
  }

  return {
    files: found,
    summary: chunks.join('\n\n'),
  };
}

function compactConversationHistory(history = [], focus = '') {
  const items = Array.isArray(history) ? history.filter((m) => m && m.content) : [];
  const beforeChars = items.reduce((sum, m) => sum + String(m.content || '').length, 0);
  const beforeTokens = Math.ceil(beforeChars / 4);
  if (items.length === 0) {
    return {
      compactedTurns: 0,
      beforeTokens: 0,
      afterTokens: 0,
      digest: '',
      nextHistory: [],
    };
  }

  const lines = [];
  if (focus) lines.push(`Focus: ${String(focus).trim()}`);
  for (const msg of items) {
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    const oneLine = String(msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (oneLine) lines.push(`- ${label}: ${oneLine}`);
  }
  const digest = [
    '[Compacted conversation summary]',
    ...lines.slice(-20),
  ].join('\n');
  const afterTokens = Math.ceil(digest.length / 4);

  return {
    compactedTurns: Math.max(1, Math.floor(items.length / 2)),
    beforeTokens,
    afterTokens,
    digest,
    nextHistory: [{ role: 'assistant', content: digest }],
  };
}

module.exports = {
  expandAtMentions,
  completeAtPath,
  loadProjectMemory,
  compactConversationHistory,
};
