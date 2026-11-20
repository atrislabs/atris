'use strict';

// Custom reusable slash commands for ax, compatible with Claude Code and Atris.
// Discovers markdown command templates from:
//   ~/.claude/commands/*.md
//   ~/.atris/commands/*.md
//   <cwd>/.claude/commands/*.md
//   <cwd>/.atris/commands/*.md
// Project commands override user commands of the same name.
// Supports $ARGUMENTS and positional $1..$9 substitution.

const fs = require('fs');
const path = require('path');
const { stateHome } = require('./state-home');

function parseCommandMarkdown(raw, fallbackName) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  let description = '';
  let body = text.trim();

  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---\n', 4);
    if (end !== -1) {
      const fm = body.slice(4, end);
      body = body.slice(end + 5).trim();
      const descMatch = fm.match(/^description\s*:\s*(.+)$/mi);
      if (descMatch) {
        description = descMatch[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  if (!description) {
    const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) || '';
    description = firstLine.replace(/^#+\s*/, '').slice(0, 80) || `run ${fallbackName}`;
  }

  return { description, template: body };
}

function scanCommandDir(dir, sourceLabel, map, prefix = '') {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nextPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
      scanCommandDir(full, sourceLabel, map, nextPrefix);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const stem = entry.name.slice(0, -3).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    if (!stem) continue;
    const name = prefix ? `${prefix}:${stem}` : stem;
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const parsed = parseCommandMarkdown(raw, name);
      if (!parsed.template) continue;
      map.set(name, {
        name,
        slash: `/${name}`,
        description: parsed.description,
        template: parsed.template,
        source: sourceLabel,
        file: full,
      });
    } catch {}
  }
}

function listCustomSlashCommands(cwd = process.cwd(), options = {}) {
  const root = path.resolve(String(cwd || process.cwd()));
  const home = options.homeDir ? path.resolve(options.homeDir) : stateHome();
  const found = new Map();
  scanCommandDir(path.join(home, '.claude', 'commands'), 'user:claude', found);
  scanCommandDir(path.join(home, '.atris', 'commands'), 'user:atris', found);
  scanCommandDir(path.join(root, '.claude', 'commands'), 'project:claude', found);
  scanCommandDir(path.join(root, '.atris', 'commands'), 'project:atris', found);
  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function expandCustomSlashCommand(line, cwd = process.cwd(), options = {}) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [rawCmd, ...rest] = trimmed.split(/\s+/);
  const name = rawCmd.slice(1).toLowerCase();
  if (!name) return null;
  const commands = listCustomSlashCommands(cwd, options);
  const hit = commands.find((c) => c.name === name);
  if (!hit) return null;

  const argString = rest.join(' ').trim();
  let prompt = hit.template;
  if (prompt.includes('$ARGUMENTS')) {
    prompt = prompt.split('$ARGUMENTS').join(argString);
  } else if (argString) {
    prompt = `${prompt}\n\n${argString}`;
  }
  for (let i = 0; i < 9; i += 1) {
    const token = `$${i + 1}`;
    if (prompt.includes(token)) {
      prompt = prompt.split(token).join(rest[i] || '');
    }
  }
  return {
    command: hit,
    args: argString,
    prompt: prompt.trim(),
  };
}

module.exports = {
  listCustomSlashCommands,
  expandCustomSlashCommand,
};
