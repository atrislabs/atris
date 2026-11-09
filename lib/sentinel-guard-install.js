'use strict';

// Installs the sentinel guard (lib/sentinel-guard.js) as a Claude Code
// PreToolUse hook, the same way `atris spend guard install` installs its
// hook (lib/claude-spend-guard.js): the hook is a copy of the guard file.
// Its rules file (lib/sentinel-rules.json) sits beside it. It keeps
// working if the CLI moves. The settings file is rewritten
// atomically and never clobbered when it does not parse.
//
//   project   <project>/.claude/hooks/sentinel-guard.js, wired in
//             <project>/.claude/settings.json through $CLAUDE_PROJECT_DIR
//   global    ~/.claude/hooks/sentinel-guard.js, wired in
//             ~/.claude/settings.json with an absolute node path

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const guard = require('./sentinel-guard');

const SCRIPT_NAME = `${guard.GUARD_MARK}.js`;
const GUARD_SOURCE = path.join(__dirname, 'sentinel-guard.js');
// The guard reads its tunable rules from this file beside it.
const RULES_SOURCE = path.join(__dirname, 'sentinel-rules.json');
const RULES_NAME = 'sentinel-rules.json';

function homeDir(env = process.env) {
  return env.HOME || os.homedir();
}

function locations({ global = false, root = process.cwd(), env = process.env } = {}) {
  const base = global ? path.join(homeDir(env), '.claude') : path.join(path.resolve(root), '.claude');
  return { scope: global ? 'global' : 'project', settings: path.join(base, 'settings.json'), script: path.join(base, 'hooks', SCRIPT_NAME), rules: path.join(base, 'hooks', RULES_NAME) };
}

function nodeBinary() {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function quote(p) {
  return /^[A-Za-z0-9_./-]+$/.test(p) ? p : `"${String(p).replace(/(["\\$`])/g, '\\$1')}"`;
}

function hookCommand(loc) {
  if (loc.scope === 'project') return `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${SCRIPT_NAME}"`;
  return `${quote(nodeBinary())} ${quote(loc.script)}`;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const json = JSON.parse(text); // throws on bad JSON: never overwrite settings we cannot read
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file} is not a settings object`);
  return json;
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.atris-tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function isGuardHook(h) {
  return String((h && h.command) || '').includes(guard.GUARD_MARK);
}

function isGuardGroup(g) {
  return Boolean(g && Array.isArray(g.hooks) && g.hooks.some(isGuardHook));
}

// Take only the guard's own hook out of each group. Other hooks in the same
// group stay; a group is dropped only when the guard was all it held.
function withoutGuard(groups) {
  const out = [];
  for (const g of groups) {
    if (!isGuardGroup(g)) { out.push(g); continue; }
    const rest = g.hooks.filter((h) => !isGuardHook(h));
    if (rest.length) out.push({ ...g, hooks: rest });
  }
  return out;
}

function fileHash(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function status({ global = false, root, env = process.env } = {}) {
  const loc = locations({ global, root, env });
  let settings = {};
  let readable = true;
  try { settings = readSettings(loc.settings); } catch { readable = false; }
  const groups = (settings.hooks && settings.hooks.PreToolUse) || [];
  const wired = readable && Array.isArray(groups) && groups.some(isGuardGroup);
  const present = fs.existsSync(loc.script);
  const current = present && fileHash(loc.script) === fileHash(GUARD_SOURCE) && fileHash(loc.rules) === fileHash(RULES_SOURCE);
  const hooksOff = settings.disableAllHooks === true;
  return { ...loc, installed: wired && present, wired, present, current, readable, hooks_off: hooksOff };
}

// Where a background flush finds the atris CLI. Written once at install.
function writeFlushConfig({ env = process.env, atrisBin } = {}) {
  const dir = path.join(homeDir(env), '.atris', 'sentinel');
  const file = path.join(dir, 'guard.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  cfg.atris_bin = atrisBin || path.resolve(__dirname, '..', 'bin', 'atris.js');
  cfg.node = nodeBinary();
  if (!Array.isArray(cfg.allow_hosts)) cfg.allow_hosts = [];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function install({ global = false, root, env = process.env, atrisBin } = {}) {
  const loc = locations({ global, root, env });
  const settings = readSettings(loc.settings);
  fs.mkdirSync(path.dirname(loc.script), { recursive: true });
  fs.copyFileSync(RULES_SOURCE, loc.rules);
  fs.copyFileSync(GUARD_SOURCE, loc.script);
  fs.chmodSync(loc.script, 0o755);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  const kept = withoutGuard(groups);
  // First in line, so it decides before any other hook runs.
  settings.hooks.PreToolUse = [
    { matcher: guard.MATCHER, hooks: [{ type: 'command', command: hookCommand(loc), timeout: 10 }] },
    ...kept,
  ];
  writeSettings(loc.settings, settings);
  try { writeFlushConfig({ env, atrisBin }); } catch {}
  return status({ global, root, env });
}

function uninstall({ global = false, root, env = process.env } = {}) {
  const loc = locations({ global, root, env });
  const settings = readSettings(loc.settings);
  if (settings.hooks && Array.isArray(settings.hooks.PreToolUse)) {
    const kept = withoutGuard(settings.hooks.PreToolUse);
    if (kept.length) settings.hooks.PreToolUse = kept;
    else delete settings.hooks.PreToolUse;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    writeSettings(loc.settings, settings);
  }
  try { fs.unlinkSync(loc.script); } catch {}
  try { fs.unlinkSync(loc.rules); } catch {}
  return status({ global, root, env });
}

// Blocks in the guard log over the last day.
function recentBlocks({ env = process.env, sinceMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  let text = '';
  try { text = fs.readFileSync(path.join(homeDir(env), '.atris', 'sentinel', 'guard.log'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (now - Date.parse(r.at) <= sinceMs) out.push(r);
    } catch {}
  }
  return out;
}

module.exports = { locations, status, install, uninstall, recentBlocks, hookCommand, SCRIPT_NAME };
