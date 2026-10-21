'use strict';

// Zen state: the main checkout matches origin, stray code is not left in the
// tree, the team's live state stays on disk, and there are no leftovers
// (stashes, idle side copies, merged branches). This module only reads.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runGit } = require('./checkout-sync');

// Paths that hold the team's live state or Atris-generated agent config.
// Uncommitted changes here are expected and never break zen.
const DEFAULT_TEAM_STATE = [
  'atris/',
  '.atris/',
  '.claude/',
  '.codex/',
  '.cursor/',
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  // Live data: a running app reads it from the tree, so zen never rolls it back.
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '*.sqlite',
  '*.sqlite3',
  '*.duckdb',
];

function gitOut(args, cwd) {
  const result = runGit(args, cwd);
  return result.status === 0 ? result.stdout.trim() : null;
}

function readTeamState(root) {
  const extra = [];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'zen.json'), 'utf8'));
    if (Array.isArray(config.team_state)) {
      for (const entry of config.team_state) {
        if (typeof entry === 'string' && entry.trim()) extra.push(entry.trim());
      }
    }
  } catch {
    // No config, or unreadable config: defaults only.
  }
  return [...DEFAULT_TEAM_STATE, ...extra];
}

function isTeamState(file, teamState) {
  return teamState.some((entry) => {
    if (entry.startsWith('*.')) return file.endsWith(entry.slice(1));
    return entry.endsWith('/') ? file.startsWith(entry) : file === entry || file.startsWith(`${entry}/`);
  });
}

function defaultBranch(root, remote) {
  const head = gitOut(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], root);
  if (head && head.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  for (const name of ['main', 'master']) {
    if (runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`], root).status === 0) {
      return name;
    }
  }
  return null;
}

function dirtyEntries(root) {
  const result = runGit(['status', '--porcelain=v1', '-z'], root);
  if (result.status !== 0) return [];
  const entries = result.stdout.split('\0');
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const item = { xy: entry.slice(0, 2), path: entry.slice(3), orig: null };
    // Renames and copies carry the original path as the next entry.
    if (entry[0] === 'R' || entry[0] === 'C') {
      item.orig = entries[i + 1] || null;
      i += 1;
    }
    files.push(item);
  }
  return files;
}

function dirtyPaths(root) {
  return dirtyEntries(root).map((entry) => entry.path);
}

function listWorktrees(root) {
  const out = gitOut(['worktree', 'list', '--porcelain'], root) || '';
  const worktrees = [];
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, prunable: false, locked: false };
      worktrees.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (current && line.startsWith('prunable')) {
      current.prunable = true;
    } else if (current && (line === 'locked' || line.startsWith('locked '))) {
      // Locked by its owner (often a running agent). Git will not remove it.
      current.locked = true;
    }
  }
  return worktrees;
}

// Text of the jobs this machine runs on a schedule: the user crontab and
// launchd agents. A side copy named there is in use even when it looks idle.
// ATRIS_ZEN_SCHEDULE_FILE points at a file to read instead (tests).
function scheduleText() {
  const override = process.env.ATRIS_ZEN_SCHEDULE_FILE;
  if (override) {
    try {
      return fs.readFileSync(override, 'utf8');
    } catch {
      return '';
    }
  }
  const parts = [];
  const cron = spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 5000 });
  if (cron.status === 0) parts.push(cron.stdout);
  const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  try {
    for (const name of fs.readdirSync(agents)) {
      if (name.endsWith('.plist')) parts.push(fs.readFileSync(path.join(agents, name), 'utf8'));
    }
  } catch {
    // No launchd agents.
  }
  return parts.join('\n');
}

function scheduledCopies(worktrees, text = scheduleText()) {
  if (!text) return new Set();
  const home = os.homedir();
  const expanded = text.replace(/\$\{?HOME\}?/g, home).replace(/(^|[\s"'=:])~\//g, `$1${home}/`);
  const used = new Set();
  for (const wt of worktrees) {
    const at = path.resolve(wt.path);
    const pattern = new RegExp(`${at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);
    if (pattern.test(expanded)) used.add(at);
  }
  return used;
}

const FRESH_MINUTES = 30;

function freshMinutesFromEnv() {
  const n = Number.parseFloat(process.env.ATRIS_ZEN_FRESH_MINUTES || FRESH_MINUTES);
  return Number.isFinite(n) ? n : FRESH_MINUTES;
}

function mtime(file) {
  try {
    return fs.lstatSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// True when a checkout switched or made a commit after the cutoff.
function headMovedSince(checkout, cutoff) {
  const gitDir = gitOut(['rev-parse', '--git-dir'], checkout);
  if (!gitDir) return false;
  const dir = path.resolve(checkout, gitDir);
  return Math.max(mtime(path.join(dir, 'logs', 'HEAD')), mtime(path.join(dir, 'HEAD'))) > cutoff;
}

function checkZen({ cwd = process.cwd(), fetch = true, freshMinutes = freshMinutesFromEnv(), now = Date.now() } = {}) {
  const root = gitOut(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return { ok: false, error: 'not a git repository' };

  const remote = gitOut(['remote'], root)?.split('\n').includes('origin') ? 'origin' : null;
  let fetched = null;
  if (remote && fetch) fetched = runGit(['fetch', '--quiet', remote], root).status === 0;

  const main = remote ? defaultBranch(root, remote) : null;
  const upstream = main ? `${remote}/${main}` : null;
  const branch = gitOut(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  const problems = [];

  if (!upstream) {
    problems.push({ kind: 'no_upstream', text: 'no origin main branch to compare against' });
  } else if (branch !== main) {
    problems.push({
      kind: 'off_main',
      text: branch ? `on branch ${branch}, not ${main}` : `not on a branch (detached), not ${main}`,
    });
  }

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = gitOut(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], root);
    if (counts) [ahead, behind] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    if (ahead) problems.push({ kind: 'ahead', count: ahead, text: `${ahead} unpushed ${ahead === 1 ? 'commit' : 'commits'}` });
    if (behind) problems.push({ kind: 'behind', count: behind, text: `${behind} ${behind === 1 ? 'commit' : 'commits'} behind ${upstream}` });
  }

  const teamState = readTeamState(root);
  const dirty = dirtyPaths(root);
  const stray = dirty.filter((file) => !isTeamState(file, teamState));
  const teamFiles = dirty.length - stray.length;
  if (stray.length) {
    problems.push({
      kind: 'stray_code',
      count: stray.length,
      files: stray,
      text: `${stray.length} stray code ${stray.length === 1 ? 'edit' : 'edits'} outside team state`,
    });
  }

  const stashOut = gitOut(['stash', 'list', '--format=%H'], root) || '';
  const stashes = stashOut ? stashOut.split('\n').length : 0;
  if (stashes) problems.push({ kind: 'stashes', count: stashes, text: `${stashes} old ${stashes === 1 ? 'stash' : 'stashes'}` });

  const others = listWorktrees(root).filter((wt) => path.resolve(wt.path) !== path.resolve(root));
  const idle = [];
  const busy = [];
  const inUse = [];
  const locked = [];
  const cutoff = now - freshMinutes * 60000;
  const scheduled = scheduledCopies(others);
  for (const wt of others) {
    if (scheduled.has(path.resolve(wt.path))) continue;
    if (wt.locked) {
      locked.push(wt);
      continue;
    }
    if (wt.prunable || !fs.existsSync(wt.path)) {
      idle.push(wt);
      continue;
    }
    const status = runGit(['status', '--porcelain'], wt.path);
    if (status.status !== 0 || status.stdout.trim()) busy.push(wt);
    else if (headMovedSince(wt.path, cutoff)) inUse.push(wt);
    else idle.push(wt);
  }
  if (idle.length) {
    problems.push({
      kind: 'idle_worktrees',
      count: idle.length,
      paths: idle.map((wt) => wt.path),
      text: `${idle.length} idle side ${idle.length === 1 ? 'copy' : 'copies'} with no unsaved work`,
    });
  }

  let merged = [];
  if (upstream) {
    const checkedOut = new Set(others.map((wt) => wt.branch).filter(Boolean));
    merged = (gitOut(['branch', '--merged', upstream, '--format=%(refname:short)'], root) || '')
      .split('\n')
      .filter((name) => name && name !== branch && name !== main && !checkedOut.has(name));
    if (merged.length) {
      problems.push({
        kind: 'merged_branches',
        count: merged.length,
        branches: merged,
        text: `${merged.length} ${merged.length === 1 ? 'branch' : 'branches'} already merged`,
      });
    }
  }

  return {
    ok: true,
    zen: problems.length === 0,
    root,
    branch,
    upstream,
    fetched,
    ahead,
    behind,
    team_files: teamFiles,
    stashes,
    worktrees_with_work: busy.map((wt) => wt.path),
    worktrees_in_use: inUse.map((wt) => wt.path),
    worktrees_locked: locked.map((wt) => wt.path),
    fresh_minutes: freshMinutes,
    problems,
  };
}

module.exports = {
  DEFAULT_TEAM_STATE,
  FRESH_MINUTES,
  headMovedSince,
  mtime,
  checkZen,
  defaultBranch,
  dirtyEntries,
  gitOut,
  isTeamState,
  listWorktrees,
  readTeamState,
  scheduledCopies,
};
