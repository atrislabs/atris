#!/usr/bin/env node
// Boot usage: which Atris boot files real agents open or act on.
// Reads local transcripts (Claude Code ~/.claude/projects, Codex
// ~/.codex/sessions) from the last N days, keeps sessions that ran in an Atris
// project, and counts the share of sessions whose tool calls touched each
// boot file or command. Counts sessions, not reads, so one chatty session
// cannot skew a row.
//
// usage: node scripts/boot-usage.js [--days 14] [--filter <cwd substring>] [--json out.json]
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const days = Number(flag('days', 14));
const filter = flag('filter', '');
const since = Date.now() - days * 86400000;

const PIECES = [
  ['CLAUDE.md (root)', /(^|[\s'"/])CLAUDE\.md\b/],
  ['AGENTS.md (root)', /(^|[\s'"/])AGENTS\.md\b/],
  ['atris/atris.md', /atris\/atris\.md/],
  ['`atris atris.md` boot command', /\batris atris\.md\b/],
  ['atris/MAP.md', /atris\/MAP\.md/],
  ['atris/PERSONA.md', /atris\/PERSONA\.md/],
  ['atris/FOR_AGENTS.md', /FOR_AGENTS\.md/],
  ['atris/GETTING_STARTED.md', /GETTING_STARTED\.md/],
  ['atris/CLAUDE.md', /atris\/CLAUDE\.md/],
  ['atris/TODO.md', /atris\/TODO\.md/],
  ['atris/logs (journal)', /atris\/logs\//],
  ['atris/wiki', /atris\/wiki\b/],
  ['atris/skills or .claude/skills files', /(atris|\.claude)\/skills\//],
  ['atris/team/*/MEMBER.md', /atris\/team\/[^/\s]+\/MEMBER\.md/],
  ['atris/team/*/MISSION.md', /atris\/team\/[^/\s]+\/MISSION\.md/],
  ['atris/features', /atris\/features\//],
  ['`atris guide`', /\batris guide\b/],
  ['`atris task ...`', /\batris task\b/],
  ['`atris mission ...`', /\batris mission\b/],
  ['any `atris` command', /(^|[;&|\s(])atris\s+[a-z]/],
];

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch {} }
  }
  return out;
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function claudeSession(file) {
  let cwd = '';
  const calls = [];
  const skills = [];
  for (const e of readLines(file)) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (e.type !== 'assistant' || !e.message) continue;
    for (const c of e.message.content || []) {
      if (c.type !== 'tool_use') continue;
      const inp = c.input || {};
      if (c.name === 'Skill') skills.push(String(inp.skill || ''));
      calls.push(`${c.name} ${inp.command || ''} ${inp.file_path || ''} ${inp.path || ''} ${inp.pattern || ''}`);
    }
  }
  return { engine: 'claude', cwd, calls, skills };
}

function codexSession(file) {
  let cwd = '';
  const calls = [];
  for (const e of readLines(file)) {
    const p = e.payload || {};
    if (!cwd && p.cwd) cwd = p.cwd;
    if (e.type === 'response_item' && ['function_call', 'local_shell_call', 'custom_tool_call'].includes(p.type)) {
      calls.push(`${p.name || p.type} ${p.arguments || JSON.stringify(p.action || p.input || '')}`);
    }
  }
  return { engine: 'codex', cwd, calls, skills: [] };
}

function isAtrisProject(cwd) {
  if (!cwd) return false;
  try { return fs.existsSync(path.join(cwd, 'atris')) || /agent-worktrees|member-lab/.test(cwd); } catch { return false; }
}

function kindOf(cwd) {
  if (/\.agent-worktrees|\.atris\/worktrees/.test(cwd)) return 'member worker';
  return 'direct session';
}

const sessions = [];
for (const f of walk(path.join(os.homedir(), '.claude', 'projects'))) { try { sessions.push(claudeSession(f)); } catch {} }
for (const f of walk(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'))) { try { sessions.push(codexSession(f)); } catch {} }

const groups = {};
for (const s of sessions) {
  if (!s.calls.length || (filter && !s.cwd.includes(filter)) || !isAtrisProject(s.cwd)) continue;
  const key = `${s.engine}, ${kindOf(s.cwd)}`;
  const g = groups[key] || (groups[key] = { sessions: 0, tool_calls: 0, pieces: {}, skills: {} });
  g.sessions++;
  g.tool_calls += s.calls.length;
  const joined = s.calls.join('\n');
  for (const [name, re] of PIECES) if (re.test(joined)) g.pieces[name] = (g.pieces[name] || 0) + 1;
  for (const sk of new Set(s.skills)) g.skills[sk] = (g.skills[sk] || 0) + 1;
}

if (flag('json')) fs.writeFileSync(flag('json'), `${JSON.stringify({ days, generated: new Date().toISOString(), groups }, null, 2)}\n`);
for (const [key, g] of Object.entries(groups).sort()) {
  console.log(`\n${key}: ${g.sessions} sessions, ${g.tool_calls} tool calls`);
  for (const [name] of PIECES) {
    const n = g.pieces[name] || 0;
    console.log(`  ${String(n).padStart(5)}  ${(100 * n / g.sessions).toFixed(1).padStart(5)}%  ${name}`);
  }
  const top = Object.entries(g.skills).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length) console.log(`  skills invoked (sessions): ${top.map(([s, n]) => `${s}=${n}`).join(', ')}`);
}
