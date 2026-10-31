'use strict';

// Disk room and shared installs for agent build copies.
//
// Every web build copy used to run its own `npm ci`: 0.8 GB and 25 seconds
// each, measured 2026-10-30 on atrisos-web. Ten copies in a push filled the
// disk. On APFS a clone of the folder shares its blocks with the original,
// so a copy whose package-lock.json matches an existing install gets that
// install as a clone: about 2 seconds and 12 MB instead.
//
// The shared installs live under <workspace>/.agent-worktrees/.deps/<repo>/
// <lockfile hash>/node_modules. Nobody runs npm there, so a clone of one is
// always a complete install. The folder starts with a dot so tools that walk
// .agent-worktrees for repo names skip it.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GB = 1e9;
// A web copy peaks near 1.5 GB (0.7 GB installs, 0.45 GB .next, source), and
// a hard push runs about ten at once: below 25 GB free a push no longer fits,
// so start reaps finished copies first. Below 10 GB macOS itself starts to
// fail (swap, updates, builds), so start refuses to add another copy.
const DEFAULT_REAP_BELOW_GB = 25;
const DEFAULT_REFUSE_BELOW_GB = 10;
const AGENT_COPIES_DIR = '.agent-worktrees';
const DEPS_DIR = '.deps';
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

// clonefile(2) on a folder clones the whole tree in one call: under 2
// seconds for the 45,000 files of the web install, where cp -c, file by
// file, takes 25 to 33. osascript ships with macOS, so no compiler or extra
// runtime is needed. It prints 0 on success.
const CLONEFILE_JXA = 'function run(argv) { ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]]); return String($.clonefile(argv[0], argv[1], 1)); }';

function formatGb(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
  return `${(bytes / GB).toFixed(1)} GB`;
}

// Free bytes on the disk holding `dir`, walking up to the nearest folder that
// exists. null when the disk cannot be read.
function freeBytes(dir) {
  let probe = path.resolve(dir || '.');
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const stats = fs.statfsSync(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function readGb(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// 0 turns a limit off.
function spaceLimits(env = process.env) {
  return {
    reapBelow: readGb(env.ATRIS_WORKTREE_REAP_BELOW_GB, DEFAULT_REAP_BELOW_GB) * GB,
    refuseBelow: readGb(env.ATRIS_WORKTREE_MIN_FREE_GB, DEFAULT_REFUSE_BELOW_GB) * GB,
  };
}

// The real path, also for a folder not made yet: its nearest existing parent
// is resolved (macOS /var is really /private/var) and the rest appended.
function realOrResolved(value) {
  const resolved = path.resolve(value);
  const missing = [];
  for (let probe = resolved; ;) {
    try {
      return path.join(fs.realpathSync(probe), ...missing.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return resolved;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

function isInside(child, parent) {
  const a = realOrResolved(child);
  const b = realOrResolved(parent);
  return a === b || a.startsWith(`${b}${path.sep}`);
}

// Temp folders hold test fixtures and throwaway snapshots. The space guard,
// shared installs, and removal after ship leave them alone, so tests that
// build copies in a temp folder behave as before.
function isScratchPath(value) {
  const roots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  return roots.some((root) => fs.existsSync(root) && isInside(value, root));
}

function isAgentCopyPath(value) {
  return path.resolve(value).split(path.sep).includes(AGENT_COPIES_DIR);
}

// Repos that have build copies: <workspace>/.agent-worktrees/<name> next to a
// checkout at <workspace>/<name>.
function agentCopyRepos(workspace) {
  const dir = path.join(workspace, AGENT_COPIES_DIR);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, root: path.join(workspace, entry.name), copies: path.join(dir, entry.name) }))
    .filter((repo) => fs.existsSync(path.join(repo.root, '.git')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function lockHash(lockFile) {
  return crypto.createHash('sha256').update(fs.readFileSync(lockFile)).digest('hex').slice(0, 16);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pathExists(value) {
  try {
    fs.lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function isRealDir(value) {
  try {
    return fs.lstatSync(value).isDirectory();
  } catch {
    return false;
  }
}

// True when the install in `modulesDir` is exactly what `lockFile` asks for.
// npm records what it installed in node_modules/.package-lock.json. Optional
// and peer packages may be missing (other platforms); anything else missing,
// at another version, or extra means the install does not match. Workspaces
// and linked folders point outside node_modules, so a clone of node_modules
// alone would be wrong; those never match.
function installedMatchesLock(lockFile, modulesDir) {
  const wanted = readJson(lockFile);
  const installed = readJson(path.join(modulesDir, '.package-lock.json'));
  if (!wanted || !installed || !wanted.packages || !installed.packages) return false;
  for (const [key, meta] of Object.entries(wanted.packages)) {
    if (key === '') continue;
    if (!key.startsWith('node_modules/') || (meta && meta.link)) return false;
    const got = installed.packages[key];
    if (!got) {
      if (meta && (meta.optional || meta.devOptional || meta.peer)) continue;
      return false;
    }
    if (meta && meta.version && got.version !== meta.version) return false;
  }
  return Object.keys(installed.packages).every((key) => key === '' || Object.prototype.hasOwnProperty.call(wanted.packages, key));
}

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {}
}

// Clones a folder without copying its data, or fails. Never falls back to a
// real copy: a full copy costs as much disk as the install it replaces, and
// cp -c silently does exactly that on a disk that cannot clone.
function cloneTree(src, dst, { platform = process.platform, run = spawnSync } = {}) {
  try {
    if (fs.statSync(src).dev !== fs.statSync(path.dirname(dst)).dev) return { ok: false, error: 'source is on another disk' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  if (platform === 'darwin') {
    const whole = run('osascript', ['-l', 'JavaScript', '-e', CLONEFILE_JXA, src, dst], { encoding: 'utf8', timeout: CLONE_TIMEOUT_MS });
    if (whole.status === 0 && String(whole.stdout || '').trim() === '0') return { ok: true, method: 'clonefile' };
    removeTree(dst);
    return { ok: false, error: 'this disk cannot clone folders' };
  }
  if (platform === 'linux') {
    const perFile = run('cp', ['-R', '--reflink=always', src, dst], { encoding: 'utf8', timeout: CLONE_TIMEOUT_MS });
    if (perFile.status === 0) return { ok: true, method: 'reflink' };
    removeTree(dst);
    return { ok: false, error: String(perFile.stderr || perFile.stdout || 'cp --reflink failed').trim() };
  }
  return { ok: false, error: `no folder clone on ${platform}` };
}

function depsRepoDir(workspace, repoName) {
  return path.join(workspace, AGENT_COPIES_DIR, DEPS_DIR, repoName);
}

function depsCacheEntry(workspace, repoName, hash) {
  return path.join(depsRepoDir(workspace, repoName), hash);
}

// Makes sure the shared store holds an install for `hash`, cloning it from
// `sourceDir` (a matching node_modules) when it does not. Two starts racing
// each build their own partial entry; the first rename wins and the other
// is thrown away. Returns the cached node_modules path or null.
function ensureCachedInstall({ workspace, repoName, hash, lockFile, sourceDir, clone = cloneTree }) {
  const entry = depsCacheEntry(workspace, repoName, hash);
  const cached = path.join(entry, 'node_modules');
  if (installedMatchesLock(lockFile, cached)) return cached;
  // A mismatched existing entry may contain local changes. Do not replace it.
  if (pathExists(entry)) return null;
  if (!sourceDir || !installedMatchesLock(lockFile, sourceDir)) return null;
  const partial = path.join(depsRepoDir(workspace, repoName), `.partial-${hash}-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(partial, { recursive: true });
    const cloned = clone(sourceDir, path.join(partial, 'node_modules'));
    if (!cloned.ok) return null;
    // Build caches are not part of the install and only grow the store.
    removeTree(path.join(partial, 'node_modules', '.cache'));
    if (!installedMatchesLock(lockFile, path.join(partial, 'node_modules'))) return null;
    try {
      fs.renameSync(partial, entry);
    } catch {
      // Another start stored the same install first.
    }
    return installedMatchesLock(lockFile, cached) ? cached : null;
  } finally {
    removeTree(partial);
  }
}

function touch(target) {
  try {
    const now = new Date();
    fs.utimesSync(target, now, now);
  } catch {}
}

// Gives a new build copy its node_modules as a clone of a matching install,
// so the agent skips `npm ci`. Looks in the shared store first, then in the
// main checkout and other copies of the same repo. Never fails the start:
// any miss returns { status: 'skipped', reason } and the agent installs as
// before.
function seedNodeModules({ target, workspace, repoName, sources = [], clone = cloneTree, isIgnored = () => true } = {}) {
  const startedAt = Date.now();
  const result = (status, reason, extra = {}) => ({ status, reason, ms: Date.now() - startedAt, ...extra });
  const lockFile = path.join(target, 'package-lock.json');
  const modules = path.join(target, 'node_modules');
  if (!fs.existsSync(lockFile)) return result('skipped', 'no package-lock.json');
  if (pathExists(modules)) return result('skipped', 'node_modules already present');
  if (!isIgnored(target)) return result('skipped', 'node_modules is not ignored by git here');
  let hash;
  try {
    hash = lockHash(lockFile);
  } catch {
    return result('skipped', 'could not read package-lock.json');
  }
  let cached = path.join(depsCacheEntry(workspace, repoName, hash), 'node_modules');
  if (!installedMatchesLock(lockFile, cached)) {
    cached = null;
    for (const source of sources) {
      if (!source || realOrResolved(source) === realOrResolved(target)) continue;
      const sourceLock = path.join(source, 'package-lock.json');
      const sourceModules = path.join(source, 'node_modules');
      if (!isRealDir(sourceModules)) continue;
      try {
        if (lockHash(sourceLock) !== hash) continue;
      } catch {
        continue;
      }
      cached = ensureCachedInstall({ workspace, repoName, hash, lockFile, sourceDir: sourceModules, clone });
      if (cached) break;
    }
  }
  if (!cached) return result('skipped', 'no matching install to clone yet; run npm ci, and later copies will clone it', { hash });
  // Record use of the entry before cloning it.
  touch(path.dirname(cached));
  const cloned = clone(cached, modules);
  if (!cloned.ok || !installedMatchesLock(lockFile, modules)) {
    removeTree(modules);
    return result('skipped', `clone failed: ${cloned.error || 'install did not match after cloning'}`, { hash });
  }
  return result('cloned', '', { hash, method: cloned.method, source: cached });
}

module.exports = {
  AGENT_COPIES_DIR,
  GB,
  agentCopyRepos,
  cloneTree,
  depsCacheEntry,
  formatGb,
  freeBytes,
  installedMatchesLock,
  isAgentCopyPath,
  isInside,
  isScratchPath,
  lockHash,
  seedNodeModules,
  spaceLimits,
};
