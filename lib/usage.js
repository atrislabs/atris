'use strict';

const fs = require('fs');
const path = require('path');
const { knownCommands } = require('./known-commands');

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE_RELATIVE_PATH = path.join('.atris', 'state', 'usage.jsonl');
const USAGE_MAX_BYTES = 5 * 1024 * 1024;

// Usage telemetry used to write to `<cwd>/.atris/state/usage.jsonl`, so a
// command run from a subdirectory that already had a nested .atris (e.g.
// backend/) split its usage away from the workspace root's store, the same
// footgun the mission and task stores hit. Resolve to the shared workspace
// root (spine-first -> git toplevel -> cwd) so usage lands with the rest of the
// state, whichever subdir the caller stood in. Falls back to the raw cwd if the
// shared resolver can't load; telemetry must never break the command path.
function resolveUsageRoot(cwd = process.cwd()) {
  try {
    const { workspaceRoot } = require('./task-db');
    const root = workspaceRoot(cwd);
    if (root) return root;
  } catch {}
  return cwd;
}

function usagePath(cwd = process.cwd()) {
  return path.join(resolveUsageRoot(cwd), USAGE_RELATIVE_PATH);
}

function parseUsageLine(line) {
  try {
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.at !== 'string' || typeof entry.cmd !== 'string') return null;
    return entry;
  } catch {
    return null;
  }
}

function readAllUsage(cwd = process.cwd()) {
  const file = usagePath(cwd);
  try {
    if (!fs.existsSync(file)) return [];
  } catch {
    return [];
  }
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseUsageLine(trimmed);
      if (entry) out.push(entry);
    }
  } catch {
    return [];
  }
  return out;
}

function readUsage(cwd = process.cwd(), options = {}) {
  const entries = readAllUsage(cwd);
  const sinceDays = Number(options.sinceDays);
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) return entries;
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const cutoff = now - sinceDays * DAY_MS;
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at >= cutoff;
  });
}

function trimUsageFile(cwd = process.cwd()) {
  const file = usagePath(cwd);
  const stat = fs.statSync(file);
  if (stat.size <= USAGE_MAX_BYTES) return;
  const cutoff = Date.now() - 30 * DAY_MS;
  const kept = readAllUsage(cwd).filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at >= cutoff;
  });
  fs.writeFileSync(file, kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
}

function recordUsage(command, cwd = process.cwd()) {
  try {
    if (!command || !knownCommands.includes(command)) return;
    const root = resolveUsageRoot(cwd);
    // The sensor observes workspaces, it never creates them: recording into a
    // resolved root with no .atris/ would litter pristine cwds (even `--help`).
    if (!fs.existsSync(path.join(root, '.atris'))) return;
    const file = usagePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), cmd: String(command) })}\n`, 'utf8');
    trimUsageFile(root);
  } catch {
    // Usage telemetry must never affect the command path.
  }
}

module.exports = {
  usagePath,
  recordUsage,
  readUsage,
};
