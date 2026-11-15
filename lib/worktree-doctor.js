'use strict';

// `atris worktree doctor` and `atris worktree prune --merged`.
//
// The doctor lists every build copy in the workspace with what it really
// costs on disk, how old and idle it is, whether its branch is merged, and
// whether a program is using it. du counts a cloned node_modules at full size
// although the clone shares its blocks with the shared install, so the
// doctor measures each copy without node_modules and adds the install only
// when the copy made its own (npm ci rewrote it).
//
// Prune removes only copies that the cleanup rules prove safe: registered,
// merged into the main branch, clean, holding no ignored file atris cannot
// rebuild, idle past the given hours, and with no program inside. It never
// forces a removal and never deletes a branch. Copies it keeps lose only
// their build output, and only when idle and unused. Dry run unless --yes.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const space = require('./worktree-space');
const core = require('./worktree-core');

const HOUR_MS = 60 * 60 * 1000;

function duKib(target, { excludeModules = false, platform = process.platform } = {}) {
  const args = ['-sk'];
  if (excludeModules) args.push(...(platform === 'darwin' ? ['-I', 'node_modules'] : ['--exclude=node_modules']));
  args.push(target);
  const measured = spawnSync('du', args, { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  const match = String(measured.stdout || '').match(/^(\d+)\s/);
  return match ? Number(match[1]) : 0;
}

function statOrNull(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function sameStamp(a, b) {
  return Boolean(a && b && a.size === b.size && Math.floor(a.mtimeMs) === Math.floor(b.mtimeMs));
}

// How a copy got its node_modules. A clone (clonefile, reflink, hardlink)
// keeps the source's .package-lock.json stamp; npm ci writes a new one.
function depsKind(copy, { primaryRoot, workspace, repoName }) {
  const modules = path.join(copy, 'node_modules');
  let stat;
  try { stat = fs.lstatSync(modules); } catch { return 'none'; }
  if (stat.isSymbolicLink()) return 'link';
  if (!stat.isDirectory()) return 'none';
  const mine = statOrNull(path.join(modules, '.package-lock.json'));
  if (!mine) return 'own';
  const sources = [path.join(primaryRoot, 'node_modules', '.package-lock.json')];
  const store = path.join(workspace, space.AGENT_COPIES_DIR, '.deps', repoName);
  try {
    for (const hash of fs.readdirSync(store)) sources.push(path.join(store, hash, 'node_modules', '.package-lock.json'));
  } catch {}
  return sources.some((file) => sameStamp(mine, statOrNull(file))) ? 'clone' : 'own';
}

function createdMs(copy) {
  try {
    const sidecar = JSON.parse(fs.readFileSync(path.join(copy, '.atris', 'agent-worktree.json'), 'utf8'));
    const at = Date.parse(sidecar.created_at);
    if (Number.isFinite(at)) return at;
  } catch {}
  const stat = statOrNull(copy);
  return stat ? (stat.birthtimeMs || stat.ctimeMs) : 0;
}

function isMerged(root, head, base) {
  if (!head || !base) return false;
  return core.runGit(['merge-base', '--is-ancestor', head, base], { cwd: root, check: false }).status === 0;
}

// Folders under .agent-worktrees/<repo>/ that git does not know as copies.
function unregisteredFolders(copiesDir, registered) {
  let entries = [];
  try { entries = fs.readdirSync(copiesDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(copiesDir, entry.name))
    .filter((dir) => !registered.has(core.canonicalPath(dir)));
}

const KEPT_WHY = {
  ...core.SWEEP_KEPT_LABELS,
  dirty: 'has uncommitted changes',
  unmerged: 'branch not merged',
  detached_unmerged: 'not merged',
  ignored_data: 'holds ignored files atris cannot rebuild',
  active_process: 'in use',
  fresh_worktree_grace: 'made in the last hour',
  recent_activity: 'used recently',
};

function doctorWorkspace({
  workspace,
  olderThanHours = 24,
  now = Date.now(),
  active = core.listActiveProcessPaths(),
  measure = true,
  repoFilter = '',
} = {}) {
  const root = path.resolve(workspace);
  const report = { workspace: root, free: space.freeBytes(root), older_than_hours: olderThanHours, repos: [], error: '' };
  if (!Array.isArray(active)) {
    report.error = 'could not list running programs';
    return report;
  }
  const scope = path.join(root, space.AGENT_COPIES_DIR);
  const idleMs = olderThanHours * HOUR_MS;
  for (const repo of space.agentCopyRepos(root)) {
    if (repoFilter && repo.name !== repoFilter) continue;
    const entry = { name: repo.name, copies: [], unregistered: [] };
    report.repos.push(entry);
    let base = '';
    try { base = core.defaultMainlineBase(repo.root); } catch {}
    if (!base.startsWith('origin/')) {
      entry.skipped = 'no origin main branch to compare against';
      continue;
    }
    // The same check prune runs, without changing anything.
    let verdicts;
    try {
      verdicts = core.cleanupWorktrees({ root: repo.root, base, apply: false, activeCwds: active, onlyUnder: scope, idleMs, rescueIdleMs: 0 });
    } catch (error) {
      entry.error = String((error && error.message) || error);
      continue;
    }
    entry.base = verdicts.base;
    const byPath = new Map();
    for (const item of verdicts.candidates) byPath.set(core.canonicalPath(item.path), { prune: true, reason: item.reason });
    for (const item of verdicts.kept) byPath.set(core.canonicalPath(item.path), { prune: false, reason: item.reason, files: item.files, why: item.why });
    const registered = new Set();
    for (const wt of core.listWorktrees(repo.root)) {
      const copy = core.canonicalPath(wt.path);
      registered.add(copy);
      if (!space.isInside(copy, scope)) continue;
      const verdict = byPath.get(copy) || { prune: false, reason: 'unknown' };
      if (verdict.reason === 'primary_checkout' || verdict.reason === 'out_of_scope') continue;
      const exists = fs.existsSync(copy);
      const deps = exists ? depsKind(copy, { primaryRoot: repo.root, workspace: root, repoName: repo.name }) : 'none';
      const counts = exists ? core.statusCounts(copy) : null;
      const inUse = core.worktreeHasActiveProcess(copy, active);
      const idleFor = exists ? now - core.lastCopyActivityMs(copy) : 0;
      const build = exists && measure ? (core.buildOutputIn(copy) || []) : [];
      const buildKib = build.reduce((sum, item) => sum + item.kib, 0);
      const ownKib = exists && measure ? duKib(copy, { excludeModules: true }) : 0;
      const depsKib = exists && measure && deps === 'own' ? duKib(path.join(copy, 'node_modules')) : 0;
      entry.copies.push({
        path: copy,
        name: path.basename(copy),
        branch: wt.branch,
        exists,
        age_hours: Math.round(((now - createdMs(copy)) / HOUR_MS) * 10) / 10,
        idle_hours: Math.round((idleFor / HOUR_MS) * 10) / 10,
        merged: isMerged(repo.root, wt.head, verdicts.base),
        dirty: counts ? counts.staged + counts.unstaged + counts.untracked : null,
        in_use: inUse,
        deps,
        size_kib: ownKib + depsKib,
        build_kib: buildKib,
        prune: verdict.prune,
        reason: verdict.reason,
        why: verdict.why || (verdict.files ? verdict.files.slice(0, 3).join(', ') : ''),
        // A kept copy loses only its build output, and only when idle and unused.
        clears_build: !verdict.prune && !inUse && idleFor >= idleMs && buildKib > 0,
      });
    }
    for (const dir of unregisteredFolders(repo.copies, registered)) {
      entry.unregistered.push({ path: dir, size_kib: measure ? duKib(dir, { excludeModules: true }) : 0 });
    }
  }
  report.totals = doctorTotals(report);
  return report;
}

function doctorTotals(report) {
  const totals = { copies: 0, size_kib: 0, du_naive_note: 'node_modules clones are counted at 0', older_than_day: 0, older_than_3_days: 0, merged: 0, dirty: 0, in_use: 0, own_installs: 0, links: 0, prune: 0, prune_kib: 0, build_kib: 0, clear_build_kib: 0, unregistered: 0 };
  for (const repo of report.repos) {
    totals.unregistered += repo.unregistered.length;
    for (const copy of repo.copies) {
      totals.copies += 1;
      totals.size_kib += copy.size_kib;
      totals.build_kib += copy.build_kib;
      if (copy.age_hours > 24) totals.older_than_day += 1;
      if (copy.age_hours > 72) totals.older_than_3_days += 1;
      if (copy.merged) totals.merged += 1;
      if (copy.dirty) totals.dirty += 1;
      if (copy.in_use) totals.in_use += 1;
      if (copy.deps === 'own') totals.own_installs += 1;
      if (copy.deps === 'link') totals.links += 1;
      if (copy.prune) {
        totals.prune += 1;
        totals.prune_kib += copy.size_kib;
      }
      if (copy.clears_build) totals.clear_build_kib += copy.build_kib;
    }
  }
  return totals;
}

// Applies (or previews) what the doctor found safe. Removal goes through the
// same cleanup that start and the sweep use, which checks everything again
// right before `git worktree remove` (never --force).
function pruneWorkspace({ workspace, olderThanHours, apply = false, now = Date.now(), active, repoFilter = '', by = 'atris worktree prune' } = {}) {
  const root = path.resolve(workspace);
  const scan = Array.isArray(active) ? active : core.listActiveProcessPaths();
  const report = { workspace: root, apply, older_than_hours: olderThanHours, before: space.freeBytes(root), after: null, repos: [], error: '' };
  if (!Array.isArray(scan)) {
    report.error = 'could not list running programs, so every copy was kept';
    return report;
  }
  const scope = path.join(root, space.AGENT_COPIES_DIR);
  const idleMs = olderThanHours * HOUR_MS;
  const budget = { count: 0, kib: 0 };
  for (const repo of space.agentCopyRepos(root)) {
    if (repoFilter && repo.name !== repoFilter) continue;
    const entry = { name: repo.name, removed: [], candidates: [], kept: [], build: [] };
    report.repos.push(entry);
    let base = '';
    try { base = core.defaultMainlineBase(repo.root); } catch {}
    if (!base.startsWith('origin/')) {
      entry.skipped = 'no origin main branch to compare against';
      continue;
    }
    let result;
    try {
      // A dry run shares one process scan; an applied run scans fresh per repo.
      result = core.cleanupWorktrees({
        root: repo.root, base, apply, activeCwds: apply && !Array.isArray(active) ? undefined : scan,
        onlyUnder: scope, idleMs, rescueIdleMs: 0, rescue: false, by, cleanupBudget: budget, now,
      });
    } catch (error) {
      entry.error = String((error && error.message) || error);
      continue;
    }
    entry.removed = result.removed;
    entry.candidates = result.candidates;
    entry.kept = result.kept.filter((item) => !['primary_checkout', 'current_checkout', 'out_of_scope'].includes(item.reason));
    const fresh = apply && !Array.isArray(active) ? core.listActiveProcessPaths() : scan;
    for (const item of entry.kept) {
      if (['active_process', 'process_scan_failed', 'fresh_worktree_grace', 'recent_activity', 'locked', 'missing_or_unreadable'].includes(item.reason)) continue;
      const copy = core.canonicalPath(item.path);
      if (!fs.existsSync(copy) || now - core.lastCopyActivityMs(copy) < idleMs) continue;
      const cleared = core.clearBuildOutput(copy, { apply, active: fresh });
      if (cleared.cleared.length) entry.build.push({ path: copy, kib: cleared.kib, folders: cleared.cleared.length });
    }
  }
  report.after = space.freeBytes(root);
  return report;
}

module.exports = {
  doctorWorkspace,
  pruneWorkspace,
  KEPT_WHY,
};
