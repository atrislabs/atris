'use strict';

// Put away, then remove. A build copy nobody is using costs disk, so the
// sweep removes it, after saving everything removal would lose:
//
// - Commits live in the shared repository and the branch stays. The copy's
//   HEAD is also pinned by a private ref, refs/atris/put-away/<name>, so even
//   a detached commit survives `git gc`.
// - Changes to files HEAD already tracks go into that ref, as one commit on
//   HEAD built through a throwaway index (the copy's own index and branch
//   never move). The staged version is kept too, as its parent.
// - Every file HEAD does not track, ignored or not, goes into a local tar,
//   ~/.atris/put-away/<repo>-<id>/<name>/ignored.tar, mode 0600. Untracked
//   files never enter git objects: they can hold secrets, and refs can be
//   pushed. Symlinks and empty folders go into the tar as well.
// - Files whose bytes on disk a commit cannot hold exactly (filters, ident,
//   line-ending conversion, assume-unchanged) go into the tar too.
// - Only two things are dropped: ignored node_modules/ and .next/ folders,
//   and the exact files atris itself writes (checked by name and content).
// - record.json beside the tar says what was saved, where, when and why.
//   `atris worktree restore <name>` rebuilds the copy from it, staged state
//   included.
//
// Only copies atris made are touched: under .agent-worktrees, or carrying
// its start marker. "In use" is the only reason such a copy stays: locked,
// a merge or rebase in progress, a running program with its working folder
// or an open file inside it, this process inside it, or a change within the
// idle window (24 hours, never less than one). The folder goes only after the
// ref and tar were read back and matched the disk, and after a fresh check
// that nothing changed and nobody started using it. One lock per repo keeps
// two sweeps from working on the same copies.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const space = require('./worktree-space');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_IDLE_HOURS = 24;
const MIN_IDLE_MS = HOUR_MS;
const DEFAULT_MAX_GB = 10;
const DEFAULT_MAX_PER_REPO = 12;
const PRUNE_AFTER_MS = 30 * DAY_MS;
const PUT_AWAY_REF_PREFIX = 'refs/atris/put-away/';
const MAX_BUFFER = 256 * 1024 * 1024;
// More than this is not quietly copied into the home folder; the copy stays
// and the reason says why.
const MAX_TAR_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_WALK_ENTRIES = 300000;
const LOCK_STALE_MS = 6 * HOUR_MS;
const START_MARKER = path.join('.atris', 'agent-worktree.json');

// ---------------------------------------------------------------------------
// What may be dropped. Everything else is saved.

// Ignored folders that come back with one install or build.
const DROP_IGNORED_DIRS = new Set(['node_modules', '.next']);

const isJson = (text) => { try { JSON.parse(text); return true; } catch { return false; } };
const isJsonl = (text) => String(text).split('\n').filter((line) => line.trim()).every(isJson);
const isStartMarker = (text) => {
  try {
    const data = JSON.parse(text);
    return Boolean(data && typeof data === 'object' && data.owner && data.branch && data.created_at);
  } catch {
    return false;
  }
};

// The exact files atris writes into a copy on its own, found by reading the
// code that writes them (lib/conductor-artifacts.js and every writer under
// .atris/state/). Each must also look like what atris writes, so a person's
// file that happens to share a name is saved. A person's notes elsewhere in
// .atris/state/ are saved.
const TOOL_FILES = [
  { pattern: /^\.atris\/agent-worktree\.json$/, check: isStartMarker },
  { pattern: /^\.atris\/state\/(?:tasks\.projection|engines|atris_goal|experiments-daily|member-up)\.json$/, check: isJson },
  { pattern: /^\.atris\/state\/(?:usage|briefs|missions|mission_events|scorecards|worktree_removals|episodes|steering|approvals|wishes|member-handoffs)\.jsonl$/, check: isJsonl },
  { pattern: /^\.atris\/fleet-prompt-[^/]+\.md$/, check: () => true },
  { pattern: /^\.atris\/codex-watchdog\.js$/, check: () => true },
  { pattern: /^\.atris\/codex-watchdog-[^/]+\.json$/, check: isJson },
  { pattern: /^\.codex-last-message\.txt$/, check: () => true },
  { pattern: /^atris\/qa\/computer-doctor\/log\.jsonl$/, check: isJsonl },
];
// A tracked file atris regenerates from its task store. A change to it is
// rebuilt by the next task command, so it is not kept in the ref.
const TOOL_REGENERATED_TRACKED = /^\.atris\/state\/tasks\.projection\.json$/;

function isToolFile(copy, rel) {
  const rule = TOOL_FILES.find((item) => item.pattern.test(rel));
  if (!rule) return false;
  try {
    const stat = fs.lstatSync(path.join(copy, rel));
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) return false;
    return rule.check(fs.readFileSync(path.join(copy, rel), 'utf8'));
  } catch {
    return false;
  }
}

function inDroppedDir(rel) {
  return String(rel).replace(/\/+$/, '').split('/').some((part) => DROP_IGNORED_DIRS.has(part));
}

// ---------------------------------------------------------------------------
// Small helpers.

function git(cwd, args, { env, input, encoding = 'utf8', timeout = 300000 } = {}) {
  return spawnSync('git', args, {
    cwd, env: env || process.env, input, encoding, maxBuffer: MAX_BUFFER, timeout, killSignal: 'SIGKILL',
  });
}

function out(result) {
  return String((result && result.stdout) || '').trim();
}

function failText(result) {
  if (result && result.error) return String(result.error.message || result.error);
  return String((result && (result.stderr || result.stdout)) || '').trim().split('\n')[0] || 'failed';
}

function canonical(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function parseWorktrees(text) {
  const list = [];
  let current = null;
  for (const line of `${text}\n`.split('\n')) {
    if (!line.trim()) {
      if (current && current.path) list.push(current);
      current = null;
      continue;
    }
    if (!current) current = { path: '', branch: 'detached', head: '' };
    const gap = line.indexOf(' ');
    const key = gap === -1 ? line : line.slice(0, gap);
    const value = gap === -1 ? '' : line.slice(gap + 1);
    if (key === 'worktree') current.path = value;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
    else if (key === 'bare') current.bare = true;
  }
  return list;
}

function listWorktrees(repo) {
  const listed = git(repo, ['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) return null;
  return parseWorktrees(listed.stdout);
}

function primaryOf(repo) {
  const list = listWorktrees(repo);
  return list && list[0] ? list[0].path : '';
}

// One folder per repo: its name plus a short hash of its path, so two repos
// with the same name never share records.
function repoKey(primary) {
  const name = path.basename(primary).replace(/[^A-Za-z0-9._-]+/g, '-') || 'repo';
  const id = crypto.createHash('sha256').update(canonical(primary)).digest('hex').slice(0, 8);
  return `${name}-${id}`;
}

function putAwayHome({ home, env = process.env } = {}) {
  if (home) return path.resolve(home);
  if (env.ATRIS_PUT_AWAY_DIR) return path.resolve(env.ATRIS_PUT_AWAY_DIR);
  return path.join(os.homedir(), '.atris', 'put-away');
}

// The idle window. Never under an hour: 0 must not switch the time rule off.
function idleMsFromEnv(env = process.env) {
  const raw = env.ATRIS_WORKTREE_IDLE_HOURS;
  let ms = DEFAULT_IDLE_HOURS * HOUR_MS;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const hours = Number(raw);
    if (Number.isFinite(hours) && hours >= 0) ms = hours * HOUR_MS;
  }
  return Math.max(MIN_IDLE_MS, ms);
}

// Tests pass allowShortIdle to try shorter windows; nothing a person can set does.
function clampIdle(ms, { allowShortIdle = false } = {}) {
  const value = Number.isFinite(ms) ? ms : DEFAULT_IDLE_HOURS * HOUR_MS;
  return allowShortIdle ? Math.max(0, value) : Math.max(MIN_IDLE_MS, value);
}

function ceilingFromEnv(env = process.env) {
  const read = (value, fallback) => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  };
  return {
    maxBytes: read(env.ATRIS_WORKTREE_MAX_GB, DEFAULT_MAX_GB) * space.GB,
    maxPerRepo: Math.floor(read(env.ATRIS_WORKTREE_MAX_PER_REPO, DEFAULT_MAX_PER_REPO)),
  };
}

function formatAgo(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
}

function formatKib(kib) {
  if (!Number.isFinite(kib) || kib <= 0) return '0 MB';
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GB`;
  if (kib >= 1024) return `${Math.round(kib / 1024)} MB`;
  return `${kib} KB`;
}

function duKib(target, { excludeModules = false, platform = process.platform } = {}) {
  const args = ['-sk'];
  if (excludeModules) args.push(...(platform === 'darwin' ? ['-I', 'node_modules'] : ['--exclude=node_modules']));
  args.push(target);
  const measured = spawnSync('du', args, { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  const match = String(measured.stdout || '').match(/^(\d+)\s/);
  return match ? Number(match[1]) : 0;
}

function sameStamp(a, b) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.size === y.size && Math.floor(x.mtimeMs) === Math.floor(y.mtimeMs);
  } catch {
    return false;
  }
}

// What a copy really holds on disk. A cloned node_modules shares its blocks
// with the install it came from, so it counts as nothing.
function copyKib(copy, { primary } = {}) {
  let kib = duKib(copy, { excludeModules: true });
  const modules = path.join(copy, 'node_modules');
  let stat;
  try { stat = fs.lstatSync(modules); } catch { return kib; }
  if (!stat.isDirectory()) return kib;
  const stampFile = path.join(modules, '.package-lock.json');
  const sources = [];
  if (primary) {
    sources.push(path.join(primary, 'node_modules', '.package-lock.json'));
    const store = path.join(path.dirname(primary), space.AGENT_COPIES_DIR, '.deps', path.basename(primary));
    try {
      for (const hash of fs.readdirSync(store)) sources.push(path.join(store, hash, 'node_modules', '.package-lock.json'));
    } catch {}
  }
  if (!sources.some((source) => sameStamp(stampFile, source))) kib += duKib(modules);
  return kib;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let read; (read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------
// One lock per repo, held for a whole sweep, ceiling, ship removal or restore.

function lockPath(primary) {
  const common = out(git(primary, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return common ? path.join(common, 'atris-put-away.lock') : '';
}

// Returns a release function, or null when another live process holds it.
function lockRepo(primary, { now = Date.now() } = {}) {
  const file = lockPath(primary);
  if (!file) return null;
  const mine = `${process.pid} ${now} ${crypto.randomBytes(6).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx', mode: 0o600 });
      // A stale-lock steal by two processes at once: only the one whose
      // token is still in the file holds it.
      if (fs.readFileSync(file, 'utf8') !== mine) return null;
      return () => {
        try { if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file); } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      let held = '';
      try { held = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const [pid, at] = held.split(' ').map(Number);
      if (pidAlive(pid) && now - at < LOCK_STALE_MS) return null;
      try { if (fs.readFileSync(file, 'utf8') === held) fs.unlinkSync(file); } catch {}
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// In use.

// Every path a running program has open or stands in: lsof lists working
// folders and open files alike; on Linux /proc is the fallback. null when
// neither can be read, and then only the time rule protects a copy.
function listOpenPaths({ run = spawnSync, platform = process.platform, procDir = '/proc' } = {}) {
  const listed = run('lsof', ['-n', '-F', 'n'], { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 60000, killSignal: 'SIGKILL' });
  const text = listed && !listed.error ? String(listed.stdout || '') : '';
  const fromLsof = text.split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1));
  if (fromLsof.length) return resolveAll(fromLsof);
  if (platform === 'linux') {
    try {
      const paths = [];
      for (const pid of fs.readdirSync(procDir)) {
        if (!/^\d+$/.test(pid)) continue;
        try { paths.push(fs.readlinkSync(path.join(procDir, pid, 'cwd'))); } catch {}
        let fds = [];
        try { fds = fs.readdirSync(path.join(procDir, pid, 'fd')); } catch {}
        for (const fd of fds) {
          try { paths.push(fs.readlinkSync(path.join(procDir, pid, 'fd', fd))); } catch {}
        }
      }
      if (paths.length) return resolveAll(paths);
    } catch {}
  }
  return null;
}

// Each path resolved once, so a copy behind a link still matches.
function resolveAll(paths) {
  const seen = new Map();
  for (const item of paths) if (!seen.has(item)) seen.set(item, canonical(item));
  return [...new Set(seen.values())];
}

function inside(child, parent) {
  const a = canonical(child);
  const b = canonical(parent);
  return a === b || a.startsWith(`${b}${path.sep}`);
}

function gitDirOf(copy) {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(copy, '.git'), 'utf8'));
    return pointer ? path.resolve(copy, pointer[1].trim()) : '';
  } catch {
    return '';
  }
}

// A merge, rebase, cherry-pick, revert or bisect half done: a person is in
// the middle of it, so the copy is in use.
function inProgress(copy) {
  const gitDir = gitDirOf(copy);
  if (gitDir) {
    for (const mark of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer']) {
      if (fs.existsSync(path.join(gitDir, mark))) return mark;
    }
  }
  const conflicts = git(copy, ['ls-files', '-u']);
  if (conflicts.status !== 0 || out(conflicts)) return 'unresolved conflicts';
  return '';
}

// The newest change to anything in the copy outside .git folders and the
// two dropped folders: files, folders (a deleted file changes its folder),
// and the copy's own HEAD and HEAD log in git. The index is left out: `git
// status`, including the sweep's own, rewrites it.
function newestChangeMs(copy) {
  let newest = 0;
  const note = (full) => {
    try { newest = Math.max(newest, fs.lstatSync(full).mtimeMs); } catch {}
  };
  const gitDir = gitDirOf(copy);
  if (gitDir) for (const mark of ['HEAD', path.join('logs', 'HEAD')]) note(path.join(gitDir, mark));
  note(copy);
  const stack = [copy];
  let seen = 0;
  while (stack.length && seen < MAX_WALK_ENTRIES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      if (entry.name === '.git' || (entry.isDirectory() && DROP_IGNORED_DIRS.has(entry.name))) continue;
      const full = path.join(dir, entry.name);
      note(full);
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return newest;
}

// Why a copy is in use, or null when nobody is using it.
function copyInUse(copy, { wt = {}, open, idleMs, now = Date.now(), current = process.cwd() } = {}) {
  if (wt.locked) return { reason: 'locked', text: 'locked' };
  if (current && inside(current, copy)) return { reason: 'current', text: 'this command runs inside it' };
  const busy = inProgress(copy);
  if (busy) return { reason: 'in_progress', text: `a git operation is in progress (${busy})` };
  if (Array.isArray(open)) {
    const root = canonical(copy);
    const prefix = `${root}${path.sep}`;
    if (open.some((item) => item === root || item.startsWith(prefix))) {
      return { reason: 'process', text: 'in use by a running program' };
    }
  }
  if (idleMs > 0) {
    const newest = newestChangeMs(copy);
    if (now - newest < idleMs) return { reason: 'recent', text: `changed ${formatAgo(now - newest)}` };
  }
  return null;
}

// Made by atris: under .agent-worktrees, or carrying the start marker.
// A copy someone made by hand with `git worktree add` is never touched.
function isToolCopy(copy) {
  if (space.isAgentCopyPath(copy)) return true;
  try { return isStartMarker(fs.readFileSync(path.join(copy, START_MARKER), 'utf8')); } catch { return false; }
}

// ---------------------------------------------------------------------------
// What a copy holds.

function headPaths(copy, head) {
  const listed = git(copy, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', head]);
  if (listed.status !== 0) return null;
  return new Set(String(listed.stdout || '').split('\0').filter(Boolean));
}

// Tracked changes and staged new files, from git status with untracked
// files left out.
function trackedStatus(copy) {
  const listed = git(copy, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames', '--ignore-submodules=none']);
  if (listed.status !== 0) return null;
  return String(listed.stdout || '').split('\0').filter((row) => row.length >= 4).map((row) => ({ code: row.slice(0, 2), path: row.slice(3) }));
}

// Every file, symlink and empty folder under `rel`, plus a byte count.
function walkTree(copy, rel, { dropDirs = false } = {}) {
  const files = [];
  const empty = [];
  let bytes = 0;
  let seen = 0;
  const stack = [rel];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(copy, dir), { withFileTypes: true }); } catch { return null; }
    if (!entries.length && dir !== '') empty.push(dir);
    for (const entry of entries) {
      if ((seen += 1) > MAX_WALK_ENTRIES) return null;
      const childRel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (dropDirs && DROP_IGNORED_DIRS.has(entry.name)) continue;
        stack.push(childRel);
      } else if (entry.isSymbolicLink() || entry.isFile()) {
        files.push(childRel);
        try { bytes += fs.lstatSync(path.join(copy, childRel)).size; } catch {}
      }
    }
  }
  return { files, empty, bytes };
}

// Empty folders anywhere in the copy, outside .git and the dropped folders.
function emptyFolders(copy) {
  const empty = [];
  const stack = [''];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(copy, dir), { withFileTypes: true }); } catch { continue; }
    if (!entries.length && dir) empty.push(dir);
    for (const entry of entries) {
      if ((seen += 1) > MAX_WALK_ENTRIES) return empty;
      if (!entry.isDirectory() || entry.name === '.git' || DROP_IGNORED_DIRS.has(entry.name)) continue;
      stack.push(dir ? `${dir}/${entry.name}` : entry.name);
    }
  }
  return empty;
}

// Things a put-away cannot hold correctly; the copy stays and the reason is shown.
function putAwayBlocker(copy) {
  const sparse = git(copy, ['config', '--bool', 'core.sparseCheckout']);
  if (out(sparse) === 'true') return 'it is a sparse checkout';
  const flags = git(copy, ['ls-files', '-v', '-z']);
  if (flags.status !== 0) return 'could not read its index';
  const hidden = String(flags.stdout || '').split('\0').filter((row) => row.startsWith('S '));
  if (hidden.length) return `skip-worktree hides edits in ${hidden[0].slice(2)}`;
  const staged = git(copy, ['ls-files', '-s', '-z']);
  for (const row of String(staged.stdout || '').split('\0')) {
    const match = row.match(/^160000 [0-9a-f]+ \d\t(.+)$/);
    if (!match) continue;
    let entries = [];
    try { entries = fs.readdirSync(path.join(copy, match[1])); } catch {}
    if (entries.length) return `submodule ${match[1]} is checked out, and removing the copy would drop its own git folder`;
  }
  return '';
}

// Sorts a copy. Returns { tracked, stagedNew, tarFiles, emptyDirs, bytes,
// dropped } or { error }. tracked: HEAD paths changed on disk or in the index.
// stagedNew: paths in the index but not in HEAD. tarFiles: everything HEAD
// does not track, kept on disk as is.
function classifyCopy(copy, { head } = {}) {
  const inHead = headPaths(copy, head);
  if (!inHead) return { error: 'could not list the files HEAD tracks' };
  const status = trackedStatus(copy);
  if (!status) return { error: 'could not read git status' };
  const tracked = [];
  const stagedNew = [];
  const tar = new Set();
  let bytes = 0;
  let dropped = 0;
  const addFile = (rel) => {
    if (tar.has(rel)) return;
    tar.add(rel);
    try { bytes += fs.lstatSync(path.join(copy, rel)).size; } catch {}
  };
  for (const row of status) {
    if (inHead.has(row.path)) {
      if (TOOL_REGENERATED_TRACKED.test(row.path) && isJson(readText(path.join(copy, row.path)))) { dropped += 1; continue; }
      tracked.push(row.path);
    } else if (row.code[0] !== ' ' && row.code[0] !== '?') {
      stagedNew.push(row.path);
      if (fs.existsSync(path.join(copy, row.path)) || isLink(path.join(copy, row.path))) addFile(row.path);
    }
  }
  const empty = new Set(emptyFolders(copy));
  // Untracked files git does not ignore: always saved, whatever their name.
  // A folder listed whole is its own repository; all of it is saved.
  const untracked = git(copy, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z']);
  if (untracked.status !== 0) return { error: 'could not list untracked files' };
  for (const entry of String(untracked.stdout || '').split('\0').filter(Boolean)) {
    const clean = entry.replace(/\/+$/, '');
    if (entry.endsWith('/')) {
      const walked = walkTree(copy, clean);
      if (!walked) return { error: `${clean} holds too many files to check` };
      walked.files.forEach(addFile);
      walked.empty.forEach((dir) => empty.add(dir));
    } else if (isToolFile(copy, clean)) {
      dropped += 1;
    } else {
      addFile(clean);
    }
  }
  // Ignored files: saved too, except ignored node_modules/ and .next/.
  const ignored = git(copy, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (ignored.status !== 0) return { error: 'could not list the files git ignores' };
  for (const entry of String(ignored.stdout || '').split('\0').filter(Boolean)) {
    const clean = entry.replace(/\/+$/, '');
    if (inDroppedDir(clean)) { dropped += 1; continue; }
    let stat;
    try { stat = fs.lstatSync(path.join(copy, clean)); } catch { continue; }
    if (stat.isDirectory()) {
      const walked = walkTree(copy, clean, { dropDirs: true });
      if (!walked) return { error: `${clean} holds too many ignored files to check` };
      for (const rel of walked.files) {
        if (isToolFile(copy, rel)) dropped += 1;
        else addFile(rel);
      }
      walked.empty.forEach((dir) => empty.add(dir));
      try { if (!fs.readdirSync(path.join(copy, clean)).length) empty.add(clean); } catch {}
    } else if (isToolFile(copy, clean)) {
      dropped += 1;
    } else {
      addFile(clean);
    }
  }
  // Folders that only held dropped things are not "empty" in any useful way.
  for (const dir of [...empty]) if (inDroppedDir(dir)) empty.delete(dir);
  return { tracked, stagedNew, tarFiles: [...tar], emptyDirs: [...empty].sort(), bytes, dropped, inHead };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function isLink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Put away.

function commitEnv(copy) {
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
  if (!out(git(copy, ['config', 'user.email']))) {
    env.GIT_AUTHOR_EMAIL = '299057014+atris-builder[bot]@users.noreply.github.com';
    env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  }
  if (!out(git(copy, ['config', 'user.name']))) {
    env.GIT_AUTHOR_NAME = 'atris worktree sweep';
    env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  }
  return env;
}

function tempIndex() {
  return path.join(os.tmpdir(), `atris-put-away-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.index`);
}

// HEAD plus the tracked changes as they are on disk, through a throwaway
// index. Only HEAD paths can enter it.
function workTree(copy, tracked) {
  const index = tempIndex();
  const env = { ...commitEnv(copy), GIT_INDEX_FILE: index };
  try {
    const read = git(copy, ['read-tree', 'HEAD'], { env });
    if (read.status !== 0) return { error: `could not read HEAD: ${failText(read)}` };
    if (tracked.length) {
      const added = git(copy, ['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: `${tracked.join('\0')}\0` });
      if (added.status !== 0) return { error: `could not stage the tracked changes: ${failText(added)}` };
    }
    const tree = git(copy, ['write-tree'], { env });
    if (tree.status !== 0) return { error: `could not write the work tree: ${failText(tree)}` };
    return { tree: out(tree) };
  } finally {
    try { fs.rmSync(index, { force: true }); } catch {}
  }
}

// The staged state of HEAD paths, from a copy of the real index with the
// staged new files taken out (those go into staged.tar instead).
function stagedTree(copy, stagedNew) {
  const real = out(git(copy, ['rev-parse', '--path-format=absolute', '--git-path', 'index']));
  if (!real || !fs.existsSync(real)) return { tree: '' };
  const index = tempIndex();
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1' };
  try {
    fs.copyFileSync(real, index);
    if (stagedNew.length) {
      const removed = git(copy, ['update-index', '-z', '--force-remove', '--stdin'], { env, input: `${stagedNew.join('\0')}\0` });
      if (removed.status !== 0) return { error: `could not read the staged state: ${failText(removed)}` };
    }
    const tree = git(copy, ['write-tree'], { env });
    return tree.status === 0 ? { tree: out(tree) } : { error: 'could not read the staged state' };
  } catch (error) {
    return { error: `could not read the staged state: ${error.message}` };
  } finally {
    try { fs.rmSync(index, { force: true }); } catch {}
  }
}

// The index entries of staged new files: path -> { mode, oid }.
function stagedEntries(copy, paths) {
  if (!paths.length) return new Map();
  const listed = git(copy, ['ls-files', '-s', '-z', '--', ...paths], { env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
  const map = new Map();
  for (const row of String(listed.stdout || '').split('\0').filter(Boolean)) {
    const match = row.match(/^(\d+) ([0-9a-f]+) 0\t(.+)$/s);
    if (match) map.set(match[3], { mode: match[1], oid: match[2] });
  }
  return map;
}

function treeEntries(copy, tree) {
  const listed = git(copy, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  if (listed.status !== 0) return null;
  const map = new Map();
  for (const row of String(listed.stdout || '').split('\0').filter(Boolean)) {
    const match = row.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s);
    if (match) map.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
  }
  return map;
}

// Tracked paths whose bytes, link or mode on disk the tree does not hold
// exactly. Every tracked file is checked, so text that a filter, ident or
// assume-unchanged hides from git status is caught.
function treeMismatches(copy, entries, { skip = new Set() } = {}) {
  const files = [];
  const mismatched = [];
  for (const [rel, entry] of entries) {
    if (entry.type !== 'blob' || skip.has(rel)) continue;
    let stat;
    try { stat = fs.lstatSync(path.join(copy, rel)); } catch { return { missing: rel }; }
    if (entry.mode === '120000') {
      if (!stat.isSymbolicLink()) { mismatched.push(rel); continue; }
      const hashed = git(copy, ['hash-object', '--stdin'], { input: fs.readlinkSync(path.join(copy, rel)) });
      if (hashed.status !== 0) return null;
      if (out(hashed) !== entry.oid) mismatched.push(rel);
      continue;
    }
    if (!stat.isFile()) { mismatched.push(rel); continue; }
    if ((entry.mode === '100755') !== ((stat.mode & 0o111) !== 0)) { mismatched.push(rel); continue; }
    files.push({ rel, oid: entry.oid });
  }
  for (let i = 0; i < files.length; i += 2000) {
    const batch = files.slice(i, i + 2000);
    const hashed = git(copy, ['hash-object', '--no-filters', '--stdin-paths'], { input: `${batch.map((file) => file.rel).join('\n')}\n` });
    if (hashed.status !== 0) return null;
    const oids = String(hashed.stdout || '').split('\n').filter(Boolean);
    if (oids.length !== batch.length) return null;
    batch.forEach((file, at) => { if (oids[at] !== file.oid) mismatched.push(file.rel); });
  }
  return { mismatched };
}

function same(a, b) {
  let x;
  let y;
  try { x = fs.lstatSync(a); y = fs.lstatSync(b); } catch { return false; }
  if (x.isSymbolicLink() || y.isSymbolicLink()) {
    return x.isSymbolicLink() && y.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
  }
  if (x.isDirectory() || y.isDirectory()) return x.isDirectory() && y.isDirectory();
  return x.isFile() && y.isFile() && x.size === y.size && (x.mode & 0o111) === (y.mode & 0o111) && sha256(a) === sha256(b);
}

// Commits only the copy's own HEAD history still reaches (a reset or a
// finished rebase left them behind). Removing the copy deletes that history,
// so they are pinned as extra parents of the put-away commit.
function historyOnlyCommits(copy, head) {
  const logged = out(git(copy, ['reflog', 'show', '--format=%H', 'HEAD'])).split('\n').filter((sha) => /^[0-9a-f]{7,}$/.test(sha));
  // The newest 500 entries, so one huge history cannot stall a sweep, and
  // only ones whose commit still exists.
  const wanted = [...new Set(logged)].filter((sha) => sha !== head).slice(0, 500);
  if (!wanted.length) return [];
  const present = git(copy, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${wanted.join('\n')}\n` });
  const shas = String(present.stdout || '').split('\n').filter((row) => row.endsWith(' commit')).map((row) => row.split(' ')[0]);
  if (!shas.length) return [];
  const unreachable = git(copy, ['rev-list', ...shas, '--not', '--branches', '--tags', '--remotes', `--glob=${PUT_AWAY_REF_PREFIX}*`, head]);
  if (unreachable.status !== 0) return null;
  const lost = new Set(out(unreachable).split('\n').filter(Boolean));
  return shas.filter((sha) => lost.has(sha)).slice(0, 100);
}

// Writes a tar with mode 0600 from a list of entries under `root`, then
// reads it back: the listing must match and every entry, extracted again,
// must match the source.
function writeTar(root, entries, tarPath) {
  const listFile = `${tarPath}.list`;
  fs.writeFileSync(listFile, `${entries.join('\0')}\0`, { mode: 0o600 });
  let fd;
  try {
    fd = fs.openSync(tarPath, 'wx', 0o600);
    const made = spawnSync('tar', ['-cf', '-', '-C', root, '--no-recursion', '--null', '-T', listFile], {
      stdio: ['ignore', fd, 'pipe'], maxBuffer: MAX_BUFFER, timeout: 60 * 60 * 1000, killSignal: 'SIGKILL',
    });
    fs.closeSync(fd);
    fd = undefined;
    if (made.status !== 0) return `tar failed: ${String(made.stderr || '').trim().split('\n')[0] || made.status}`;
    fs.chmodSync(tarPath, 0o600);
    const listed = spawnSync('tar', ['-tf', tarPath], { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 30 * 60 * 1000 });
    if (listed.status !== 0) return 'could not read the tar back';
    const names = new Set(String(listed.stdout || '').split('\n').filter(Boolean).map((name) => name.replace(/^\.\//, '').replace(/\/+$/, '')));
    if (names.size !== entries.length || entries.some((entry) => !names.has(entry))) return 'the tar does not list every file';
    const check = fs.mkdtempSync(path.join(path.dirname(tarPath), '.verify-'));
    try {
      const unpacked = spawnSync('tar', ['-xpf', tarPath, '-C', check], { encoding: 'utf8', timeout: 60 * 60 * 1000 });
      if (unpacked.status !== 0) return 'could not unpack the tar to check it';
      for (const entry of entries) {
        if (!same(path.join(check, entry), path.join(root, entry))) return `the tar copy of ${entry} does not match`;
      }
    } finally {
      spawnSync('chmod', ['-R', 'u+rwx', check]);
      fs.rmSync(check, { recursive: true, force: true });
    }
    return '';
  } catch (error) {
    return `could not write the tar: ${String((error && error.message) || error)}`;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(listFile, { force: true }); } catch {}
  }
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/\.lock$/, '-lock') || 'copy';
}

// Claims a record folder and ref name for this run, both created
// exclusively: a folder another run made is never reused or deleted.
function claimName(base, primary, name, commit) {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const dir = path.join(base, candidate);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      return { error: `could not make ${dir}: ${error.code || error.message}` };
    }
    const ref = `${PUT_AWAY_REF_PREFIX}${candidate}`;
    const zero = '0'.repeat(commit.length);
    const made = git(primary, ['update-ref', ref, commit, zero]);
    if (made.status === 0) return { name: candidate, dir, ref };
    fs.rmdirSync(dir);
  }
  return { error: 'no free put-away name' };
}

function repoBase(primary, home) {
  return path.join(putAwayHome({ home }), repoKey(primary));
}

// Saves what removal would lose and checks the saved copy. Returns
// { ok: true, record, dir } or { ok: false, error }. Never touches the copy.
function putAwayCopy({ primary, copy, wt = {}, reason = 'idle', by = 'atris worktree sweep', home, now = Date.now() } = {}) {
  const blocker = putAwayBlocker(copy);
  if (blocker) return { ok: false, error: blocker };
  const head = out(git(copy, ['rev-parse', '--verify', 'HEAD^{commit}']));
  if (!head) return { ok: false, error: 'it has no commit to rebuild from' };
  const sorted = classifyCopy(copy, { head });
  if (sorted.error) return { ok: false, error: sorted.error };
  const headTree = out(git(copy, ['rev-parse', `${head}^{tree}`]));
  const built = workTree(copy, sorted.tracked);
  if (built.error) return { ok: false, error: built.error };
  const entries = treeEntries(copy, built.tree);
  if (!entries) return { ok: false, error: 'could not read the saved tree back' };
  for (const rel of entries.keys()) {
    if (!sorted.inHead.has(rel)) return { ok: false, error: `${rel} is not tracked by HEAD and must not enter the ref` };
  }
  const regenerated = new Set((trackedStatus(copy) || []).map((row) => row.path).filter((rel) => TOOL_REGENERATED_TRACKED.test(rel)));
  const checked = treeMismatches(copy, entries, { skip: regenerated });
  if (!checked) return { ok: false, error: 'could not compare the saved tree with the disk' };
  if (checked.missing) return { ok: false, error: `${checked.missing} is in the saved tree but not on disk` };
  const staged = stagedTree(copy, sorted.stagedNew);
  if (staged.error) return { ok: false, error: staged.error };
  const stagedIndex = stagedEntries(copy, sorted.stagedNew);
  if (stagedIndex.size !== sorted.stagedNew.length) return { ok: false, error: 'could not read the staged new files' };

  const tarFiles = [...new Set([...sorted.tarFiles, ...checked.mismatched])];
  const tarEntries = [...tarFiles, ...sorted.emptyDirs.filter((dir) => !tarFiles.some((file) => file.startsWith(`${dir}/`)))];
  let bytes = 0;
  for (const rel of tarFiles) { try { bytes += fs.lstatSync(path.join(copy, rel)).size; } catch {} }
  if (bytes > MAX_TAR_BYTES) {
    return { ok: false, error: `it holds ${(bytes / space.GB).toFixed(1)} GB of files git does not track, more than the 2 GB a put-away holds; move them out by hand` };
  }

  const lostCommits = historyOnlyCommits(copy, head);
  if (!lostCommits) return { ok: false, error: 'could not read the copy\'s HEAD history' };
  const gitDir = gitDirOf(copy);
  const reflogFile = gitDir ? path.join(gitDir, 'logs', 'HEAD') : '';
  const reflog = reflogFile && fs.existsSync(reflogFile) ? fs.readFileSync(reflogFile) : null;

  // The commit the ref pins: HEAD when there are no tracked changes, so a
  // detached or rebased-away commit stays reachable either way.
  const env = commitEnv(copy);
  const message = (title) => `${title}\n\nPut away by ${by} from ${copy} (${reason}).\n`;
  let parent = head;
  let stagedCommit = '';
  if (staged.tree && staged.tree !== headTree && staged.tree !== built.tree) {
    const made = git(copy, ['commit-tree', staged.tree, '-p', head, '-F', '-'], { env, input: message('Staged changes in a put-away build copy') });
    if (made.status !== 0) return { ok: false, error: `could not save the staged changes: ${failText(made)}` };
    stagedCommit = out(made);
    parent = stagedCommit;
  }
  let commit = head;
  if (built.tree !== headTree || stagedCommit || lostCommits.length) {
    const parents = [parent, ...lostCommits].flatMap((sha) => ['-p', sha]);
    const made = git(copy, ['commit-tree', built.tree, ...parents, '-F', '-'], { env, input: message('Tracked changes in a put-away build copy') });
    if (made.status !== 0) return { ok: false, error: `could not save the tracked changes: ${failText(made)}` };
    commit = out(made);
  }

  const base = repoBase(primary, home);
  let claimed;
  try {
    claimed = claimName(base, primary, safeName(path.basename(copy)), commit);
  } catch (error) {
    return { ok: false, error: `could not make the put-away folder: ${error.code || error.message}` };
  }
  if (claimed.error) return { ok: false, error: claimed.error };
  const { name, dir, ref } = claimed;
  // Only this run's own folder and ref are ever undone.
  const fail = (error) => {
    git(primary, ['update-ref', '-d', ref, commit]);
    try { spawnSync('chmod', ['-R', 'u+rwx', dir]); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error };
  };
  const readBack = git(primary, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (out(readBack) !== commit) return fail('the put-away ref does not read back');

  let tar = '';
  if (tarEntries.length) {
    tar = path.join(dir, 'ignored.tar');
    const problem = writeTar(copy, tarEntries, tar);
    if (problem) return fail(problem);
  }
  let stagedTar = '';
  if (sorted.stagedNew.length) {
    const src = path.join(dir, '.staged-src');
    try {
      for (const rel of sorted.stagedNew) {
        const blob = git(copy, ['cat-file', 'blob', stagedIndex.get(rel).oid], { encoding: 'buffer' });
        if (blob.status !== 0) return fail(`could not read the staged version of ${rel}`);
        fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(src, rel), blob.stdout, { mode: 0o600 });
      }
      stagedTar = path.join(dir, 'staged.tar');
      const problem = writeTar(src, sorted.stagedNew, stagedTar);
      if (problem) return fail(problem);
    } finally {
      try { fs.rmSync(src, { recursive: true, force: true }); } catch {}
    }
  }

  let savedReflog = '';
  if (reflog) {
    savedReflog = path.join(dir, 'head.reflog');
    try {
      fs.writeFileSync(savedReflog, reflog, { mode: 0o600, flag: 'wx' });
      if (!fs.readFileSync(savedReflog).equals(reflog)) return fail('the HEAD history does not read back');
    } catch (error) {
      return fail(`could not save the HEAD history: ${error.code || error.message}`);
    }
  }

  const record = {
    version: 2,
    name,
    repo: primary,
    repo_name: path.basename(primary),
    path: copy,
    branch: wt.branch && wt.branch !== 'detached' ? wt.branch : null,
    head,
    ref,
    commit,
    tracked_changes: built.tree !== headTree,
    staged_tree: staged.tree || headTree,
    staged_commit: stagedCommit || null,
    staged_new: sorted.stagedNew.map((rel) => ({ path: rel, ...stagedIndex.get(rel) })),
    staged_tar: stagedTar || null,
    history_commits: lostCommits,
    head_reflog: savedReflog || null,
    tar: tar || null,
    tar_files: tarFiles.length,
    empty_dirs: sorted.emptyDirs,
    tracked_files: sorted.tracked.length,
    at: new Date(now).toISOString(),
    reason,
    by,
  };
  try {
    fs.writeFileSync(path.join(dir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const back = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8'));
    if (back.name !== name || back.head !== head || back.commit !== commit) return fail('the record does not read back');
  } catch (error) {
    return fail(`could not write the record: ${error.code || error.message}`);
  }
  return { ok: true, record, dir, undo: () => fail('undone') };
}

function logRemoval(primary, entry) {
  try {
    const file = path.join(primary, '.atris', 'state', 'worktree_removals.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  } catch {}
}

function snapshot(copy) {
  const status = git(copy, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames']);
  return { status: status.status === 0 ? String(status.stdout || '') : null, newestMs: newestChangeMs(copy) };
}

// Puts a copy away and removes it. Call with the repo lock held. The copy is
// deleted only after the saved work was read back and a fresh check finds it
// unchanged and unused; anything that fails leaves it as it was.
function removeCopy({ primary, copy, wt = {}, reason = 'idle', by = 'atris worktree sweep', home, now = Date.now(), current = process.cwd(), scan = listOpenPaths, hooks = {}, log = {} } = {}) {
  const kib = copyKib(copy, { primary });
  const before = snapshot(copy);
  if (before.status === null) return { removed: false, reason: 'put_away_failed', text: 'put-away failed: could not read git status' };
  const put = putAwayCopy({ primary, copy, wt, reason, by, home, now });
  if (!put.ok) return { removed: false, reason: 'put_away_failed', text: `put-away failed: ${put.error}` };
  if (typeof hooks.afterPutAway === 'function') hooks.afterPutAway({ copy, record: put.record });
  // Right before the delete: nothing changed while it was saved, and nobody
  // picked it up meanwhile.
  const after = snapshot(copy);
  if (after.status !== before.status || after.newestMs > before.newestMs) {
    put.undo();
    return { removed: false, reason: 'changed', text: 'it changed while its work was being put away' };
  }
  const fresh = listWorktrees(primary) || [];
  const entry = fresh.find((item) => canonical(item.path) === canonical(copy)) || wt;
  const busy = copyInUse(copy, { wt: entry, open: scan(), idleMs: 0, now, current });
  if (busy) {
    put.undo();
    return { removed: false, reason: busy.reason, text: busy.text };
  }
  const removed = git(primary, ['worktree', 'remove', '--force', copy]);
  if (fs.existsSync(copy)) {
    // git may have deleted part of the folder before it stopped. The
    // verified put-away stays: it may now be the only copy of the work. The
    // half-deleted copy is locked so no later sweep saves its gaps as
    // deletions, and restore moves it aside.
    git(primary, ['worktree', 'lock', '--reason', `put away as ${put.record.name}; the delete stopped halfway, restore with atris worktree restore ${put.record.name}`, copy]);
    try {
      const file = path.join(put.dir, 'record.json');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, `${JSON.stringify({ ...record, removal_failed: true }, null, 2)}\n`, { mode: 0o600 });
    } catch {}
    return {
      removed: false,
      reason: 'remove_failed',
      text: `git would not remove it (${failText(removed)}); its work stays put away as ${put.record.name}`,
      record: put.record,
    };
  }
  git(primary, ['worktree', 'prune']);
  logRemoval(primary, { path: copy, branch: wt.branch || null, by, reason, put_away: put.record.name, ref: put.record.ref, tar: put.record.tar, size_kib: kib, ...log });
  return { removed: true, kib, record: put.record };
}

// ---------------------------------------------------------------------------
// Leftovers from a crash.

// Under the repo lock: a record folder without record.json is a put-away
// that died before it finished (the copy was never deleted, since the
// record is written first), and a ref with no record behind it is the same.
// Both go. Scratch files inside finished records go too.
function cleanLeftovers(primary, { home } = {}) {
  const base = repoBase(primary, home);
  const cleaned = [];
  const names = new Set();
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (entry.name.includes('.leftover-')) continue;
    if (!fs.existsSync(path.join(dir, 'record.json'))) {
      spawnSync('chmod', ['-R', 'u+rwx', dir]);
      fs.rmSync(dir, { recursive: true, force: true });
      cleaned.push(dir);
      continue;
    }
    names.add(entry.name);
    for (const child of fs.readdirSync(dir)) {
      if (child.startsWith('.verify-') || child === '.staged-src' || child.endsWith('.list')) {
        fs.rmSync(path.join(dir, child), { recursive: true, force: true });
      }
    }
  }
  const refs = out(git(primary, ['for-each-ref', '--format=%(refname)', PUT_AWAY_REF_PREFIX])).split('\n').filter(Boolean);
  for (const ref of refs) {
    if (names.has(ref.slice(PUT_AWAY_REF_PREFIX.length))) continue;
    git(primary, ['update-ref', '-d', ref]);
    cleaned.push(ref);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Sweep.

// The branch merged work lands on, from local refs only (no network).
function mainlineRef(primary) {
  const head = out(git(primary, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']));
  if (head && git(primary, ['rev-parse', '--verify', '--quiet', head]).status === 0) return head;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git(primary, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0) return ref;
  }
  return '';
}

// True when the copy's branch made commits of its own and all of them are now
// in the main branch. A copy fresh off main has done nothing yet.
function mergedOwnWork(primary, wt, base) {
  if (!base || !wt.head || !wt.branch || wt.branch === 'detached') return false;
  if (git(primary, ['merge-base', '--is-ancestor', wt.head, base]).status !== 0) return false;
  const shas = out(git(primary, ['reflog', 'show', '--format=%H', `refs/heads/${wt.branch}`])).split('\n').filter(Boolean);
  return shas.length > 0 && shas[shas.length - 1] !== wt.head;
}

// Nothing to save but commits: no tracked change, no staged change, no file
// HEAD does not track.
function onlyCommits(copy) {
  const head = out(git(copy, ['rev-parse', '--verify', 'HEAD^{commit}']));
  if (!head) return false;
  const sorted = classifyCopy(copy, { head });
  return !sorted.error && !sorted.tracked.length && !sorted.stagedNew.length && !sorted.tarFiles.length;
}

// The copies of one repo that atris made, wherever they live.
function toolCopies(primary) {
  const list = listWorktrees(primary);
  if (!list || !list.length) return null;
  return list.slice(1).filter((wt) => !wt.bare && !wt.prunable && fs.existsSync(wt.path) && isToolCopy(wt.path));
}

function orphanFolders(workspace, primary, registered) {
  const dir = path.join(workspace, space.AGENT_COPIES_DIR, path.basename(primary));
  const known = new Set(registered.map((item) => canonical(item)));
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(dir, entry.name))
    .filter((full) => !known.has(canonical(full)));
}

function onlyEmptyFolders(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      stack.push(path.join(current, entry.name));
    }
  }
  return true;
}

const LOCKED_TEXT = 'another sweep is already running on this repo';

function sweepRepo({ repo, workspace, apply = false, idleMs, now = Date.now(), current = process.cwd(), home, by = 'atris worktree sweep', scan = listOpenPaths, hooks = {} }) {
  const primary = primaryOf(repo);
  if (!primary) return { name: path.basename(repo), root: repo, error: 'git could not list its copies' };
  const report = { name: path.basename(primary), root: primary, seen: 0, removed: [], kept: [], orphans: [], emptied: [], cleaned: [] };
  const release = apply ? lockRepo(primary, { now }) : () => {};
  if (!release) return { ...report, skipped: LOCKED_TEXT };
  try {
    if (apply) report.cleaned = cleanLeftovers(primary, { home });
    const copies = toolCopies(primary);
    if (!copies) return { ...report, error: 'git could not list its copies' };
    const base = mainlineRef(primary);
    const open = scan();
    report.process_scan = Array.isArray(open);
    for (const wt of copies) {
      report.seen += 1;
      const item = { path: wt.path, name: path.basename(wt.path), branch: wt.branch };
      let use = copyInUse(wt.path, { wt, open, idleMs, now, current });
      let reason = 'idle';
      // A copy whose branch landed and holds nothing but commits goes right
      // away. A lock, an open file or a merge in progress still keeps it.
      if (use && use.reason === 'recent' && mergedOwnWork(primary, wt, base) && onlyCommits(wt.path)) {
        use = null;
        reason = 'merged';
      } else if (!use && mergedOwnWork(primary, wt, base)) {
        reason = 'merged';
      }
      if (use) {
        report.kept.push({ ...item, reason: use.reason, text: use.text });
        continue;
      }
      if (!apply) {
        report.removed.push({ ...item, reason, dryRun: true, kib: copyKib(wt.path, { primary }) });
        continue;
      }
      const result = removeCopy({ primary, copy: wt.path, wt, reason, by, home, now, current, scan, hooks });
      if (result.removed) report.removed.push({ ...item, reason, kib: result.kib, record: result.record });
      else report.kept.push({ ...item, reason: result.reason, text: result.text });
    }
    if (workspace) {
      for (const orphan of orphanFolders(workspace, primary, (listWorktrees(primary) || []).map((wt) => wt.path))) {
        if (onlyEmptyFolders(orphan)) {
          if (apply) { try { fs.rmSync(orphan, { recursive: true }); } catch {} }
          report.emptied.push(orphan);
        } else {
          report.orphans.push(orphan);
        }
      }
    }
    if (apply) {
      git(primary, ['worktree', 'prune']);
      report.pruned = pruneRepoRecords(primary, { home, now });
    }
    return report;
  } finally {
    release();
  }
}

// Repos to sweep: every <workspace>/<name> with copies under
// <workspace>/.agent-worktrees/<name>, plus any extra repo given (the one the
// command runs in), each once.
function sweepTargets(workspace, extraRepos = []) {
  const targets = [];
  const seen = new Set();
  const add = (repo) => {
    const primary = primaryOf(repo);
    if (!primary || seen.has(canonical(primary))) return;
    seen.add(canonical(primary));
    targets.push(primary);
  };
  for (const repo of space.agentCopyRepos(workspace)) add(repo.root);
  for (const repo of extraRepos) if (repo) add(repo);
  return targets;
}

function sweep({ workspace, repos: extraRepos = [], apply = false, idleMs, allowShortIdle = false, now = Date.now(), current = process.cwd(), home, by = 'atris worktree sweep', freeSpace = space.freeBytes, env = process.env, scan = listOpenPaths, hooks = {} } = {}) {
  const root = path.resolve(workspace);
  const idle = clampIdle(Number.isFinite(idleMs) ? idleMs : idleMsFromEnv(env), { allowShortIdle });
  const report = { workspace: root, apply, idle_ms: idle, process_scan: true, before: freeSpace(root), after: null, repos: [] };
  for (const repo of sweepTargets(root, extraRepos)) {
    try {
      const done = sweepRepo({ repo, workspace: root, apply, idleMs: idle, now, current, home, by, scan, hooks });
      if (done.process_scan === false) report.process_scan = false;
      report.repos.push(done);
    } catch (error) {
      report.repos.push({ name: path.basename(repo), root: repo, error: String((error && error.message) || error) });
    }
  }
  report.records = recordSpace({ home });
  report.after = freeSpace(root);
  return report;
}

function sweepTotals(report) {
  const totals = { seen: 0, removed: 0, putAway: 0, kept: 0, kib: 0, why: {} };
  for (const repo of report.repos || []) {
    totals.seen += repo.seen || 0;
    for (const item of repo.removed || []) {
      totals.removed += 1;
      totals.kib += item.kib || 0;
      if (item.record && (item.record.tar || item.record.tracked_changes || item.record.staged_tar)) totals.putAway += 1;
    }
    for (const item of repo.kept || []) {
      totals.kept += 1;
      totals.why[item.reason] = (totals.why[item.reason] || 0) + 1;
    }
  }
  return totals;
}

const KEPT_WORDS = {
  locked: 'locked',
  current: 'this command runs inside it',
  in_progress: 'a merge or rebase in progress',
  process: 'in use by a running program',
  recent: 'changed recently',
  put_away_failed: 'put-away failed',
  changed: 'changed during the sweep',
  remove_failed: 'git would not remove it',
};

function recordsLine(records) {
  if (!records || !records.count) return 'no put-away records';
  return `${records.count} put-away ${records.count === 1 ? 'record holds' : 'records hold'} ${formatKib(records.kib)}`;
}

// One line per run for the job's log.
function sweepLogLine(report, { now = Date.now() } = {}) {
  const t = sweepTotals(report);
  const why = Object.entries(t.why).map(([reason, count]) => `${count} ${KEPT_WORDS[reason] || reason}`).join(', ');
  const busy = (report.repos || []).filter((repo) => repo.skipped).length;
  const freed = Number.isFinite(report.before) && Number.isFinite(report.after) && report.after > report.before
    ? `${((report.after - report.before) / space.GB).toFixed(1)} GB` : '0.0 GB';
  const notes = [];
  if (busy) notes.push(`${busy} ${busy === 1 ? 'repo' : 'repos'} skipped, another sweep was running`);
  if (!report.process_scan) notes.push('could not list running programs, so only the time rule protected copies');
  return `${new Date(now).toISOString()} sweep ${report.workspace}: seen ${t.seen}, removed ${t.removed} (put away ${t.putAway}), kept ${t.kept}${why ? ` (${why})` : ''}, freed ${freed} (${formatKib(t.kib)} by size), ${recordsLine(report.records)}${notes.length ? `; ${notes.join('; ')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Ceiling, and low disk.

// Before a new copy: when this repo's copies are more than allowed or hold
// more than the size limit, its copies idle for the normal window go,
// oldest first. Other repos and hand-made copies are never touched. When
// nothing qualifies, the start goes ahead and says space is tight.
function enforceCeiling({ repo, env = process.env, now = Date.now(), current = process.cwd(), home, by = 'atris worktree start', scan = listOpenPaths, idleMs, allowShortIdle = false } = {}) {
  const limits = ceilingFromEnv(env);
  const result = { ...limits, removed: [], kept: [], over: false, checked: false };
  const primary = primaryOf(repo);
  if (!primary) return result;
  const copies = toolCopies(primary);
  if (!copies) return result;
  const items = copies.map((wt) => ({ wt, path: wt.path }));
  let sizes = null;
  const totalBytes = () => {
    if (!sizes) {
      sizes = new Map();
      for (const item of items) sizes.set(item.path, copyKib(item.path, { primary }));
    }
    return items.filter((item) => !item.gone).reduce((sum, item) => sum + (sizes.get(item.path) || 0) * 1024, 0);
  };
  const countOver = () => limits.maxPerRepo > 0 && items.filter((item) => !item.gone).length + 1 > limits.maxPerRepo;
  const sizeOver = () => limits.maxBytes > 0 && totalBytes() > limits.maxBytes;
  if (!countOver() && !sizeOver()) return result;
  result.checked = true;
  const release = lockRepo(primary, { now });
  if (!release) {
    result.over = true;
    result.busy = true;
    return result;
  }
  try {
    const idle = clampIdle(Number.isFinite(idleMs) ? idleMs : idleMsFromEnv(env), { allowShortIdle });
    const open = scan();
    for (const item of items) item.newest = newestChangeMs(item.path);
    for (const item of [...items].sort((a, b) => a.newest - b.newest)) {
      if (!countOver() && !sizeOver()) break;
      const use = copyInUse(item.path, { wt: item.wt, open, idleMs: idle, now, current });
      if (use) {
        result.kept.push({ path: item.path, name: path.basename(item.path), kib: sizes ? sizes.get(item.path) || 0 : 0, text: use.text });
        continue;
      }
      const done = removeCopy({ primary, copy: item.path, wt: item.wt, reason: 'ceiling', by, home, now, current, scan });
      if (done.removed) {
        item.gone = true;
        result.removed.push({ path: item.path, kib: done.kib, record: done.record });
      } else {
        result.kept.push({ path: item.path, name: path.basename(item.path), kib: sizes ? sizes.get(item.path) || 0 : 0, text: done.text });
      }
    }
    result.over = countOver() || sizeOver();
    return result;
  } finally {
    release();
  }
}

function ceilingLine(result) {
  if (!result || !result.checked) return '';
  const lines = [];
  if (result.removed.length) {
    lines.push(`ceiling: put away and removed ${result.removed.length} idle ${result.removed.length === 1 ? 'copy' : 'copies'} of this repo (${formatKib(result.removed.reduce((sum, item) => sum + (item.kib || 0), 0))}); nothing was lost, atris worktree restore <name> brings one back`);
  }
  if (result.over) {
    const why = result.busy
      ? 'a sweep is running on this repo'
      : `none of the rest has sat unused for a day${result.kept.length ? ` (${result.kept.slice(0, 4).map((item) => `${item.name} ${formatKib(item.kib)}, ${item.text}`).join('; ')})` : ''}`;
    lines.push(`ceiling: space is tight, this repo is over ${result.maxPerRepo} copies or ${(result.maxBytes / space.GB).toFixed(0)} GB and ${why}; starting anyway`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Restore, list, prune.

function readRecords({ home } = {}) {
  const base = putAwayHome({ home });
  const records = [];
  let repos = [];
  try { repos = fs.readdirSync(base, { withFileTypes: true }); } catch { return records; }
  for (const repo of repos) {
    if (!repo.isDirectory()) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(base, repo.name), { withFileTypes: true }); } catch { continue; }
    for (const name of names) {
      if (!name.isDirectory()) continue;
      const dir = path.join(base, repo.name, name.name);
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8'));
        records.push({ ...record, dir });
      } catch {}
    }
  }
  return records.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function recordSpace({ home } = {}) {
  const records = readRecords({ home });
  let kib = 0;
  for (const record of records) kib += duKib(record.dir);
  return { count: records.length, kib };
}

function findRecord(name, { home, repo } = {}) {
  const matches = readRecords({ home }).filter((record) => record.name === name
    && (!repo || record.repo_name === repo || canonical(record.repo) === canonical(repo)));
  if (!matches.length) return { error: `nothing called ${name} is put away (atris worktree put-away list shows what is)` };
  if (matches.length > 1) return { error: `${matches.length} repos have a copy called ${name}; add --repo <name>` };
  return { record: matches[0] };
}

function walkAll(root) {
  const list = [];
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (!dir && entry.name === '.git') continue;
      if (entry.isDirectory()) stack.push(rel);
      else list.push(rel);
    }
  }
  return list;
}

// Rebuilds a put-away copy at its old path: its branch (or its old HEAD if
// the branch moved), tracked changes unstaged and the staged state staged as
// before, every untracked file, link and empty folder unpacked.
function restoreCopy({ name, home, repo, target } = {}) {
  const found = findRecord(name, { home, repo });
  if (found.error) return { ok: false, error: found.error };
  const record = found.record;
  if (!fs.existsSync(path.join(record.repo, '.git'))) return { ok: false, error: `the repo ${record.repo} is gone` };
  const release = lockRepo(record.repo);
  if (!release) return { ok: false, error: `${LOCKED_TEXT}; try again in a minute` };
  try {
    const dest = path.resolve(target || record.path);
    const notes = [];
    let leftover = '';
    if (fs.existsSync(dest) && !onlyEmptyFolders(dest)) {
      // Something is at the old path, most likely what a delete that stopped
      // halfway left behind. It is moved aside, never deleted, and dropped
      // below only if the restored copy holds every byte of it.
      const listed = (listWorktrees(record.repo) || []).find((wt) => canonical(wt.path) === canonical(dest));
      if (listed && listed.locked) git(record.repo, ['worktree', 'unlock', dest]);
      leftover = path.join(path.dirname(record.dir), `${record.name}.leftover-${Date.now()}`);
      try {
        fs.renameSync(dest, leftover);
      } catch (error) {
        return { ok: false, error: `${dest} already exists and could not be moved aside (${error.code}); move it yourself and retry` };
      }
      git(record.repo, ['worktree', 'prune']);
    }
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let added;
    const tip = record.branch ? out(git(record.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`])) : '';
    if (record.branch && tip === record.head) {
      added = git(record.repo, ['worktree', 'add', dest, record.branch]);
    } else if (record.branch && !tip) {
      added = git(record.repo, ['worktree', 'add', '-b', record.branch, dest, record.head]);
    } else {
      if (record.branch) notes.push(`${record.branch} has moved on since, so the copy is at its old commit, detached`);
      added = git(record.repo, ['worktree', 'add', '--detach', dest, record.head]);
    }
    if (added.status !== 0) return { ok: false, error: `git could not make the copy: ${failText(added)}` };
    if (record.commit && record.commit !== record.head) {
      // Plumbing diff with fixed prefixes, so no user diff setting can change it.
      const diff = git(record.repo, ['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', record.head, record.commit], { encoding: 'buffer' });
      if (diff.status !== 0) return { ok: false, error: 'could not read the saved tracked changes' };
      if (diff.stdout && diff.stdout.length) {
        const applied = git(dest, ['apply', '--whitespace=nowarn', '--binary'], { input: diff.stdout });
        if (applied.status !== 0) return { ok: false, error: `could not put the tracked changes back: ${failText(applied)}; they are still on ${record.ref}` };
      }
    }
    if (record.tar) {
      const unpacked = spawnSync('tar', ['-xpf', record.tar, '-C', dest], { encoding: 'utf8', timeout: 60 * 60 * 1000 });
      if (unpacked.status !== 0) return { ok: false, error: `could not unpack ${record.tar}: ${String(unpacked.stderr || '').trim()}` };
    }
    for (const dir of record.empty_dirs || []) fs.mkdirSync(path.join(dest, dir), { recursive: true });
    // The old HEAD history goes back in front of the new copy's, so commits
    // only it reached stay reachable as they were before.
    if (record.head_reflog && fs.existsSync(record.head_reflog)) {
      const newLog = path.join(gitDirOf(dest), 'logs', 'HEAD');
      try {
        const now = fs.existsSync(newLog) ? fs.readFileSync(newLog) : Buffer.alloc(0);
        fs.mkdirSync(path.dirname(newLog), { recursive: true });
        fs.writeFileSync(newLog, Buffer.concat([fs.readFileSync(record.head_reflog), now]));
      } catch (error) {
        return { ok: false, error: `could not put the HEAD history back: ${error.code || error.message}` };
      }
    }
    // The staged state: HEAD paths as they were staged, then staged new files.
    const headTree = out(git(dest, ['rev-parse', `${record.head}^{tree}`]));
    if ((record.staged_tree && record.staged_tree !== headTree) || (record.staged_new || []).length) {
      const read = git(dest, ['read-tree', record.staged_tree || headTree]);
      if (read.status !== 0) return { ok: false, error: `could not put the staged state back: ${failText(read)}` };
      if ((record.staged_new || []).length) {
        const src = fs.mkdtempSync(path.join(path.dirname(record.dir), '.staged-'));
        try {
          const unpacked = spawnSync('tar', ['-xf', record.staged_tar, '-C', src], { encoding: 'utf8' });
          if (unpacked.status !== 0) return { ok: false, error: 'could not unpack the staged new files' };
          for (const item of record.staged_new) {
            const hashed = git(dest, ['hash-object', '-w', '--no-filters', path.join(src, item.path)]);
            if (out(hashed) !== item.oid) return { ok: false, error: `the staged version of ${item.path} did not come back intact` };
            const placed = git(dest, ['update-index', '--add', '--cacheinfo', `${item.mode},${item.oid},${item.path}`]);
            if (placed.status !== 0) return { ok: false, error: `could not stage ${item.path} again: ${failText(placed)}` };
          }
        } finally {
          fs.rmSync(src, { recursive: true, force: true });
        }
      }
      git(dest, ['update-index', '-q', '--refresh']);
    }
    if (leftover) {
      const covered = walkAll(leftover).every((rel) => fs.existsSync(path.join(dest, rel)) || isLink(path.join(dest, rel))
        ? same(path.join(leftover, rel), path.join(dest, rel)) : false);
      if (covered) {
        spawnSync('chmod', ['-R', 'u+rwx', leftover]);
        fs.rmSync(leftover, { recursive: true, force: true });
      } else {
        notes.push(`what was left at the old path differs from the put-away, so it is kept at ${leftover}`);
      }
    }
    git(record.repo, ['update-ref', '-d', record.ref, record.commit]);
    spawnSync('chmod', ['-R', 'u+rwx', record.dir]);
    fs.rmSync(record.dir, { recursive: true, force: true });
    return { ok: true, path: dest, record, notes };
  } finally {
    release();
  }
}

// A record holds unsaved work unless it is nothing but commits: no tar of
// any kind and a saved tree equal to HEAD's, staged state included.
function holdsOnlyCommits(record) {
  if (record.tar || record.staged_tar || (record.staged_new || []).length) return false;
  if (record.tracked_changes || record.staged_commit || (record.history_commits || []).length) return false;
  return record.commit === record.head;
}

// Records older than 30 days go only when they hold nothing but commits
// that are already in the main branch. Anything else stays until a person
// drops it by name. Call with the repo lock held.
function pruneRepoRecords(primary, { home, now = Date.now(), maxAgeMs = PRUNE_AFTER_MS } = {}) {
  const pruned = [];
  const base = mainlineRef(primary);
  for (const record of readRecords({ home })) {
    if (canonical(record.repo) !== canonical(primary)) continue;
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || now - at < maxAgeMs || !holdsOnlyCommits(record)) continue;
    if (!base || git(primary, ['merge-base', '--is-ancestor', record.head, base]).status !== 0) continue;
    git(primary, ['update-ref', '-d', record.ref, record.commit]);
    fs.rmSync(record.dir, { recursive: true, force: true });
    pruned.push(record);
  }
  return pruned;
}

function prunePutAway({ home, now = Date.now() } = {}) {
  const pruned = [];
  const busy = [];
  const repos = [...new Set(readRecords({ home }).map((record) => record.repo))];
  for (const repo of repos) {
    if (!fs.existsSync(path.join(repo, '.git'))) continue;
    const release = lockRepo(repo, { now });
    if (!release) { busy.push(repo); continue; }
    try { pruned.push(...pruneRepoRecords(repo, { home, now })); } finally { release(); }
  }
  return { pruned, kept: readRecords({ home }), busy };
}

// A person drops a record by name.
function dropRecord({ name, home, repo } = {}) {
  const found = findRecord(name, { home, repo });
  if (found.error) return { ok: false, error: found.error };
  const record = found.record;
  const release = fs.existsSync(path.join(record.repo, '.git')) ? lockRepo(record.repo) : () => {};
  if (!release) return { ok: false, error: `${LOCKED_TEXT}; try again in a minute` };
  try {
    if (fs.existsSync(path.join(record.repo, '.git'))) git(record.repo, ['update-ref', '-d', record.ref]);
    spawnSync('chmod', ['-R', 'u+rwx', record.dir]);
    fs.rmSync(record.dir, { recursive: true, force: true });
    return { ok: true, record };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// The installed job.

// What is wrong with an installed sweep job, or ''. A job that names an
// atris.js file runs that frozen copy forever; one that runs less often than
// hourly lets copies pile up between runs.
function sweepJobProblem(contents, { kind = 'launchd' } = {}) {
  const text = String(contents || '');
  if (!text.trim()) return '';
  const frozen = /atris\.js\b/.test(text);
  let schedule;
  if (kind === 'launchd') {
    const match = text.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    schedule = !match || Number(match[1]) !== 3600;
  } else {
    schedule = !/^0 (?:\*|\*\/1) \* \* \* /.test(text.trim());
  }
  if (frozen && schedule) return 'runs a frozen copy of atris on the wrong schedule';
  if (frozen) return 'runs a frozen copy of atris instead of the installed one';
  if (schedule) return 'runs on the wrong schedule (it should be hourly)';
  return '';
}

// Looks for installed sweep jobs and says what is wrong with them. Reads
// only; it never rewrites a job. `files` replaces the default search (tests).
function sweepJobHint({ files, homeDir = os.homedir(), platform = process.platform, run = spawnSync } = {}) {
  const problems = [];
  let list = files;
  if (!list) {
    list = [];
    if (platform === 'darwin') {
      const dir = path.join(homeDir, 'Library', 'LaunchAgents');
      try {
        for (const name of fs.readdirSync(dir)) if (/^ai\.atris\.worktree-sweep\..+\.plist$/.test(name)) list.push(path.join(dir, name));
      } catch {}
    }
  }
  for (const file of list) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const kind = file.endsWith('.plist') ? 'launchd' : 'cron';
    const lines = kind === 'cron' ? text.split('\n').filter((line) => line.includes('ATRIS_WORKTREE_SWEEP')) : [text];
    for (const line of lines) {
      const problem = sweepJobProblem(line, { kind });
      if (problem) problems.push(problem);
    }
  }
  if (!files && platform !== 'darwin') {
    const listed = run('crontab', ['-l'], { encoding: 'utf8', timeout: 5000 });
    if (listed && listed.status === 0) {
      for (const line of String(listed.stdout || '').split('\n').filter((row) => row.includes('ATRIS_WORKTREE_SWEEP'))) {
        const problem = sweepJobProblem(line, { kind: 'cron' });
        if (problem) problems.push(problem);
      }
    }
  }
  if (!problems.length) return '';
  return `timer: the build-copy cleaner ${problems[0]}; run atris worktree sweep --install to fix it`;
}

module.exports = {
  ceilingLine,
  dropRecord,
  enforceCeiling,
  formatKib,
  idleMsFromEnv,
  isToolCopy,
  listOpenPaths,
  lockRepo,
  prunePutAway,
  putAwayHome,
  readRecords,
  recordsLine,
  removeCopy,
  restoreCopy,
  sweep,
  sweepJobHint,
  sweepJobProblem,
  sweepLogLine,
  sweepRepo,
};
