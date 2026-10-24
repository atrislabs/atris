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
  // Append-only logs and ledgers a running app keeps writing. Left in place
  // like a database, but a repo is not skipped for one (see LIVE_LOGS).
  '*.jsonl',
  '*.ndjson',
];

// Growing logs are everywhere in team state, so zen --all does not hold a
// whole repo back for them the way it does for an unsaved database.
const LIVE_LOGS = ['*.jsonl', '*.ndjson'];

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

// Changed files with untracked folders opened up, so a live database inside
// a new folder is seen as live data, not as part of a stray folder.
function dirtyFiles(root) {
  return dirtyEntries(root).flatMap((entry) => (entry.xy === '??' && entry.path.endsWith('/')
    ? untrackedFiles(root, entry.path)
    : [entry.path]));
}

// Where unsaved team files sit, by top folder (or file at the root),
// biggest first and ties by name: [{ place: 'atris/', count: 52 }, ...].
function placeCounts(files) {
  const counts = new Map();
  for (const file of files) {
    const slash = file.indexOf('/');
    const place = slash === -1 ? file : file.slice(0, slash + 1);
    counts.set(place, (counts.get(place) || 0) + 1);
  }
  return [...counts].map(([place, count]) => ({ place, count }))
    .sort((a, b) => b.count - a.count || (a.place < b.place ? -1 : a.place > b.place ? 1 : 0));
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

function expandHome(text) {
  const home = os.homedir();
  return text.replace(/\$\{?HOME\}?/g, home).replace(/(^|[\s"'=:])~\//g, `$1${home}/`);
}

// A job often runs a script that names the side copy, not the copy itself,
// so the scripts a schedule runs are read too, one level down. Logs are left
// out, and so is anything large or binary.
function withScripts(text) {
  const seen = new Set();
  const parts = [text];
  for (const [file] of expandHome(text).matchAll(/\/[^\s"'<>;|&()]+/g)) {
    if (seen.has(file) || file.endsWith('.log')) continue;
    seen.add(file);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      const body = fs.readFileSync(file, 'utf8');
      if (!body.includes('\0')) parts.push(body);
    } catch {
      // Not a readable file.
    }
  }
  return parts.join('\n');
}

// Text of the jobs this machine runs on a schedule: the user crontab and
// launchd agents, plus the scripts they run. A side copy named there is in
// use even when it looks idle.
// ATRIS_ZEN_SCHEDULE_FILE points at a file to read instead (tests).
function scheduleText() {
  const override = process.env.ATRIS_ZEN_SCHEDULE_FILE;
  if (override) {
    try {
      return withScripts(fs.readFileSync(override, 'utf8'));
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
  return withScripts(parts.join('\n'));
}

function scheduledCopies(worktrees, text = scheduleText()) {
  if (!text) return new Set();
  const expanded = expandHome(text);
  const used = new Set();
  for (const wt of worktrees) {
    const at = path.resolve(wt.path);
    const pattern = new RegExp(`${at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);
    if (pattern.test(expanded)) used.add(at);
  }
  return used;
}

// Folders that programs on this machine are running in right now, read from
// lsof once per call. A side copy holding one is in use even when its git
// history looks old: a dev server or a long eval run makes no commits.
// ATRIS_ZEN_CWDS_FILE points at a file of folders, one per line (tests).
function programFolders() {
  const override = process.env.ATRIS_ZEN_CWDS_FILE;
  if (override) {
    try {
      return fs.readFileSync(override, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
  const out = spawnSync('lsof', ['-nP', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return (out.stdout || '').split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1));
}

function runningCopies(worktrees, folders = programFolders()) {
  const used = new Set();
  for (const wt of worktrees) {
    const at = path.resolve(wt.path);
    let real = at;
    try {
      real = fs.realpathSync(at);
    } catch {
      // Gone already; compare the path as given.
    }
    const inside = (f) => [at, real].some((p) => f === p || f.startsWith(p + path.sep));
    if (folders.some(inside)) used.add(at);
  }
  return used;
}

const FRESH_MINUTES = 30;

function freshMinutesFromEnv() {
  const n = Number.parseFloat(process.env.ATRIS_ZEN_FRESH_MINUTES || FRESH_MINUTES);
  return Number.isFinite(n) ? n : FRESH_MINUTES;
}

function untrackedFiles(root, dir) {
  const out = gitOut(['ls-files', '--others', '--exclude-standard', '-z', '--', dir], root);
  return out ? out.split('\0').filter(Boolean) : [];
}

// Every changed file in a checkout, with untracked folders opened up.
function changedFiles(checkout) {
  return dirtyEntries(checkout).flatMap((entry) => {
    const paths = entry.xy === '??' && entry.path.endsWith('/') ? untrackedFiles(checkout, entry.path) : [entry.path];
    return entry.orig ? [...paths, entry.orig] : paths;
  });
}

// TODO.md is rewritten from the task database by any task command run in a
// copy (see renderTodoMarkdown in lib/task-db.js). That rewrite is not anyone
// working there, so it must not keep an idle copy looking fresh forever.
const REGENERATED_MARK = 'Regenerated from durable Atris task state';

function isRegenerated(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n).includes(REGENERATED_MARK);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function lastTouched(checkout) {
  let newest = 0;
  for (const p of changedFiles(checkout)) {
    const file = path.join(checkout, p);
    if (!isRegenerated(file)) newest = Math.max(newest, mtime(file));
  }
  return newest;
}

// Links a side copy holds where the repo ignores a folder, like node_modules
// pointing at another checkout's packages. A link holds no work, but git only
// matches `node_modules/` against a real folder, so it reads as unsaved. The
// rule is asked of the main checkout, where that path is not a link. Empty
// when anything else in the copy changed.
function folderLinksOnly(checkout, root) {
  const entries = dirtyEntries(checkout);
  const links = [];
  for (const entry of entries) {
    if (entry.xy !== '??') return [];
    const rel = entry.path.replace(/\/+$/, '');
    let link = false;
    try {
      link = fs.lstatSync(path.join(checkout, rel)).isSymbolicLink();
    } catch {}
    if (!link || runGit(['check-ignore', '-q', `${rel}/`], root).status !== 0) return [];
    links.push(rel);
  }
  return links;
}

// A side copy whose only changes are team notes, untouched and not switched
// or committed in the fresh window, holds nothing anyone is working on. Live
// data files never count as notes, so a copy holding one is left alone.
function idleWithOnlyNotes(checkout, teamState, cutoff) {
  const live = teamState.filter((entry) => entry.startsWith('*.'));
  const files = changedFiles(checkout);
  if (!files.length) return false;
  if (!files.every((f) => isTeamState(f, teamState) && !isTeamState(f, live))) return false;
  return !headMovedSince(checkout, cutoff) && lastTouched(checkout) <= cutoff;
}

const ABANDONED_DAYS = 3;

function abandonedDaysFromEnv() {
  const n = Number.parseFloat(process.env.ATRIS_ZEN_ABANDONED_DAYS || ABANDONED_DAYS);
  return Number.isFinite(n) ? n : ABANDONED_DAYS;
}

function mtime(file) {
  try {
    return fs.lstatSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// When the last entry in a history file was written, read from the entry
// itself. Git upkeep (gc, reflog expire) rewrites these files without adding
// entries, so the file time alone would make an old copy look fresh.
function lastEntryTime(log) {
  let fd;
  try {
    fd = fs.openSync(log, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 8192);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const last = buf.toString('utf8').trimEnd().split('\n').pop() || '';
    const m = last.match(/> (\d+) [+-]\d{4}\t/);
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// When a checkout last switched or made a commit.
function headTime(checkout) {
  const gitDir = gitOut(['rev-parse', '--git-dir'], checkout);
  if (!gitDir) return 0;
  const dir = path.resolve(checkout, gitDir);
  const logged = lastEntryTime(path.join(dir, 'logs', 'HEAD'));
  if (logged !== null) return logged;
  return Math.max(mtime(path.join(dir, 'logs', 'HEAD')), mtime(path.join(dir, 'HEAD')));
}

// True when a checkout switched or made a commit after the cutoff.
function headMovedSince(checkout, cutoff) {
  return headTime(checkout) > cutoff;
}

// How long until the first of these side copies has sat untouched long
// enough for zen to save it, or null when none is waiting on the clock.
function nextSaveIn(paths, days, now = Date.now()) {
  let soonest = null;
  for (const p of paths) {
    const wait = Math.max(headTime(p), lastTouched(p)) + days * 86400000 - now;
    if (wait > 0 && (soonest === null || wait < soonest)) soonest = wait;
  }
  return soonest;
}

function waitText(ms) {
  const hours = Math.ceil(ms / 3600000);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

// True when a branch was made or moved after the cutoff. A running job makes
// its branch a moment before it checks it out, so it has no commits yet and
// git calls it merged; clearing it would pull it out from under the job.
function branchMovedSince(root, name, cutoff) {
  const common = gitOut(['rev-parse', '--git-common-dir'], root);
  if (!common) return false;
  const logged = lastEntryTime(path.join(path.resolve(root, common), 'logs', 'refs', 'heads', name));
  return logged !== null && logged > cutoff;
}

// A checkout whose core.bare got set to true still has its .git folder and
// every file, but git stops looking at the files, so "not a git repository"
// would send the reader the wrong way. Name it, with the one-line undo.
const BARE_FLIPPED = 'git here is set to bare (core.bare is true), so it ignores the files in this folder; git config core.bare false undoes it';

function flippedToBare(cwd) {
  if (gitOut(['rev-parse', '--is-bare-repository'], cwd) !== 'true') return false;
  const gitDir = gitOut(['rev-parse', '--absolute-git-dir'], cwd);
  if (!gitDir || path.basename(gitDir) !== '.git') return false;
  const folder = path.dirname(gitDir);
  const here = fs.realpathSync(cwd);
  return here === folder || here.startsWith(folder + path.sep);
}

function checkZen({ cwd = process.cwd(), fetch = true, freshMinutes = freshMinutesFromEnv(), now = Date.now() } = {}) {
  const root = gitOut(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return { ok: false, error: flippedToBare(cwd) ? BARE_FLIPPED : 'not a git repository' };

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
  const dirty = dirtyFiles(root);
  const stray = dirty.filter((file) => !isTeamState(file, teamState));
  const teamFiles = dirty.length - stray.length;
  const teamPlaces = placeCounts(dirty.filter((file) => isTeamState(file, teamState)));
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
  const notesOnly = [];
  const inUse = [];
  const locked = [];
  const cutoff = now - freshMinutes * 60000;
  const scheduled = scheduledCopies(others);
  const running = runningCopies(others);
  for (const wt of others) {
    if (scheduled.has(path.resolve(wt.path))) continue;
    if (running.has(path.resolve(wt.path))) {
      inUse.push(wt);
      continue;
    }
    if (wt.locked) {
      locked.push(wt);
      continue;
    }
    if (wt.prunable || !fs.existsSync(wt.path)) {
      idle.push(wt);
      continue;
    }
    const status = runGit(['status', '--porcelain'], wt.path);
    if (status.status !== 0) busy.push(wt);
    else if (status.stdout.trim() && !folderLinksOnly(wt.path, root).length) (idleWithOnlyNotes(wt.path, teamState, cutoff) ? notesOnly : busy).push(wt);
    else if (headMovedSince(wt.path, cutoff)) inUse.push(wt);
    else idle.push(wt);
  }
  if (notesOnly.length) {
    problems.push({
      kind: 'notes_only_worktrees',
      count: notesOnly.length,
      paths: notesOnly.map((wt) => wt.path),
      text: `${notesOnly.length} idle side ${notesOnly.length === 1 ? 'copy holds' : 'copies hold'} only team notes`,
    });
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
      .filter((name) => name && name !== branch && name !== main && !checkedOut.has(name))
      .filter((name) => !branchMovedSince(root, name, cutoff));
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
    team_places: teamPlaces,
    stashes,
    worktrees_with_work: busy.map((wt) => wt.path),
    worktrees_in_use: inUse.map((wt) => wt.path),
    worktrees_locked: locked.map((wt) => wt.path),
    fresh_minutes: freshMinutes,
    problems,
  };
}

// A place a person can paste: home as ~, and the system temp folder (git
// may report it through /private) as $TMPDIR when that variable is set, so a
// test leftover there fits a narrow pane.
function shortPlace(p) {
  const home = os.homedir();
  const tmp = (process.env.TMPDIR || '').replace(/\/+$/, '');
  if (tmp) {
    let real = tmp;
    try {
      real = fs.realpathSync(tmp);
    } catch {}
    for (const dir of new Set([tmp, real])) {
      if (p === dir || p.startsWith(dir + path.sep)) return `$TMPDIR${p.slice(dir.length)}`;
    }
  }
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

// A place too long for a narrow pane keeps as much of its start as fits,
// then its own folder name, so the line still says where and which. A cut
// that saves only a few characters hides more than it helps, so it is skipped.
const PLACE_WIDTH = 100;
function fitPlace(text, max = PLACE_WIDTH) {
  if (text.length <= max) return text;
  const parts = text.split('/');
  const name = parts.pop();
  if (parts.length < 2) return text;
  let head = parts[0];
  for (const part of parts.slice(1)) {
    if (`${head}/${part}/…/${name}`.length > max) break;
    head = `${head}/${part}`;
  }
  const cut = `${head}/…/${name}`;
  return text.length - cut.length >= 10 ? cut : text;
}

// Side copies left with unsaved work: at most three named, one place per
// line so a long path still fits a narrow pane, then when zen will take
// them over and, when known, how long until the first one goes.
function sideCopyLines(paths, days, waitMs = null) {
  const n = paths.length;
  const lines = [`${n} side ${n === 1 ? 'copy has' : 'copies have'} unsaved work, left for ${n === 1 ? 'its owner' : 'their owners'}`];
  // Copies that share a folder (one workflow's runs, say) read as one line.
  const folders = new Map();
  for (const p of paths) {
    const dir = path.dirname(p);
    if (!folders.has(dir)) folders.set(dir, []);
    folders.get(dir).push(p);
  }
  const listed = [];
  for (const [dir, group] of folders) {
    if (group.length >= 3) listed.push({ text: `${group.length} in ${shortPlace(dir)}/`, count: group.length });
    else for (const p of group) listed.push({ text: fitPlace(shortPlace(p)), count: 1, path: p });
  }
  // A copy made inside another listed copy goes right under it, named from
  // there, so a doubly nested path does not run the width of the pane.
  const parentOf = new Map();
  for (const row of listed) {
    const holders = listed.filter((q) => q.path && row.path && row.path.startsWith(q.path + path.sep));
    if (!holders.length) continue;
    const holder = holders.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    parentOf.set(row, holder);
    row.text = `  inside it: ${path.relative(holder.path, row.path)}`;
  }
  const rows = [];
  const place = (row) => {
    rows.push(row);
    for (const child of listed) if (parentOf.get(child) === row) place(child);
  };
  for (const row of listed) if (!parentOf.has(row)) place(row);
  for (const row of rows.slice(0, 3)) lines.push(`  ${row.text}`);
  const rest = rows.slice(3).reduce((sum, row) => sum + row.count, 0);
  if (rest) lines.push(`  and ${rest} more`);
  lines.push(`zen saves ${n === 1 ? 'it' : 'each one'} to zen-backup/ once nobody has touched it for ${days} ${days === 1 ? 'day' : 'days'}`);
  if (waitMs > 0) lines.push(`${n === 1 ? 'that is' : 'the first one is'} due in ${waitText(waitMs)}`);
  return lines;
}

module.exports = {
  ABANDONED_DAYS,
  branchMovedSince,
  folderLinksOnly,
  idleWithOnlyNotes,
  lastTouched,
  nextSaveIn,
  untrackedFiles,
  abandonedDaysFromEnv,
  sideCopyLines,
  DEFAULT_TEAM_STATE,
  FRESH_MINUTES,
  headMovedSince,
  mtime,
  checkZen,
  defaultBranch,
  dirtyEntries,
  gitOut,
  isTeamState,
  LIVE_LOGS,
  dirtyFiles,
  listWorktrees,
  readTeamState,
  scheduledCopies,
  runningCopies,
};
