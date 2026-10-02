'use strict';

// One reaper for every agent work copy on this machine.
//
// Claude Code subagents (.claude/worktrees/agent-*), engine dispatch
// (<arena>/.agent-worktrees/<repo>/...), the night shift
// (<arena>/atrisos-backend-worktrees/night-*) and ad-hoc /tmp checkouts all
// register with their home repo, so asking every repo under the arena for its
// worktree list covers every launcher. The per-repo rules live in
// cleanupWorktrees (commands/worktree.js); this file walks the arena, adds the
// shared helpers those rules need (lock owners, open files, GitHub PR state),
// and guards free disk before a launcher makes another full copy.
//
// The Mac ran out of disk twice (2026-09-27, 2026-10-01) because finished
// copies were never put away. Branches are always kept: removing a worktree
// only deletes the checkout, never a commit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GB = 1024 * 1024 * 1024;
const DEFAULT_ROOM_GB = 15;
const DEFAULT_REFUSE_GB = 5;
const COMMAND_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const LOCK_PID_PATTERN = /\bpid[ =:](\d+)\b/i;
const LOCK_START_PATTERN = /\bstart\s+([^)]+)\)/i;

function arenaRoot() {
  return path.resolve(process.env.ATRIS_ARENA_ROOT || path.join(os.homedir(), 'arena'));
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: COMMAND_MAX_BUFFER_BYTES, ...options });
}

function canonicalPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

// ---- agent copy folders ----------------------------------------------------

// Where launchers put their work copies. The arena sweep only removes copies
// in these folders; a worktree somewhere else (a Conductor workspace, a
// hand-made checkout beside the repo) belongs to a person and is reported,
// never removed.
const AGENT_COPY_PATTERNS = [
  /\/\.claude\/worktrees\//,
  /\/\.agent-worktrees\//,
  /-worktrees\//,
  /\/\.codex\/worktrees\//,
  /\/\.wt\//,
];

// Ad-hoc scratch copies sit directly in the temp folder (/tmp/rv-4028).
function isTempCopy(candidate) {
  const parent = path.dirname(candidate);
  return ['/tmp', '/private/tmp', canonicalPath(os.tmpdir())].includes(parent);
}

function isAgentCopyPath(value) {
  const candidates = [path.resolve(value), canonicalPath(value)];
  return candidates.some((candidate) => AGENT_COPY_PATTERNS.some((pattern) => pattern.test(candidate))
    || isTempCopy(candidate));
}

// ---- locks -------------------------------------------------------------------

// Claude Code locks its isolated subagent copies with
// "claude agent agent-<id> (pid N start <lstart>)" while the parent is alive.
// The night shift and atris launchers use "... (pid N)". A lock that names a
// pid is owned by that process: it protects the copy only while it runs.
// A lock with no pid was placed by a person and is always honored.
function parseLockReason(reason) {
  const text = String(reason || '').trim();
  const pidMatch = LOCK_PID_PATTERN.exec(text);
  const startMatch = LOCK_START_PATTERN.exec(text);
  return {
    reason: text,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    start: startMatch ? startMatch[1].replace(/\s+/g, ' ').trim() : '',
  };
}

function processStartText(pid) {
  const result = run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (result.status !== 0) return '';
  return String(result.stdout || '').replace(/\s+/g, ' ').trim();
}

function pidAlive(pid, { start = '' } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!error || error.code !== 'EPERM') return false;
  }
  // A recycled pid belongs to some other program: when the lock recorded the
  // owner's start time, a different start time means the owner is gone.
  if (start) {
    const actual = processStartText(pid);
    if (actual && actual !== start) return false;
  }
  return true;
}

// { locked: false } | { locked: true, live: bool, pid, reason }
function lockState(lockReason, { isAlive = pidAlive } = {}) {
  if (lockReason === undefined || lockReason === null || lockReason === false) return { locked: false };
  const parsed = parseLockReason(lockReason === true ? '' : lockReason);
  if (!parsed.pid) return { locked: true, live: true, pid: null, reason: parsed.reason };
  return {
    locked: true,
    live: Boolean(isAlive(parsed.pid, { start: parsed.start })),
    pid: parsed.pid,
    reason: parsed.reason,
  };
}

// ---- open files ----------------------------------------------------------------

// Every path any process holds open (cwd, open files, mapped binaries). A copy
// with anything open inside is in use, whatever its git state says.
function listOpenPaths() {
  const result = run('lsof', ['-n', '-w', '-F', 'n']);
  if (result.error || (result.status !== 0 && !result.stdout)) return null;
  const paths = new Set();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('n/')) paths.add(line.slice(1).replace(/ \(.*\)$/, ''));
  }
  return [...paths];
}

// ---- GitHub PR state ----------------------------------------------------------

// Squash merges never make the branch an ancestor of the default branch, so
// ask GitHub what happened to the branch's PRs. One gh call per branch,
// cached for the run. Any gh failure answers "unknown" and the copy is kept.
function summarizePrs(prs) {
  if (!Array.isArray(prs)) return { state: 'unknown', prs: [] };
  if (!prs.length) return { state: 'none', prs: [] };
  if (prs.some((pr) => pr.state === 'OPEN')) return { state: 'open', prs };
  if (prs.some((pr) => pr.state === 'MERGED')) return { state: 'merged', prs };
  return { state: 'closed', prs };
}

function parsePrList(result) {
  if (!result || result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// One recent-PR listing per repo answers most branches; a branch missing from
// it gets its own `gh pr list --head <branch>` call.
function createPrLookup({ runner = run, recentLimit = 300 } = {}) {
  const cache = new Map();
  const recentByRepo = new Map();
  const recentFor = (repoRoot) => {
    const repoKey = canonicalPath(repoRoot);
    if (recentByRepo.has(repoKey)) return recentByRepo.get(repoKey);
    const listed = parsePrList(runner('gh', [
      'pr', 'list', '--state', 'all', '--limit', String(recentLimit),
      '--json', 'number,state,headRefOid,headRefName,url',
    ], { cwd: repoRoot, timeout: 60000 }));
    let index = null;
    if (listed) {
      index = new Map();
      for (const pr of listed) {
        if (!index.has(pr.headRefName)) index.set(pr.headRefName, []);
        index.get(pr.headRefName).push(pr);
      }
    }
    recentByRepo.set(repoKey, index);
    return index;
  };
  return function prLookup(repoRoot, branch) {
    if (!branch || branch === 'detached') return { state: 'none', prs: [] };
    const key = `${canonicalPath(repoRoot)}\u0000${branch}`;
    if (cache.has(key)) return cache.get(key);
    const recent = recentFor(repoRoot);
    let answer;
    if (recent && recent.has(branch)) {
      answer = summarizePrs(recent.get(branch));
    } else {
      const result = runner('gh', [
        'pr', 'list', '--head', branch, '--state', 'all', '--limit', '20',
        '--json', 'number,state,headRefOid,url',
      ], { cwd: repoRoot, timeout: 30000 });
      const prs = parsePrList(result);
      answer = prs ? summarizePrs(prs) : {
        state: 'unknown',
        prs: [],
        error: String((result && (result.stderr || result.error)) || '').trim().slice(0, 200),
      };
    }
    cache.set(key, answer);
    return answer;
  };
}

// ---- disk --------------------------------------------------------------------

function freeBytes(target = os.homedir()) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(target);
      return Number(stats.bavail) * Number(stats.bsize);
    }
  } catch {}
  const result = run('df', ['-k', target]);
  const line = String(result.stdout || '').trim().split(/\r?\n/)[1] || '';
  const available = Number(line.split(/\s+/)[3]);
  return Number.isFinite(available) ? available * 1024 : Infinity;
}

function sizeBytes(target) {
  const result = run('du', ['-sk', target], { timeout: 120000 });
  const kb = Number(String(result.stdout || '').trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

function formatGb(bytes) {
  return `${(bytes / GB).toFixed(1)} GB`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}G`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))}M`;
}

// ---- repos -------------------------------------------------------------------

// Every git repo one or two levels under the arena (ecosystem/openclaw sits at
// depth two). Worktree checkouts have a .git file, not a directory, so they
// are skipped here and found through their home repo's worktree list.
function discoverRepos(root = arenaRoot()) {
  const repos = [];
  const visit = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      let isRepo = false;
      try {
        isRepo = fs.statSync(path.join(full, '.git')).isDirectory();
      } catch {}
      if (isRepo) repos.push(full);
      else if (depth < 2) visit(full, depth + 1);
    }
  };
  visit(root, 1);
  return repos.sort();
}

function repoHasWorktrees(repo) {
  try {
    return fs.readdirSync(path.join(repo, '.git', 'worktrees')).length > 0;
  } catch {
    return false;
  }
}

// ---- the arena sweep ----------------------------------------------------------

const VERDICT_REMOVE = 'remove';
const VERDICT_KEEP = 'keep';

function rowsFromCleanup(repo, result) {
  const rows = [];
  const removedPaths = new Set((result.removed || []).map((item) => item.path));
  for (const item of result.candidates || []) {
    rows.push({
      repo,
      path: item.path,
      branch: item.branch,
      verdict: VERDICT_REMOVE,
      reason: item.reason,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.stale_lock_pid ? { stale_lock_pid: item.stale_lock_pid } : {}),
      removed: result.apply ? removedPaths.has(item.path) : false,
    });
  }
  for (const item of result.kept || []) {
    if (item.reason === 'primary_checkout') continue;
    rows.push({
      repo,
      path: item.path,
      branch: item.branch,
      verdict: VERDICT_KEEP,
      reason: item.reason,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.pid ? { pid: item.pid } : {}),
      ...(item.error ? { detail: item.error.slice(0, 120) } : {}),
    });
  }
  return rows;
}

// Sweep every repo under the arena with the shared rules. apply=false only
// reports. sizes: 'all' measures every copy, 'removed' (default when
// applying) measures only what goes, false measures nothing.
function reapArena({
  arena = arenaRoot(),
  repos = null,
  apply = false,
  sizes = apply ? 'removed' : 'all',
  log = () => {},
  cleanup = null,
  openPaths = undefined,
  prLookup = null,
} = {}) {
  const cleanupWorktrees = cleanup || require('../commands/worktree').cleanupWorktrees;
  const freeBefore = freeBytes(arena);
  const open = openPaths === undefined ? listOpenPaths() : openPaths;
  const lookup = prLookup || createPrLookup();
  const self = canonicalPath(process.cwd());
  const rows = [];
  const errors = [];
  const repoList = (repos || discoverRepos(arena)).filter(repoHasWorktrees);
  for (const repo of repoList) {
    let result;
    try {
      // Size before removal: once a copy is gone there is nothing to measure.
      const sizeOf = new Map();
      const measure = (wtPath) => {
        if (!sizes) return;
        if (!sizeOf.has(wtPath)) sizeOf.set(wtPath, sizeBytes(wtPath));
      };
      result = cleanupWorktrees({
        root: repo,
        apply,
        mainline: true,
        agentCopiesOnly: true,
        activeCwds: open === null ? undefined : open,
        prLookup: lookup,
        protectPaths: [self],
        beforeRemove: sizes ? measure : null,
      });
      const repoRows = rowsFromCleanup(repo, result);
      for (const row of repoRows) {
        if (sizes === 'all' || (sizes && row.verdict === VERDICT_REMOVE)) {
          if (!sizeOf.has(row.path) && fs.existsSync(row.path)) measure(row.path);
          row.bytes = sizeOf.get(row.path) || 0;
        }
      }
      rows.push(...repoRows);
      if (apply) run('git', ['worktree', 'prune'], { cwd: repo });
      log(`${path.basename(repo)}: ${repoRows.filter((r) => r.verdict === VERDICT_REMOVE).length} to remove, ${repoRows.filter((r) => r.verdict === VERDICT_KEEP).length} kept`);
    } catch (error) {
      errors.push({ repo, error: String((error && error.message) || error).slice(0, 300) });
    }
  }
  const removable = rows.filter((row) => row.verdict === VERDICT_REMOVE);
  const removed = rows.filter((row) => row.removed);
  const sum = (list) => list.reduce((total, row) => total + (row.bytes || 0), 0);
  return {
    apply,
    arena,
    repos: repoList,
    rows,
    errors,
    removable: removable.length,
    removableBytes: sum(removable),
    removed: removed.length,
    freedBytes: sum(removed),
    freeBefore,
    freeAfter: apply ? freeBytes(arena) : freeBefore,
  };
}

const REASON_TEXT = {
  merged_into_base: 'landed in the main branch',
  same_changes_in_base: 'same changes already in the main branch',
  pr_merged: 'PR merged, every commit on GitHub',
  pr_closed: 'PR closed, every commit on GitHub',
  completed_unmerged_checkout_expired: 'agent finished over an hour ago, branch kept',
  completed_unmerged_retention: 'agent finished under an hour ago',
  unmerged: 'work not landed',
  dirty: 'uncommitted changes',
  locked_by_live_agent: 'in use by a running agent',
  locked: 'locked by hand',
  active_process: 'a program has files open in it',
  fresh_worktree_grace: 'made in the last hour',
  not_agent_copy: 'outside the agent work folders, left for its owner',
  permanent_lane: 'permanent lane',
  current_checkout: 'this checkout',
  protected_branch: 'main branch checkout',
  missing_or_unreadable: 'folder missing or unreadable',
  missing_head: 'no commit',
  remove_failed: 'remove failed',
};

function reasonText(row) {
  const base = REASON_TEXT[row.reason] || row.reason;
  const extras = [];
  if (row.pid) extras.push(`pid ${row.pid}`);
  if (row.detail) extras.push(row.detail);
  if (row.stale_lock_pid) extras.push(`its agent (pid ${row.stale_lock_pid}) has exited`);
  return extras.length ? `${base} (${extras.join('; ')})` : base;
}

function shortPath(value) {
  const home = os.homedir();
  return value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

function renderReapTable(report, { all = true } = {}) {
  const lines = [];
  const rows = all ? report.rows : report.rows.filter((row) => row.verdict === VERDICT_REMOVE);
  const ordered = [...rows].sort((a, b) => (a.verdict === b.verdict ? (b.bytes || 0) - (a.bytes || 0) : a.verdict === VERDICT_REMOVE ? -1 : 1));
  const pathWidth = Math.min(90, Math.max(4, ...ordered.map((row) => shortPath(row.path).length)));
  lines.push(`${'PATH'.padEnd(pathWidth)}  ${'SIZE'.padStart(6)}  ${'VERDICT'.padEnd(7)}  REASON`);
  for (const row of ordered) {
    const shown = shortPath(row.path);
    const clipped = shown.length > pathWidth ? `...${shown.slice(shown.length - pathWidth + 3)}` : shown;
    const verdict = row.removed ? 'removed' : row.verdict;
    lines.push(`${clipped.padEnd(pathWidth)}  ${formatSize(row.bytes).padStart(6)}  ${verdict.padEnd(7)}  ${reasonText(row)}`);
  }
  lines.push('');
  if (report.apply) {
    lines.push(`removed ${report.removed} of ${report.rows.length} copies, freed ${formatGb(report.freedBytes)}; ${formatGb(report.freeAfter)} free now`);
  } else {
    lines.push(`would remove ${report.removable} of ${report.rows.length} copies, freeing ${formatGb(report.removableBytes)}; ${formatGb(report.freeBefore)} free now`);
  }
  for (const item of report.errors) lines.push(`could not check ${shortPath(item.repo)}: ${item.error}`);
  return lines.join('\n');
}

// ---- disk room before a new copy -------------------------------------------

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Called by every launcher before it makes a worktree. Under roomGb free, put
// finished copies away first; still under refuseGb, refuse with a plain
// message instead of filling the disk. Test runs skip it (a test repo must
// never sweep the real arena) unless a caller passes force.
function ensureDiskRoom({
  target = arenaRoot(),
  arena = null,
  roomGb = envNumber('ATRIS_DISK_ROOM_GB', DEFAULT_ROOM_GB),
  refuseGb = envNumber('ATRIS_DISK_REFUSE_GB', DEFAULT_REFUSE_GB),
  free = freeBytes,
  reap = reapArena,
  force = false,
  log = () => {},
} = {}) {
  if (!force && (process.env.ATRIS_DISK_GUARD === 'off' || process.env.NODE_TEST_CONTEXT)) {
    return { ok: true, skipped: true };
  }
  const before = free(target);
  if (before >= roomGb * GB) return { ok: true, freeBytes: before, reaped: 0 };
  log(`disk: ${formatGb(before)} free, under ${roomGb} GB; putting finished work copies away first`);
  let reaped = null;
  try {
    reaped = reap({ arena: arena || arenaRoot(), apply: true, sizes: 'removed' });
  } catch (error) {
    log(`disk: cleanup failed: ${String((error && error.message) || error).slice(0, 200)}`);
  }
  const after = free(target);
  const removed = reaped ? reaped.removed : 0;
  if (removed) log(`disk: put away ${removed} finished cop${removed === 1 ? 'y' : 'ies'}, ${formatGb(after)} free now`);
  if (after < refuseGb * GB) {
    return {
      ok: false,
      freeBytes: after,
      reaped: removed,
      message: `Not starting another work copy: only ${formatGb(after)} of disk is free, and each copy can take close to 1 GB. `
        + `Finished copies were already put away. Free some space, then try again. To see what is still kept: atris worktree reap`,
    };
  }
  return { ok: true, freeBytes: after, reaped: removed };
}

module.exports = {
  GB,
  arenaRoot,
  canonicalPath,
  createPrLookup,
  discoverRepos,
  ensureDiskRoom,
  formatGb,
  freeBytes,
  isAgentCopyPath,
  listOpenPaths,
  lockState,
  parseLockReason,
  pidAlive,
  reapArena,
  reasonText,
  renderReapTable,
};
