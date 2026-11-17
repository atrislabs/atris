'use strict';

// What the sweep does about two things that pile up on a busy machine:
//
// 1. Copies held only by old dev servers and test runners. A `next dev` or a
//    `vitest --watch` left in a finished copy keeps it "in use" for days
//    (2.8 days measured 2026-11-17). The sweep reports those as
//    stale_process with their pids; only `--stop-stale --apply` stops them.
//
// 2. Folders under .agent-worktrees that no repo has registered. One with a
//    git pointer or any real file is listed for a person. One that holds only
//    proven caches (bytecode, installs, build output) may be removed.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const STALE_PROCESS_HOURS = 24;

// Dev servers, watchers and test runners. Anything else holding a copy (an
// editor, a shell, an agent) keeps it in use no matter how old.
const STALE_COMMAND = /(?:^|[\s/])(?:next(?:-server)?|vite|vitest|jest|playwright|webpack(?:-dev-server)?|esbuild|tsc|tsx|turbo|nodemon|uvicorn|gunicorn|pytest|storybook|electron)(?:[\s@:]|$)|\bnpm(?:\.js)?\s+(?:run\s+)?(?:dev|test|start|watch)\b|\bnode\s+--test\b|\bhttp\.server\b/i;

function parseElapsed(text) {
  const match = String(text || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

function realOrSelf(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

// Every program with its open paths, age and command. null when either scan fails.
function listProcesses({ run = spawnSync, skip = new Set([String(process.pid)]) } = {}) {
  const files = run('lsof', ['-n', '-F', 'pn'], { encoding: 'utf8', maxBuffer: COMMAND_MAX_BUFFER_BYTES, timeout: 20000, killSignal: 'SIGKILL' });
  if (!files || files.error || files.status !== 0) return null;
  const ps = run('ps', ['-axww', '-o', 'pid=,etime=,args='], { encoding: 'utf8', maxBuffer: COMMAND_MAX_BUFFER_BYTES, timeout: 5000, killSignal: 'SIGKILL' });
  if (!ps || ps.error || ps.status !== 0) return null;
  const byPid = new Map();
  for (const line of String(ps.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || skip.has(match[1])) continue;
    byPid.set(match[1], { pid: Number(match[1]), elapsed_s: parseElapsed(match[2]), args: match[3], paths: [] });
  }
  let pid = '';
  for (const line of String(files.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('n/') && byPid.has(pid)) byPid.get(pid).paths.push(line.slice(1));
  }
  return [...byPid.values()];
}

// Programs standing in or naming a copy: an open file or cwd inside it, or
// its path in the command line.
function holdersOf(wtPath, processes) {
  const roots = [...new Set([path.resolve(wtPath), realOrSelf(wtPath)])];
  const inside = (p) => roots.some((root) => p === root || p.startsWith(`${root}${path.sep}`));
  return processes.filter((proc) => proc.paths.some(inside) || roots.some((root) => proc.args.includes(root)));
}

// The holders when every one is an old dev server or test runner; null when
// any holder is something else or younger than the limit.
function staleHolders(wtPath, processes, { staleMs = STALE_PROCESS_HOURS * 3600000 } = {}) {
  if (!Array.isArray(processes)) return null;
  const holders = holdersOf(wtPath, processes);
  if (!holders.length) return null;
  const stale = holders.every((proc) => Number.isFinite(proc.elapsed_s)
    && proc.elapsed_s * 1000 >= staleMs && STALE_COMMAND.test(proc.args));
  if (!stale) return null;
  return holders.map((proc) => ({ pid: proc.pid, hours: Math.round(proc.elapsed_s / 360) / 10, command: proc.args.slice(0, 120) }));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Stops the listed programs, checking first that each pid still runs the same
// command with at least the same age, so a reused pid is never hit.
function stopStale(holders, { run = spawnSync, waitMs = 5000, kill = process.kill.bind(process), isAlive = alive } = {}) {
  const stopped = [];
  const skipped = [];
  for (const holder of holders) {
    const now = run('ps', ['-o', 'etime=,args=', '-p', String(holder.pid)], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
    const match = String((now && now.stdout) || '').trim().match(/^(\S+)\s+(.*)$/);
    const elapsed = match ? parseElapsed(match[1]) : null;
    if (!match || !match[2].startsWith(holder.command) || !Number.isFinite(elapsed) || elapsed < holder.hours * 3600 - 60) {
      skipped.push(holder.pid);
      continue;
    }
    try { kill(holder.pid, 'SIGTERM'); stopped.push(holder.pid); } catch { skipped.push(holder.pid); }
  }
  const deadline = Date.now() + waitMs;
  while (stopped.some(isAlive) && Date.now() < deadline) sleep(200);
  for (const pid of stopped.filter(isAlive)) {
    try { kill(pid, 'SIGKILL'); } catch {}
  }
  return { stopped, skipped };
}

// Orphan folders: what lives under .agent-worktrees/<repo>/ that no repo lists.
const ORPHAN_CACHE_DIRS = new Set(['node_modules', '.next', '.turbo', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const ORPHAN_WALK_LIMIT = 50000;

function isVenv(dir) {
  try { return fs.lstatSync(path.join(dir, 'pyvenv.cfg')).isFile(); } catch { return false; }
}

// { cacheOnly, files: first few real files, newestMs } or null when unreadable.
function orphanContents(dir) {
  const files = [];
  let newestMs = 0;
  let walked = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    try { newestMs = Math.max(newestMs, fs.lstatSync(current).mtimeMs); } catch { return null; }
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      walked += 1;
      if (walked > ORPHAN_WALK_LIMIT) return null;
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.name === '.git') {
        files.push(rel);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try { newestMs = Math.max(newestMs, fs.lstatSync(full).mtimeMs); } catch {}
        continue;
      }
      if (entry.isDirectory()) {
        const cache = ORPHAN_CACHE_DIRS.has(entry.name) || ((entry.name === 'venv' || entry.name === '.venv') && isVenv(full));
        if (cache) {
          try { newestMs = Math.max(newestMs, fs.lstatSync(full).mtimeMs); } catch {}
        } else {
          stack.push(full);
        }
        continue;
      }
      try { newestMs = Math.max(newestMs, fs.lstatSync(full).mtimeMs); } catch {}
      // A loose file counts as cache only by an exact name, and a bytecode
      // file only inside a __pycache__ folder (those folders are skipped above).
      if (!(entry.isFile() && /^(?:\.DS_Store|tsconfig\.tsbuildinfo)$/.test(entry.name))) files.push(rel);
    }
  }
  return { cacheOnly: files.length === 0, files: files.slice(0, 5), newestMs };
}

function duKib(target, run = spawnSync) {
  const measured = run('du', ['-sk', target], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  const match = measured && measured.status === 0 && String(measured.stdout || '').match(/^(\d+)\s/);
  return match ? Number(match[1]) : 0;
}

// registeredByRepo: Map of repo folder name -> Set of canonical registered paths.
function findOrphans({ copiesDir, registeredByRepo, processes, now = Date.now(), quietMs = 2 * 3600000, measure = true }) {
  const orphans = [];
  let repos = [];
  try { repos = fs.readdirSync(copiesDir, { withFileTypes: true }); } catch { return orphans; }
  for (const repo of repos) {
    if (!repo.isDirectory() || repo.name.startsWith('.')) continue;
    const repoDir = path.join(copiesDir, repo.name);
    const known = registeredByRepo.has(repo.name);
    const registered = registeredByRepo.get(repo.name) || new Set();
    const registeredList = [...registered];
    let children = [];
    // A top-level folder named for no repo is a leftover copy itself: judge it whole.
    if (known) {
      try { children = fs.readdirSync(repoDir, { withFileTypes: true }); } catch { continue; }
    } else {
      children = [{ name: '', isDirectory: () => true }];
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const full = realOrSelf(path.join(repoDir, child.name));
      if (registered.has(full)) continue;
      // A folder that holds a registered copy is a parent, not an orphan.
      if (registeredList.some((p) => p.startsWith(`${full}${path.sep}`))) continue;
      const item = { repo: repo.name, path: full };
      const contents = orphanContents(full);
      if (!contents) {
        orphans.push({ ...item, status: 'abandoned', why: 'could not read every file' });
        continue;
      }
      item.kib = measure ? duKib(full) : 0;
      const hasGit = fs.existsSync(path.join(full, '.git'));
      const held = Array.isArray(processes) ? holdersOf(full, processes).length > 0 : true;
      if (hasGit) orphans.push({ ...item, status: 'abandoned', why: 'has a git pointer but no repo lists it' });
      else if (!contents.cacheOnly) orphans.push({ ...item, status: 'abandoned', why: 'holds real files', files: contents.files });
      else if (held) orphans.push({ ...item, status: 'abandoned', why: 'a program is using it' });
      else if (now - contents.newestMs < quietMs) orphans.push({ ...item, status: 'abandoned', why: 'changed recently' });
      else orphans.push({ ...item, status: 'removable', why: 'holds only caches' });
    }
  }
  return orphans;
}

// Removes a removable orphan after checking it again right before.
function removeOrphan(item, { processes, now = Date.now(), quietMs = 2 * 3600000 } = {}) {
  if (item.status !== 'removable') return false;
  if (fs.existsSync(path.join(item.path, '.git'))) return false;
  const contents = orphanContents(item.path);
  if (!contents || !contents.cacheOnly || now - contents.newestMs < quietMs) return false;
  if (!Array.isArray(processes) || holdersOf(item.path, processes).length) return false;
  try { fs.rmSync(item.path, { recursive: true }); return true; } catch { return false; }
}

module.exports = {
  STALE_PROCESS_HOURS,
  findOrphans,
  listProcesses,
  parseElapsed,
  removeOrphan,
  staleHolders,
  stopStale,
};
