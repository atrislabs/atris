'use strict';

// atris sentinel agents: a fixed-rule check of a coding agent setup. No
// model, no network, no cost. It reads the files that tell an agent what to
// do and what it may run, and flags five kinds of risk:
//
//   secrets       keys pasted into instruction, settings, hook or MCP files
//   permissions   settings that let the agent run any command or skip asking
//   hooks         hooks that download code and run it
//   mcp           MCP servers launched from unpinned packages or plain http
//   hidden        invisible characters, override phrases and instructions
//                 tucked inside HTML comments in instruction or skill text
//
// Findings never hold a secret value. Locations are file:line on this
// machine; only fixed sentences leave in events (lib/sentinel-events.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const events = require('./sentinel-events');

const AREAS = ['secrets', 'permissions', 'hooks', 'mcp', 'hidden'];
const AREA_LABEL = {
  secrets: 'secrets in agent files',
  permissions: 'agent permissions',
  hooks: 'hooks',
  mcp: 'mcp servers',
  hidden: 'hidden instructions',
};
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 4000;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.trash', '.Trash']);

// ---------------------------------------------------------------- files

function walk(dir, { exts = null, limit = MAX_FILES } = {}, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, { exts, limit }, out); continue; }
    if (!e.isFile()) continue;
    if (exts && !exts.some((x) => e.name.toLowerCase().endsWith(x))) continue;
    out.push(p);
  }
  return out;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readText(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch { return null; }
}

const INSTRUCTION_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.windsurfrules'];
const TEXT_EXTS = ['.md', '.mdc', '.txt', '.markdown'];

// Every file this check reads, each with a role. role decides which rules
// run on it.
function collectTargets(root, { home = false, homeDir = os.homedir() } = {}) {
  const t = [];
  const add = (file, role, scope) => { if (isFile(file)) t.push({ file, role, scope }); };
  const addDir = (dir, role, scope, exts) => { for (const f of walk(dir, { exts })) t.push({ file: f, role, scope }); };
  const project = (base, scope) => {
    for (const n of INSTRUCTION_NAMES) add(path.join(base, n), 'instructions', scope);
    add(path.join(base, '.claude', 'CLAUDE.md'), 'instructions', scope);
    add(path.join(base, '.github', 'copilot-instructions.md'), 'instructions', scope);
    add(path.join(base, 'atris', 'CLAUDE.md'), 'instructions', scope);
    add(path.join(base, '.claude', 'settings.json'), 'claude-settings', scope);
    add(path.join(base, '.claude', 'settings.local.json'), 'claude-settings', scope);
    addDir(path.join(base, '.claude', 'hooks'), 'hook-script', scope);
    addDir(path.join(base, '.claude', 'skills'), 'skill', scope, TEXT_EXTS);
    addDir(path.join(base, '.claude', 'commands'), 'skill', scope, TEXT_EXTS);
    addDir(path.join(base, '.claude', 'agents'), 'skill', scope, TEXT_EXTS);
    addDir(path.join(base, 'atris', 'skills'), 'skill', scope, TEXT_EXTS);
    addDir(path.join(base, '.cursor', 'rules'), 'instructions', scope, TEXT_EXTS);
    for (const rel of ['.mcp.json', path.join('.cursor', 'mcp.json'), path.join('.vscode', 'mcp.json'), path.join('.gemini', 'settings.json')]) add(path.join(base, rel), 'mcp-config', scope);
  };
  project(path.resolve(root), 'project');
  if (home) {
    const h = homeDir;
    const claude = path.join(h, '.claude');
    add(path.join(claude, 'CLAUDE.md'), 'instructions', 'home');
    add(path.join(claude, 'settings.json'), 'claude-settings', 'home');
    add(path.join(claude, 'settings.local.json'), 'claude-settings', 'home');
    addDir(path.join(claude, 'hooks'), 'hook-script', 'home');
    addDir(path.join(claude, 'skills'), 'skill', 'home', TEXT_EXTS);
    addDir(path.join(claude, 'commands'), 'skill', 'home', TEXT_EXTS);
    addDir(path.join(claude, 'agents'), 'skill', 'home', TEXT_EXTS);
    add(path.join(h, '.claude.json'), 'claude-user-config', 'home');
    const codex = path.join(h, '.codex');
    add(path.join(codex, 'config.toml'), 'codex-config', 'home');
    add(path.join(codex, 'AGENTS.md'), 'instructions', 'home');
    addDir(path.join(codex, 'skills'), 'skill', 'home', TEXT_EXTS);
    addDir(path.join(codex, 'prompts'), 'skill', 'home', TEXT_EXTS);
    add(path.join(h, '.gemini', 'settings.json'), 'mcp-config', 'home');
    add(path.join(h, '.gemini', 'GEMINI.md'), 'instructions', 'home');
    add(path.join(h, '.cursor', 'mcp.json'), 'mcp-config', 'home');
  }
  const seen = new Set();
  return t.filter((x) => { const k = path.resolve(x.file); if (seen.has(k)) return false; seen.add(k); return true; });
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

// ---------------------------------------------------------------- rules

// The fixed sentences. Each rule id maps to the words a person sees and the
// words that leave in an event. Never a value from the file.
const RULES = {
  'secret-in-file': { area: 'secrets', severity: 'critical', title: 'A secret key is pasted into one of your agent files.', fix: 'Move the key into an environment variable or a secrets manager. Then rotate it since agents and logs may have read it.' },
  'secret-in-env-block': { area: 'secrets', severity: 'high', title: 'An MCP or agent config holds a secret key as plain text.', fix: 'Reference the key from an environment variable instead of pasting it. Then rotate it.' },
  'allow-any-shell': { area: 'permissions', severity: 'high', title: 'Your agent may run any shell command without asking.', fix: 'Replace the open shell rule with the few commands the agent needs.' },
  'bypass-permissions': { area: 'permissions', severity: 'high', title: 'Your agent settings skip every approval prompt.', fix: 'Set the default permission mode back to asking and allow only the commands you trust.' },
  'skip-danger-prompt': { area: 'permissions', severity: 'medium', title: 'Your agent settings hide the warning for the mode that skips approvals.', fix: 'Remove the setting that silences the skip approvals warning.' },
  'skip-approval-flag': { area: 'permissions', severity: 'high', title: 'An agent is started with a flag that skips every approval.', fix: 'Drop the skip approvals flag and allow only the commands the agent needs.' },
  'codex-never-ask': { area: 'permissions', severity: 'high', title: 'Codex is set to run commands without ever asking you.', fix: 'Set the Codex approval policy to on request or untrusted.' },
  'codex-full-access': { area: 'permissions', severity: 'high', title: 'Codex is set to run with full disk and network access and no sandbox.', fix: 'Use the workspace write sandbox mode unless a task truly needs more.' },
  'hook-download-run': { area: 'hooks', severity: 'critical', title: 'A hook downloads code from the internet and runs it.', fix: 'Save the script into your project after reading it and point the hook at that copy.' },
  'hook-eval-fetched': { area: 'hooks', severity: 'critical', title: 'A hook runs code it fetched from the internet through eval.', fix: 'Save the script into your project after reading it and run that copy instead.' },
  'mcp-unpinned': { area: 'mcp', severity: 'medium', title: 'An MCP server starts from a package with no pinned version.', fix: 'Pin the package to an exact version so a bad release cannot reach your agent.' },
  'mcp-plain-http': { area: 'mcp', severity: 'high', title: 'An MCP server is reached over plain http.', fix: 'Use an https address for remote MCP servers.' },
  'hidden-characters': { area: 'hidden', severity: 'high', title: 'Instruction text holds invisible characters that can hide commands.', fix: 'Delete the invisible characters and read the file again to see what it really says.' },
  'override-phrase': { area: 'hidden', severity: 'high', title: 'Instruction text tells the agent to ignore its other instructions.', fix: 'Remove the override phrase and check who added it.' },
  'override-phrase-quoted': { area: 'hidden', severity: 'low', title: 'Instruction text quotes a phrase that tells an agent to ignore its instructions.', fix: 'Check that the quote is only an example. Remove it if the file is not about prompt attacks.' },
  'hidden-comment': { area: 'hidden', severity: 'medium', title: 'Instruction text hides directions for the agent inside an HTML comment.', fix: 'Move the comment into visible text or delete it so people see what the agent reads.' },
};

// Secret check: the review scanner's rules and its placeholder filter.
function secretHits(text) {
  let scan;
  try { scan = require('./security-scan'); } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const f of scan.scanLine(line) || []) {
      if (f.cat !== 'secret') continue;
      out.push({ line: i + 1, rule: f.rule });
      break;
    }
  });
  return out;
}

// "API_KEY": "abc..." in JSON, and API_KEY = "abc..." in TOML. Only keys
// whose name says secret, and only values that look real (not $VAR, not a
// placeholder, not short).
const SECRET_KEY_NAME = /(?:^|_|-)(?:api[_-]?key|key|token|secret|password|passwd|pat|credential|credentials|auth)(?:$|_|-)/i;
function envBlockHits(text) {
  let scan;
  try { scan = require('./security-scan'); } catch { return []; }
  const out = [];
  const re = /["']?([A-Za-z_][A-Za-z0-9_.-]{1,80})["']?\s*[:=]\s*"([^"\n]{12,400})"/g;
  let m;
  while ((m = re.exec(text))) {
    const [, key, value] = m;
    if (!SECRET_KEY_NAME.test(key)) continue;
    if (/^\$|\$\{|^<|^\{\{|^env:|^op:\/\/|^\/|^~|^https?:\/\//i.test(value)) continue;
    if (/\s/.test(value)) continue;
    const q = scan.secretQuality(value, {}, m[0]);
    if (!q.ok) continue;
    out.push({ line: lineOf(text, m.index) });
  }
  return out;
}

// Download piped into a shell or interpreter, process substitution of a
// download, and eval of fetched content.
const DOWNLOAD = '(?:curl|wget|fetch|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\\b';
const DOWNLOAD_RUN = [
  new RegExp(`${DOWNLOAD}[^\\n|;&]*\\|\\s*(?:sudo\\s+)?(?:env\\s+)?(?:ba|z|da|k|fi)?sh\\b`, 'i'),
  new RegExp(`${DOWNLOAD}[^\\n|;&]*\\|\\s*(?:sudo\\s+)?(?:python[0-9.]*|node|perl|ruby|php|iex|Invoke-Expression)\\b`, 'i'),
  new RegExp(`(?:ba|z|k)?sh\\s+<\\(\\s*${DOWNLOAD}`, 'i'),
  new RegExp(`(?:ba|z|k)?sh\\s+-c\\s+["']?\\$\\(\\s*${DOWNLOAD}`, 'i'),
  new RegExp(`source\\s+<\\(\\s*${DOWNLOAD}`, 'i'),
];
const EVAL_FETCHED = [
  new RegExp(`\\beval\\s+["']?\\$\\(\\s*${DOWNLOAD}`, 'i'),
  new RegExp(`\\beval\\s+["']?\`\\s*${DOWNLOAD}`, 'i'),
  /\beval\s*\(\s*(?:await\s+)?\(?\s*(?:await\s+)?fetch\s*\(/i,
  /\bexec\s*\(\s*(?:urllib\.request\.)?urlopen\s*\(/i,
  /\bexec\s*\(\s*requests\.get\s*\(/i,
];

function downloadRunHits(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(?:#|\/\/)/.test(line)) return;
    if (DOWNLOAD_RUN.some((re) => re.test(line))) out.push({ line: i + 1, rule: 'hook-download-run' });
    else if (EVAL_FETCHED.some((re) => re.test(line))) out.push({ line: i + 1, rule: 'hook-eval-fetched' });
  });
  return out;
}

const SKIP_FLAGS = /(?:^|\s)(?:--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo|--permission-mode[ =]bypassPermissions|--approval-mode[ =]yolo|--allow-dangerously-skip-permissions)(?=\s|$|["'])/;

function flagHits(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(?:#|\/\/)/.test(line)) return;
    if (SKIP_FLAGS.test(line)) out.push({ line: i + 1 });
  });
  return out;
}

// Invisible characters: zero-width, bidirectional controls and Unicode tag
// characters. A zero-width joiner between two emoji is normal and allowed.
const INVISIBLE = /[​‌‎‏⁠-⁤‪-‮⁦-⁩﻿]|‍|\uDB40[\uDC00-\uDC7F]/g;
function invisibleHits(text) {
  const out = [];
  const seen = new Set();
  let m;
  INVISIBLE.lastIndex = 0;
  while ((m = INVISIBLE.exec(text))) {
    const i = m.index;
    if (m[0] === '﻿' && i === 0) continue; // byte order mark
    if (m[0] === '‍') {
      const before = text.charCodeAt(i - 1);
      const after = text.charCodeAt(i + 1);
      const emojiish = (c) => (c >= 0xD800 && c <= 0xDFFF) || (c >= 0x2600 && c <= 0x27BF) || c === 0xFE0F;
      if (emojiish(before) && emojiish(after)) continue;
    }
    const line = lineOf(text, i);
    if (!seen.has(line)) { seen.add(line); out.push({ line }); }
  }
  return out;
}

const OVERRIDE = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|every\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|original|system|other)\s+(?:instructions?|prompts?|rules|directions|guidelines|messages)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak|god)\s+mode\b/i,
  // Secrecy, not ordinary guidance: "do not tell the user about this", but
  // not "do not tell the user to restart".
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|show)\s+the\s+user\s+(?:about|that|what|anything|this|you\b|we\b)/i,
  /\b(?:do\s+not|don't|never)\s+mention\s+(?:this|it)\s+to\s+the\s+user\b/i,
  /\bwithout\s+(?:telling|informing|alerting)\s+the\s+user\b/i,
  /\bhide\s+this\s+from\s+the\s+user\b/i,
  /\bnew\s+system\s+prompt\s*:/i,
];

function overrideHits(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const re of OVERRIDE) {
      const m = line.match(re);
      if (!m) continue;
      // Quoted or in code: a doc about prompt attacks, most likely.
      const at = m.index;
      const before = line.slice(0, at);
      const quoted = /["'`“‘]\s*$/.test(before) || (before.split('`').length % 2 === 0) || /^\s*>/.test(line);
      out.push({ line: i + 1, rule: quoted ? 'override-phrase-quoted' : 'override-phrase' });
      break;
    }
  });
  return out;
}

const COMMENT_DIRECTIVE = /\b(?:ignore\s+(?:the|all|any|previous|prior|above)|disregard|secretly|silently|do\s+not\s+tell|don't\s+tell|without\s+telling|curl|wget|exfiltrate|send\s+(?:the|all|any|your)\s+\w+\s+to|system\s+prompt|you\s+are\s+(?:now|an?|the)|you\s+must|always\s+run|run\s+the\s+following|execute\s+(?:the|this))\b/i;
function hiddenCommentHits(text) {
  const out = [];
  // Comments inside fenced code blocks are examples, not hidden text.
  const fences = [];
  const fenceRe = /^(?:```|~~~)/gm;
  let f;
  let open = null;
  while ((f = fenceRe.exec(text))) {
    if (open === null) open = f.index;
    else { fences.push([open, f.index]); open = null; }
  }
  if (open !== null) fences.push([open, text.length]);
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(text))) {
    if (fences.some(([a, b]) => m.index > a && m.index < b)) continue;
    const body = m[1].trim();
    if (body.split(/\s+/).filter(Boolean).length < 6) continue;
    if (!COMMENT_DIRECTIVE.test(body)) continue;
    out.push({ line: lineOf(text, m.index) });
  }
  return out;
}

// ---------------------------------------------------------------- configs

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function settingsChecks(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  const perms = json.permissions || {};
  const allow = Array.isArray(perms.allow) ? perms.allow : [];
  for (const rule of allow) {
    const r = String(rule).replace(/\s+/g, '');
    if (r === 'Bash' || r === 'Bash(*)' || r === 'Bash(:*)' || r === 'Bash(**)' || r === '*') { out.push({ rule: 'allow-any-shell', key: `allow:${r}` }); break; }
  }
  if (perms.defaultMode === 'bypassPermissions') out.push({ rule: 'bypass-permissions', key: 'defaultMode' });
  if (json.skipDangerousModePermissionPrompt === true) out.push({ rule: 'skip-danger-prompt', key: 'skipDangerousModePermissionPrompt' });
  return out;
}

function hookCommands(json) {
  const cmds = [];
  const hooks = json && json.hooks;
  if (!hooks || typeof hooks !== 'object') return cmds;
  for (const groups of Object.values(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of (g && Array.isArray(g.hooks)) ? g.hooks : []) if (h && typeof h.command === 'string') cmds.push(h.command);
    }
  }
  return cmds;
}

function mcpServersOf(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  const pull = (obj, where) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [name, cfg] of Object.entries(obj)) if (cfg && typeof cfg === 'object') out.push({ name, cfg, where });
  };
  pull(json.mcpServers, 'mcpServers');
  pull(json.servers, 'servers'); // .vscode/mcp.json
  if (json.projects && typeof json.projects === 'object') {
    for (const [proj, p] of Object.entries(json.projects)) if (p && p.mcpServers) pull(p.mcpServers, `projects:${proj}`);
  }
  return out;
}

// True when an npm/pypi package spec carries an exact version.
function pinnedSpec(spec, runner) {
  const s = String(spec || '');
  if (!s || /^[./~]/.test(s) || /^(?:file|git\+|https?):/i.test(s)) return true; // local path or explicit source
  if (runner === 'uvx' || runner === 'pipx') return /==\s*\d/.test(s) || /@\d/.test(s);
  const at = s.lastIndexOf('@');
  if (at <= 0) return false;
  const v = s.slice(at + 1);
  return /^\d+\.\d+\.\d+/.test(v);
}

function packageArg(args, runner) {
  const list = (Array.isArray(args) ? args : []).map(String);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '-p' || a === '--package' || a === '--from') return list[i + 1] || '';
    if (a.startsWith('--package=') || a.startsWith('--from=')) return a.slice(a.indexOf('=') + 1);
    if (a.startsWith('-')) continue;
    if (runner === 'pnpm' || runner === 'bun' || runner === 'yarn') { if (a === 'dlx' || a === 'x') continue; }
    return a;
  }
  return '';
}

function mcpChecks(server) {
  const out = [];
  const cfg = server.cfg;
  const cmdRaw = String(cfg.command || '');
  const cmd = path.basename(cmdRaw.split(/\s+/)[0] || '');
  let args = Array.isArray(cfg.args) ? cfg.args : [];
  if (!args.length && /\s/.test(cmdRaw)) args = cmdRaw.split(/\s+/).slice(1);
  const runners = { npx: 'npx', bunx: 'bunx', uvx: 'uvx', pipx: 'pipx' };
  let runner = runners[cmd] || null;
  if (!runner && (cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') && args.some((a) => a === 'dlx' || a === 'x')) runner = cmd;
  if (runner) {
    const spec = runner === 'pipx' ? packageArg(args.filter((a) => a !== 'run'), runner) : packageArg(args, runner);
    if (spec && !pinnedSpec(spec, runner)) out.push({ rule: 'mcp-unpinned', key: `${server.name}:${spec.replace(/@[^@/]*$/, '')}` });
  }
  const url = String(cfg.url || cfg.serverUrl || cfg.httpUrl || '');
  if (/^http:\/\//i.test(url)) {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (!/^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i.test(host)) out.push({ rule: 'mcp-plain-http', key: `${server.name}:${host}` });
  }
  // mcp-remote style: npx mcp-remote http://...
  for (const a of args.map(String)) {
    if (/^http:\/\//i.test(a)) {
      let host = '';
      try { host = new URL(a).hostname; } catch {}
      if (host && !/^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/i.test(host)) out.push({ rule: 'mcp-plain-http', key: `${server.name}:${host}` });
    }
  }
  const all = [cmdRaw, ...args.map(String)].join(' ');
  if (SKIP_FLAGS.test(` ${all} `)) out.push({ rule: 'skip-approval-flag', key: `${server.name}:flag` });
  return out;
}

// A small TOML reader for ~/.codex/config.toml: top-level keys, and
// [mcp_servers.<name>] tables with command, args and url.
function codexChecks(text) {
  const out = [];
  let table = '';
  const servers = {};
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) return;
    const t = line.match(/^\[([^\]]+)\]$/);
    if (t) { table = t[1].trim(); return; }
    const kv = line.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/);
    if (!kv) return;
    const key = kv[1].replace(/"/g, '');
    const value = kv[2].trim();
    const str = (value.match(/^"([^"]*)"$/) || value.match(/^'([^']*)'$/) || [])[1];
    const inProfile = table === '' || /^profiles\./.test(table);
    if (inProfile && key === 'approval_policy' && str === 'never') out.push({ rule: 'codex-never-ask', line: i + 1, key: `${table}:approval_policy` });
    if (inProfile && key === 'sandbox_mode' && str === 'danger-full-access') out.push({ rule: 'codex-full-access', line: i + 1, key: `${table}:sandbox_mode` });
    const ms = table.match(/^mcp_servers\.("?)([^"]+)\1$/);
    if (ms) {
      const name = ms[2];
      servers[name] = servers[name] || { name, cfg: {}, line: i + 1 };
      if (key === 'command' && str != null) servers[name].cfg.command = str;
      if (key === 'url' && str != null) servers[name].cfg.url = str;
      if (key === 'args') servers[name].cfg.args = (value.match(/"([^"]*)"|'([^']*)'/g) || []).map((s) => s.slice(1, -1));
    }
  });
  for (const s of Object.values(servers)) for (const f of mcpChecks(s)) out.push({ ...f, line: s.line });
  return out;
}

function jsonKeyLine(text, needle) {
  const i = text.indexOf(needle);
  return i === -1 ? 1 : lineOf(text, i);
}

// ---------------------------------------------------------------- run

function checkFile(target) {
  const text = readText(target.file);
  if (text == null) return [];
  const found = [];
  const push = (rule, line, key = '') => found.push({ rule, line, key, file: target.file, scope: target.scope, role: target.role });
  const role = target.role;
  const textual = role === 'instructions' || role === 'skill';

  // Secrets: every file except the big user config, where only MCP env
  // blocks are read (it holds account state, not agent instructions).
  if (role !== 'claude-user-config') for (const h of secretHits(text)) push('secret-in-file', h.line, `secret:${h.line}`);
  if (role === 'mcp-config' || role === 'claude-settings' || role === 'codex-config' || role === 'claude-user-config') {
    const flagged = new Set(found.filter((f) => f.rule === 'secret-in-file').map((f) => f.line));
    if (role === 'claude-user-config') {
      const json = parseJson(text);
      for (const s of mcpServersOf(json)) {
        const envText = JSON.stringify({ env: s.cfg.env || {}, headers: s.cfg.headers || {} }, null, 1);
        if (envBlockHits(envText).length || secretHits(envText).length) push('secret-in-env-block', jsonKeyLine(text, `"${s.name}"`), `env:${s.where}:${s.name}`);
      }
    } else {
      for (const h of envBlockHits(text)) if (!flagged.has(h.line)) push('secret-in-env-block', h.line, `env:${h.line}`);
    }
  }

  if (role === 'claude-settings') {
    const json = parseJson(text);
    for (const c of settingsChecks(json)) push(c.rule, jsonKeyLine(text, c.rule === 'allow-any-shell' ? '"allow"' : `"${c.key}"`), c.key);
    for (const cmd of hookCommands(json)) {
      for (const h of downloadRunHits(cmd)) push(h.rule, jsonKeyLine(text, cmd.slice(0, 40)), `hook:${cmd}`);
      if (SKIP_FLAGS.test(` ${cmd} `)) push('skip-approval-flag', jsonKeyLine(text, cmd.slice(0, 40)), `hookflag:${cmd}`);
    }
    for (const s of mcpServersOf(json)) for (const c of mcpChecks(s)) push(c.rule, jsonKeyLine(text, `"${s.name}"`), c.key);
  }
  if (role === 'hook-script') {
    for (const h of downloadRunHits(text)) push(h.rule, h.line, `script:${h.line}`);
    for (const h of flagHits(text)) push('skip-approval-flag', h.line, `scriptflag:${h.line}`);
  }
  if (role === 'mcp-config' || role === 'claude-user-config') {
    const json = parseJson(text);
    for (const s of mcpServersOf(json)) for (const c of mcpChecks(s)) push(c.rule, jsonKeyLine(text, `"${s.name}"`), `${s.where}:${c.key}`);
  }
  if (role === 'codex-config') for (const c of codexChecks(text)) push(c.rule, c.line, c.key);
  if (textual) {
    for (const h of invisibleHits(text)) push('hidden-characters', h.line, `inv:${h.line}`);
    for (const h of overrideHits(text)) push(h.rule, h.line, `ovr:${h.line}`);
    for (const h of hiddenCommentHits(text)) push('hidden-comment', h.line, `cmt:${h.line}`);
  }
  return found;
}

function displayPath(file, root, homeDir) {
  const abs = path.resolve(file);
  const r = path.resolve(root);
  if (abs.startsWith(`${r}${path.sep}`)) return path.relative(r, abs);
  if (homeDir && abs.startsWith(`${homeDir}${path.sep}`)) return `~${abs.slice(homeDir.length)}`;
  return abs;
}

function grade(findings) {
  if (findings.some((f) => f.severity === 'critical' || f.severity === 'high')) return 'fail';
  if (findings.length) return 'warn';
  return 'pass';
}

function runAgentCheck(root, { home = false, homeDir = os.homedir() } = {}) {
  const targets = collectTargets(root, { home, homeDir });
  const findings = [];
  for (const t of targets) {
    for (const f of checkFile(t)) {
      const rule = RULES[f.rule];
      const where = displayPath(f.file, root, homeDir);
      findings.push({
        rule: f.rule,
        area: rule.area,
        severity: rule.severity,
        title: rule.title,
        fix: rule.fix,
        file: where,
        line: f.line,
        scope: f.scope,
        // Stable across runs: rule, file and the finding's own key. A secret
        // key holds only a line number, never the value.
        fingerprint: events.fingerprint('agent_check', f.rule, where, f.key),
      });
    }
  }
  const areas = {};
  for (const a of AREAS) {
    const list = findings.filter((f) => f.area === a);
    areas[a] = { grade: grade(list), findings: list.length };
  }
  const overall = grade(findings);
  return { root: path.resolve(root), files: targets.length, findings, areas, grade: overall, home };
}

function toEvents(result, { repo, now = new Date() } = {}) {
  const name = repo || events.repoName(result.root);
  return result.findings.map((f) => events.makeEvent({
    kind: 'agent_check',
    repo: name,
    severity: f.severity,
    title: f.title,
    detail: f.fix,
    status: 'open',
    fingerprint: f.fingerprint,
    occurredAt: now,
  }));
}

const GRADE_WORD = { pass: 'pass', warn: 'warn', fail: 'fail' };

function renderReport(result, { color = false } = {}) {
  const L = [''];
  L.push(`  sentinel agents: checked ${result.files} agent file${result.files === 1 ? '' : 's'}${result.home ? ' in this project and your home folder' : ' in this project'}`);
  L.push('');
  for (const a of AREAS) {
    const s = result.areas[a];
    L.push(`  ${GRADE_WORD[s.grade].padEnd(5)} ${AREA_LABEL[a]}${s.findings ? ` (${s.findings})` : ''}`);
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...result.findings].sort((x, y) => rank[x.severity] - rank[y.severity] || x.file.localeCompare(y.file) || x.line - y.line);
  if (sorted.length) {
    L.push('');
    for (const f of sorted.slice(0, 60)) {
      L.push(`  ${f.severity.padEnd(8)} ${f.file}:${f.line}`);
      L.push(`           ${f.title.replace(/\.$/, '').toLowerCase()}.`);
      L.push(`           fix: ${f.fix.toLowerCase()}`);
    }
    if (sorted.length > 60) L.push(`  and ${sorted.length - 60} more. run with --json to see all`);
  }
  L.push('');
  const word = result.grade === 'pass' ? 'nothing risky found in this agent setup' : (result.grade === 'warn' ? 'a few things to look at, nothing urgent' : 'at least one finding needs you soon');
  L.push(`  overall: ${result.grade}. ${word}`);
  L.push('  no secret values are shown or sent');
  L.push('');
  void color;
  return L.join('\n');
}

module.exports = {
  RULES,
  checkFile,
  runAgentCheck,
  toEvents,
  renderReport,
};
