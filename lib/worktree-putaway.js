'use strict';

// Put away, then remove. A build copy nobody is using costs disk and holds
// nothing git cannot keep, so the sweep never has to leave one behind:
//
// - Commits live in the shared repository and the branch stays, so removing
//   the folder loses no commit. Merged or not, pushed or not, it can go.
// - Uncommitted work (tracked changes and untracked files git does not
//   ignore) is saved first as one commit on a private ref,
//   refs/atris/put-away/<copy name>, parented on the copy's HEAD. It is built
//   through a throwaway index, so the copy's own index and branch never move.
// - Ignored files never enter git objects, since they can hold secrets. The
//   ones that are not rebuildable and differ from the main copy go into
//   ~/.atris/put-away/<repo>/<copy name>/ignored.tar, mode 0600. Files whose
//   bytes on disk a commit cannot hold exactly (filters, line-ending
//   conversion) go into the same tar.
// - Tool-made files (atris's own state) and rebuildable folders (installs,
//   build output, caches) are dropped. Empty folders never matter.
// - record.json beside the tar says what was saved, where, when and why.
//   `atris worktree restore <name>` rebuilds the copy from it.
//
// "In use" is the only reason a copy stays: git has it locked, a running
// program stands in it, this process stands in it, or a file in it changed
// within the idle window (24 hours unless ATRIS_WORKTREE_IDLE_HOURS says
// otherwise). The folder goes only after the saved commit and tar were read
// back and matched the disk; any failure leaves the copy exactly as it was.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const space = require('./worktree-space');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_IDLE_HOURS = 24;
const CEILING_IDLE_MS = HOUR_MS;
const DEFAULT_MAX_GB = 10;
const DEFAULT_MAX_PER_REPO = 12;
const PRUNE_AFTER_MS = 30 * DAY_MS;
const PUT_AWAY_REF_PREFIX = 'refs/atris/put-away/';
const MAX_BUFFER = 256 * 1024 * 1024;
// More ignored data than this is not quietly copied into the home folder;
// the copy stays and the reason says why.
const MAX_TAR_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200000;

// ---------------------------------------------------------------------------
// Classification. One place for every path rule.

// Files atris itself writes and rewrites inside a repo. Found by reading the
// code that writes them: .atris/state/ (tasks projection, missions, goals,
// scorecards, briefs, usage, engine health, removals log), the start sidecar
// and fleet prompts and watchdogs (lib/conductor-artifacts.js), runtime-tmp
// and cache folders, run records under atris/runs/, the codex last-message
// file, and the web repo's computer-doctor receipts.
const TOOL_MADE_PATTERNS = [
  /^\.atris\/state\//,
  /^\.atris\/agent-worktree\.json$/,
  /^\.atris\/fleet-prompt-[^/]+\.md$/,
  /^\.atris\/codex-watchdog(?:\.js|-[^/]+\.json)$/,
  /^\.atris\/runtime-tmp(?:\/|$)/,
  /^\.atris\/cache(?:\/|$)/,
  /^atris\/runs\/[^/]+\.(?:json|live\.log)$/,
  /^\.codex-last-message\.txt$/,
  /^atris\/qa\/computer-doctor\/log\.jsonl$/,
];

// Folders that come back with one install or build. Matched by name at any
// depth. `dist`, `build` and `coverage` count only when git ignores them,
// since an untracked build/ folder can be someone's new source.
const REBUILDABLE_DIRS = new Set([
  'node_modules', '.next', '.turbo', '.cache', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.venv', 'venv', '.derivedData', '.swiftpm',
]);
const REBUILDABLE_IF_IGNORED_DIRS = new Set(['dist', 'build', 'coverage']);
const REBUILDABLE_FILE = /(?:^|\/)(?:\.DS_Store|tsconfig\.tsbuildinfo|next-env\.d\.ts|[^/]+\.pyc)$/;

function isToolMade(rel) {
  return TOOL_MADE_PATTERNS.some((pattern) => pattern.test(rel));
}

function isRebuildable(rel, { ignored = false } = {}) {
  const parts = String(rel).replace(/\/+$/, '').split('/');
  for (const part of parts.slice(0, -1)) {
    if (REBUILDABLE_DIRS.has(part) || (ignored && REBUILDABLE_IF_IGNORED_DIRS.has(part))) return true;
  }
  const last = parts[parts.length - 1];
  if (REBUILDABLE_DIRS.has(last) || (ignored && REBUILDABLE_IF_IGNORED_DIRS.has(last))) return true;
  return REBUILDABLE_FILE.test(rel);
}

// ---------------------------------------------------------------------------
// Small helpers.

function git(cwd, args, { env, input, encoding = 'utf8', timeout = 120000 } = {}) {
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
    const space_ = line.indexOf(' ');
    const key = space_ === -1 ? line : line.slice(0, space_);
    const value = space_ === -1 ? '' : line.slice(space_ + 1);
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

function repoKey(primary) {
  return path.basename(primary).replace(/[^A-Za-z0-9._-]+/g, '-') || 'repo';
}

function putAwayHome({ home, env = process.env } = {}) {
  if (home) return path.resolve(home);
  if (env.ATRIS_PUT_AWAY_DIR) return path.resolve(env.ATRIS_PUT_AWAY_DIR);
  return path.join(os.homedir(), '.atris', 'put-away');
}

function idleMsFromEnv(env = process.env) {
  const raw = env.ATRIS_WORKTREE_IDLE_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_IDLE_HOURS * HOUR_MS;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 0 ? hours * HOUR_MS : DEFAULT_IDLE_HOURS * HOUR_MS;
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
// with the install it came from, so it counts as nothing; one that npm built
// in the copy counts in full.
function copyKib(copy, { primary } = {}) {
  let kib = duKib(copy, { excludeModules: true });
  const modules = path.join(copy, 'node_modules');
  let stat;
  try { stat = fs.lstatSync(modules); } catch { return kib; }
  if (!stat.isDirectory()) return kib;
  const stampFile = path.join(modules, '.package-lock.json');
  const sources = [];
  if (primary) sources.push(path.join(primary, 'node_modules', '.package-lock.json'));
  if (primary) {
    const store = path.join(path.dirname(primary), space.AGENT_COPIES_DIR, '.deps', path.basename(primary));
    try {
      for (const hash of fs.readdirSync(store)) sources.push(path.join(store, hash, 'node_modules', '.package-lock.json'));
    } catch {}
  }
  if (!sources.some((source) => sameStamp(stampFile, source))) kib += duKib(modules);
  return kib;
}

// ---------------------------------------------------------------------------
// In use.

// Working folders of running programs. macOS and most Linux boxes have lsof;
// Linux also exposes /proc/<pid>/cwd. null when neither can be read, and then
// only the time rule protects a copy.
function listProcessCwds({ run = spawnSync, platform = process.platform, procDir = '/proc' } = {}) {
  const listed = run('lsof', ['-a', '-d', 'cwd', '-Fn'], {
    encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 30000, killSignal: 'SIGKILL',
  });
  const text = listed && !listed.error ? String(listed.stdout || '') : '';
  const fromLsof = text.split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1));
  if (fromLsof.length) return fromLsof;
  if (platform === 'linux') {
    try {
      const cwds = [];
      for (const pid of fs.readdirSync(procDir)) {
        if (!/^\d+$/.test(pid)) continue;
        try { cwds.push(fs.readlinkSync(path.join(procDir, pid, 'cwd'))); } catch {}
      }
      if (cwds.length) return cwds;
    } catch {}
  }
  return null;
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

// The newest change to anything in the copy outside .git folders and
// rebuildable folders: files, folders (a deleted file changes its folder), and the
// copy's own HEAD and HEAD log in git (a commit or checkout). The index is
// left out: `git status`, including the sweep's own, rewrites it.
function newestChangeMs(copy) {
  let newest = 0;
  let newestPath = '';
  const note = (full) => {
    try {
      const stat = fs.lstatSync(full);
      if (stat.mtimeMs > newest) { newest = stat.mtimeMs; newestPath = full; }
    } catch {}
  };
  const gitDir = gitDirOf(copy);
  if (gitDir) for (const mark of ['HEAD', path.join('logs', 'HEAD')]) note(path.join(gitDir, mark));
  note(copy);
  const stack = [''];
  let seen = 0;
  while (stack.length && seen < MAX_WALK_ENTRIES) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(copy, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      // Git rewrites its own folders (a nested repo or submodule index on
      // every status), so .git at any depth is not a sign of use.
      if (entry.name === '.git') continue;
      if (entry.isDirectory() && REBUILDABLE_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (REBUILDABLE_FILE.test(childRel)) continue;
      note(path.join(copy, childRel));
      if (entry.isDirectory()) stack.push(childRel);
    }
  }
  return { ms: newest, path: newestPath };
}

// Why a copy is in use, or null when nobody is using it.
function copyInUse(copy, { wt = {}, cwds, idleMs, now = Date.now(), current = process.cwd() } = {}) {
  if (wt.locked) return { reason: 'locked', text: 'locked' };
  if (current && inside(current, copy)) return { reason: 'current', text: 'this command runs inside it' };
  if (Array.isArray(cwds)) {
    const root = canonical(copy);
    const prefix = `${root}${path.sep}`;
    if (cwds.some((cwd) => { const real = canonical(cwd); return real === root || real.startsWith(prefix); })) {
      return { reason: 'process', text: 'in use by a running program' };
    }
  }
  if (idleMs > 0) {
    const newest = newestChangeMs(copy);
    if (now - newest.ms < idleMs) return { reason: 'recent', text: `changed ${formatAgo(now - newest.ms)}`, newestMs: newest.ms };
  }
  return null;
}

// ---------------------------------------------------------------------------
// What a copy holds.

function statusEntries(copy) {
  const listed = git(copy, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none']);
  if (listed.status !== 0) return null;
  const rows = [];
  for (const row of String(listed.stdout || '').split('\0')) {
    if (row.length < 4) continue;
    rows.push({ code: row.slice(0, 2), path: row.slice(3) });
  }
  return rows;
}

function readFileOrNull(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

function sameAsPrimary(rel, copy, primary) {
  if (!primary) return false;
  const mine = path.join(copy, rel);
  const theirs = path.join(primary, rel);
  try {
    const a = fs.lstatSync(mine);
    const b = fs.lstatSync(theirs);
    if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
  } catch {
    return false;
  }
  const x = readFileOrNull(mine);
  const y = readFileOrNull(theirs);
  return Boolean(x && y && x.equals(y));
}

// Every regular file under `rel` (a folder), leaving out rebuildable folders,
// tool-made paths and links. null when the walk is too big to check.
function walkFiles(copy, rel, { ignored = true } = {}) {
  const files = [];
  const stack = [rel];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(copy, dir), { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_WALK_ENTRIES) return null;
      const childRel = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (isRebuildable(childRel, { ignored }) || isToolMade(childRel)) continue;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  }
  return files;
}

// Things that a put-away cannot hold correctly; the copy stays and the
// reason is shown.
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

// Sorts every path in a copy. Returns { work, save, dropped } or { error }.
// work: paths for the put-away commit (tracked changes, untracked files).
// save: ignored or odd files for the tar.
function classifyCopy(copy, { primary } = {}) {
  const rows = statusEntries(copy);
  if (!rows) return { error: 'could not read git status' };
  const work = [];
  const save = [];
  let dropped = 0;
  for (const row of rows) {
    const rel = row.path;
    if (row.code === '??') {
      if (rel.endsWith('/')) {
        // A folder git lists whole even with -uall is its own repository. A
        // commit would hold only a pointer, so its files go into the tar.
        const clean = rel.replace(/\/+$/, '');
        if (isRebuildable(clean) || isToolMade(clean)) { dropped += 1; continue; }
        const stack = [clean];
        const nested = [];
        let seen = 0;
        while (stack.length) {
          const dir = stack.pop();
          let entries;
          try { entries = fs.readdirSync(path.join(copy, dir), { withFileTypes: true }); } catch { return { error: `could not read ${dir}` }; }
          for (const entry of entries) {
            if ((seen += 1) > MAX_WALK_ENTRIES) return { error: `${clean} holds too many files to check` };
            const childRel = `${dir}/${entry.name}`;
            if (entry.isDirectory()) stack.push(childRel);
            else if (entry.isFile()) nested.push(childRel);
          }
        }
        save.push(...nested);
        continue;
      }
      if (isToolMade(rel) || isRebuildable(rel)) { dropped += 1; continue; }
      // atris folders in a repo can hold credentials (.atris/vault,
      // .atris/business.json); keep them out of git objects.
      if (rel.startsWith('.atris/')) {
        if (!sameAsPrimary(rel, copy, primary)) save.push(rel);
        else dropped += 1;
        continue;
      }
      work.push(rel);
      continue;
    }
    if (isToolMade(rel)) { dropped += 1; continue; }
    work.push(rel);
  }
  const ignored = git(copy, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (ignored.status !== 0) return { error: 'could not list the files git ignores' };
  for (const entry of String(ignored.stdout || '').split('\0').filter(Boolean)) {
    const clean = entry.replace(/\/+$/, '');
    if (isRebuildable(clean, { ignored: true }) || isToolMade(clean)) { dropped += 1; continue; }
    let stat;
    try { stat = fs.lstatSync(path.join(copy, clean)); } catch { continue; }
    if (stat.isSymbolicLink()) { dropped += 1; continue; }
    const files = stat.isDirectory() ? walkFiles(copy, clean) : [clean];
    if (!files) return { error: `${clean} holds too many ignored files to check` };
    for (const rel of files) {
      if (sameAsPrimary(rel, copy, primary)) dropped += 1;
      else save.push(rel);
    }
  }
  return { work, save: [...new Set(save)], dropped };
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

// The tree the put-away commit holds: HEAD plus every work path as it is on
// disk, written through a throwaway index.
function workTree(copy, work) {
  const index = tempIndex();
  const env = { ...commitEnv(copy), GIT_INDEX_FILE: index };
  try {
    const read = git(copy, ['read-tree', 'HEAD'], { env });
    if (read.status !== 0) return { error: `could not read HEAD: ${failText(read)}` };
    if (work.length) {
      const added = git(copy, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: `${work.join('\0')}\0` });
      if (added.status !== 0) return { error: `could not stage the work: ${failText(added)}` };
    }
    const tree = git(copy, ['write-tree'], { env });
    if (tree.status !== 0) return { error: `could not write the work tree: ${failText(tree)}` };
    return { tree: out(tree) };
  } finally {
    try { fs.rmSync(index, { force: true }); } catch {}
  }
}

// The staged version, when it differs from both HEAD and the disk, is kept as
// the parent of the put-away commit. Read from a copy of the index so the
// real one is never written.
function stagedTree(copy) {
  const real = out(git(copy, ['rev-parse', '--path-format=absolute', '--git-path', 'index']));
  if (!real || !fs.existsSync(real)) return '';
  const index = tempIndex();
  try {
    fs.copyFileSync(real, index);
    const tree = git(copy, ['write-tree'], { env: { ...process.env, GIT_INDEX_FILE: index } });
    return tree.status === 0 ? out(tree) : '';
  } catch {
    return '';
  } finally {
    try { fs.rmSync(index, { force: true }); } catch {}
  }
}

// Entries of a tree: path -> { mode, oid }.
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

// Paths in the tree whose bytes, link or mode on disk the tree does not
// hold exactly. Every tracked file is checked, so a content filter or
// line-ending conversion that hides local bytes from git status is caught.
// null when the check itself fails.
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
    const executable = (stat.mode & 0o111) !== 0;
    if ((entry.mode === '100755') !== executable) { mismatched.push(rel); continue; }
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

// Writes the tar with mode 0600 from a list of files, then reads it back:
// the listing must match the list, and every file extracted again must match
// the copy byte for byte.
function writeTar(copy, files, tarPath) {
  const listFile = `${tarPath}.list`;
  fs.writeFileSync(listFile, `${files.join('\0')}\0`, { mode: 0o600 });
  let fd;
  try {
    fd = fs.openSync(tarPath, 'wx', 0o600);
    const made = spawnSync('tar', ['-cf', '-', '-C', copy, '--no-recursion', '--null', '-T', listFile], {
      stdio: ['ignore', fd, 'pipe'], maxBuffer: MAX_BUFFER, timeout: 30 * 60 * 1000, killSignal: 'SIGKILL',
    });
    fs.closeSync(fd);
    fd = undefined;
    if (made.status !== 0) return `tar failed: ${String(made.stderr || '').trim().split('\n')[0] || made.status}`;
    fs.chmodSync(tarPath, 0o600);
    const listed = spawnSync('tar', ['-tf', tarPath], { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 10 * 60 * 1000 });
    if (listed.status !== 0) return 'could not read the tar back';
    const names = new Set(String(listed.stdout || '').split('\n').filter(Boolean).map((name) => name.replace(/^\.\//, '')));
    if (names.size !== files.length || files.some((file) => !names.has(file))) return 'the tar does not list every file';
    const check = fs.mkdtempSync(path.join(path.dirname(tarPath), '.verify-'));
    try {
      const unpacked = spawnSync('tar', ['-xf', tarPath, '-C', check], { encoding: 'utf8', timeout: 30 * 60 * 1000 });
      if (unpacked.status !== 0) return 'could not unpack the tar to check it';
      for (const file of files) {
        if (sha256(path.join(check, file)) !== sha256(path.join(copy, file))) return `the tar copy of ${file} does not match`;
      }
    } finally {
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

function freeName(home, key, name, primary) {
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const dir = path.join(home, key, candidate);
    const ref = `${PUT_AWAY_REF_PREFIX}${candidate}`;
    const refTaken = git(primary, ['rev-parse', '--verify', '--quiet', ref]).status === 0;
    if (!fs.existsSync(dir) && !refTaken) return candidate;
  }
  return '';
}

function safeRefName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/\.lock$/, '-lock') || 'copy';
}

// Saves what removal would lose and checks the saved copy. Returns
// { ok: true, record } or { ok: false, error }. Never touches the copy.
function putAwayCopy({ primary, copy, wt = {}, reason = 'idle', by = 'atris worktree sweep', home, now = Date.now() } = {}) {
  const blocker = putAwayBlocker(copy);
  if (blocker) return { ok: false, error: blocker };
  const head = out(git(copy, ['rev-parse', '--verify', 'HEAD^{commit}']));
  if (!head) return { ok: false, error: 'it has no commit to rebuild from' };
  const sorted = classifyCopy(copy, { primary });
  if (sorted.error) return { ok: false, error: sorted.error };
  const headTree = out(git(copy, ['rev-parse', `${head}^{tree}`]));
  const built = workTree(copy, sorted.work);
  if (built.error) return { ok: false, error: built.error };
  const entries = treeEntries(copy, built.tree);
  if (!entries) return { ok: false, error: 'could not read the saved tree back' };
  // Every work path must be in the saved tree exactly as on disk, or gone
  // from it when it is gone from disk.
  const dropped = new Set();
  for (const row of statusEntries(copy) || []) if (isToolMade(row.path)) dropped.add(row.path);
  const checked = treeMismatches(copy, entries, { skip: dropped });
  if (!checked) return { ok: false, error: 'could not compare the saved tree with the disk' };
  if (checked.missing) return { ok: false, error: `${checked.missing} is in the saved tree but not on disk` };
  for (const rel of sorted.work) {
    if (!entries.has(rel) && fs.existsSync(path.join(copy, rel))) {
      let stat;
      try { stat = fs.lstatSync(path.join(copy, rel)); } catch {}
      if (stat && (stat.isFile() || stat.isSymbolicLink())) return { ok: false, error: `${rel} did not make it into the saved tree` };
    }
  }
  const save = [...new Set([...sorted.save, ...checked.mismatched])];
  let saveBytes = 0;
  for (const rel of save) { try { saveBytes += fs.statSync(path.join(copy, rel)).size; } catch {} }
  if (saveBytes > MAX_TAR_BYTES) {
    return { ok: false, error: `it holds ${(saveBytes / space.GB).toFixed(1)} GB of ignored files the main copy does not have; move them out by hand` };
  }

  const base = path.resolve(putAwayHome({ home }));
  const key = repoKey(primary);
  const name = freeName(base, key, safeRefName(path.basename(copy)), primary);
  if (!name) return { ok: false, error: 'no free put-away name' };
  const dir = path.join(base, key, name);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    return { ok: false, error: `could not make ${dir}: ${error.code || error.message}` };
  }
  const fail = (error, { ref } = {}) => {
    if (ref) git(primary, ['update-ref', '-d', ref]);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error };
  };

  let commit = '';
  let stagedCommit = '';
  const ref = `${PUT_AWAY_REF_PREFIX}${name}`;
  if (built.tree !== headTree) {
    const env = commitEnv(copy);
    const message = (title) => `${title}\n\nPut away by ${by} from ${copy} (${reason}). Restore with: atris worktree restore ${name}\n`;
    let parent = head;
    const staged = stagedTree(copy);
    if (staged && staged !== headTree && staged !== built.tree) {
      const made = git(copy, ['commit-tree', staged, '-p', head, '-F', '-'], { env, input: message('Staged work in a put-away build copy') });
      if (made.status !== 0) return fail(`could not save the staged work: ${failText(made)}`);
      stagedCommit = out(made);
      parent = stagedCommit;
    }
    const made = git(copy, ['commit-tree', built.tree, '-p', parent, '-F', '-'], { env, input: message('Uncommitted work in a put-away build copy') });
    if (made.status !== 0) return fail(`could not save the work: ${failText(made)}`);
    commit = out(made);
    const zero = '0'.repeat(commit.length);
    const created = git(primary, ['update-ref', ref, commit, zero]);
    if (created.status !== 0) return fail(`could not make ${ref}: ${failText(created)}`);
    const readBack = git(primary, ['rev-parse', '--verify', `${ref}^{tree}`]);
    if (out(readBack) !== built.tree) return fail('the put-away ref does not read back', { ref });
  }

  let tar = '';
  if (save.length) {
    tar = path.join(dir, 'ignored.tar');
    const problem = writeTar(copy, save, tar);
    if (problem) return fail(problem, { ref: commit ? ref : '' });
  }

  const record = {
    version: 1,
    name,
    repo: primary,
    repo_name: path.basename(primary),
    path: copy,
    branch: wt.branch && wt.branch !== 'detached' ? wt.branch : null,
    head,
    ref: commit ? ref : null,
    commit: commit || null,
    staged_commit: stagedCommit || null,
    tar: tar || null,
    work_files: sorted.work.length,
    saved_files: save.length,
    at: new Date(now).toISOString(),
    reason,
    by,
  };
  try {
    fs.writeFileSync(path.join(dir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    const back = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8'));
    if (back.name !== name || back.head !== head) return fail('the record does not read back', { ref: commit ? ref : '' });
  } catch (error) {
    return fail(`could not write the record: ${error.code || error.message}`, { ref: commit ? ref : '' });
  }
  return { ok: true, record, dir };
}

// Undo a put-away whose copy then could not be removed.
function dropPutAway(record) {
  if (!record) return;
  if (record.ref) git(record.repo, ['update-ref', '-d', record.ref]);
  const dir = record.tar ? path.dirname(record.tar) : '';
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

function recordDir(record, home) {
  return path.join(putAwayHome({ home }), repoKey(record.repo), record.name);
}

function logRemoval(primary, entry) {
  try {
    const file = path.join(primary, '.atris', 'state', 'worktree_removals.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  } catch {}
}

// Puts a copy away and removes it. The copy is touched only after the saved
// work was read back; anything that fails leaves it as it was.
function removeCopy({ primary, copy, wt = {}, reason = 'idle', by = 'atris worktree sweep', home, now = Date.now(), before, log = {} } = {}) {
  const kib = copyKib(copy, { primary });
  const put = putAwayCopy({ primary, copy, wt, reason, by, home, now });
  if (!put.ok) return { removed: false, reason: 'put_away_failed', text: `put-away failed: ${put.error}` };
  // Nothing may have changed while the work was saved.
  if (before) {
    const after = statusEntries(copy);
    const stillNewest = newestChangeMs(copy).ms;
    if (!after || JSON.stringify(after) !== JSON.stringify(before.status) || stillNewest > before.newestMs) {
      dropPutAway(put.record);
      try { fs.rmSync(recordDir(put.record, home), { recursive: true, force: true }); } catch {}
      return { removed: false, reason: 'changed', text: 'it changed while its work was being put away' };
    }
  }
  const removed = git(primary, ['worktree', 'remove', '--force', copy]);
  if (fs.existsSync(copy)) {
    // git may have deleted part of the folder before it stopped, so the
    // verified put-away is kept: it may now be the only copy of the work.
    return {
      removed: false,
      reason: 'remove_failed',
      text: `git would not remove it (${failText(removed)}); its work stays put away as ${put.record.name}`,
      record: put.record,
    };
  }
  git(primary, ['worktree', 'prune']);
  logRemoval(primary, {
    path: copy, branch: wt.branch || null, by, reason, put_away: put.record.name, ref: put.record.ref, tar: put.record.tar, size_kib: kib, ...log,
  });
  return { removed: true, kib, record: put.record };
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
// in the main branch. A copy fresh off main is not "merged": it has done
// nothing yet.
function mergedOwnWork(primary, wt, base) {
  if (!base || !wt.head || !wt.branch || wt.branch === 'detached') return false;
  if (git(primary, ['merge-base', '--is-ancestor', wt.head, base]).status !== 0) return false;
  const log = git(primary, ['reflog', 'show', '--format=%H', `refs/heads/${wt.branch}`]);
  const shas = out(log).split('\n').filter(Boolean);
  if (!shas.length) return false;
  return shas[shas.length - 1] !== wt.head;
}

function hasWork(copy, primary) {
  const sorted = classifyCopy(copy, { primary });
  return Boolean(sorted.error || sorted.work.length || sorted.save.length);
}

// The copies of one repo: every registered checkout except the main one,
// wherever it lives. Returns { primary, copies: [{ wt, path }] } or null.
function repoCopies(repo) {
  const list = listWorktrees(repo);
  if (!list || !list.length) return null;
  const primary = list[0].path;
  return { primary, copies: list.slice(1).map((wt) => ({ wt, path: wt.path })) };
}

// Folders under .agent-worktrees/<repo>/ git does not list as copies.
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

function sweepRepo({ repo, workspace, apply = false, idleMs, cwds, now = Date.now(), current = process.cwd(), home, by = 'atris worktree sweep', onlyPaths = null }) {
  const found = repoCopies(repo);
  if (!found) return { name: path.basename(repo), root: repo, error: 'git could not list its copies' };
  const { primary, copies } = found;
  const base = mainlineRef(primary);
  const report = { name: path.basename(primary), root: primary, seen: 0, removed: [], kept: [], orphans: [], emptied: [] };
  const scope = Array.isArray(onlyPaths) ? new Set(onlyPaths.map(canonical)) : null;
  for (const { wt, path: copy } of copies) {
    if (scope && !scope.has(canonical(copy))) continue;
    if (wt.bare) continue;
    if (wt.prunable || !fs.existsSync(copy)) continue;
    report.seen += 1;
    const item = { path: copy, name: path.basename(copy), branch: wt.branch };
    let use = copyInUse(copy, { wt, cwds, idleMs, now, current });
    let reason = 'idle';
    // A copy whose branch landed cleans up right away: its commits are in
    // the main branch and nothing new was started in it.
    if (use && use.reason === 'recent' && mergedOwnWork(primary, wt, base) && !hasWork(copy, primary)) {
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
      report.removed.push({ ...item, reason, dryRun: true, kib: copyKib(copy, { primary }) });
      continue;
    }
    const before = { status: statusEntries(copy), newestMs: newestChangeMs(copy).ms };
    const result = removeCopy({ primary, copy, wt, reason, by, home, now, before });
    if (result.removed) report.removed.push({ ...item, reason, kib: result.kib, record: result.record });
    else report.kept.push({ ...item, reason: result.reason, text: result.text });
  }
  if (workspace && !scope) {
    for (const orphan of orphanFolders(workspace, primary, copies.map((item) => item.path))) {
      if (onlyEmptyFolders(orphan)) {
        if (apply) { try { fs.rmSync(orphan, { recursive: true }); } catch {} }
        report.emptied.push(orphan);
      } else {
        report.orphans.push(orphan);
      }
    }
  }
  if (apply) git(primary, ['worktree', 'prune']);
  return report;
}

// Repos to sweep: every <workspace>/<name> with copies under
// <workspace>/.agent-worktrees/<name>, plus any extra repo given (the one the
// command runs in), each once.
function sweepTargets(workspace, extraRepos = []) {
  const targets = [];
  const seen = new Set();
  const add = (repo) => {
    const primary = primaryOf(repo);
    if (!primary) return;
    const key = canonical(primary);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(primary);
  };
  for (const repo of space.agentCopyRepos(workspace)) add(repo.root);
  for (const repo of extraRepos) if (repo) add(repo);
  return targets;
}

function sweep({ workspace, repos: extraRepos = [], apply = false, idleMs, cwds, now = Date.now(), current = process.cwd(), home, by = 'atris worktree sweep', freeSpace = space.freeBytes, env = process.env, prune = true } = {}) {
  const root = path.resolve(workspace);
  const idle = Number.isFinite(idleMs) ? idleMs : idleMsFromEnv(env);
  const scan = cwds === undefined ? listProcessCwds() : cwds;
  const report = {
    workspace: root, apply, idle_ms: idle, process_scan: Array.isArray(scan), before: freeSpace(root), after: null, repos: [], pruned: [],
  };
  for (const repo of sweepTargets(root, extraRepos)) {
    try {
      report.repos.push(sweepRepo({ repo, workspace: root, apply, idleMs: idle, cwds: scan, now, current, home, by }));
    } catch (error) {
      report.repos.push({ name: path.basename(repo), root: repo, error: String((error && error.message) || error) });
    }
  }
  if (apply && prune) report.pruned = prunePutAway({ home, now }).pruned;
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
      if (item.record && (item.record.ref || item.record.tar)) totals.putAway += 1;
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
  process: 'in use by a running program',
  recent: 'changed recently',
  put_away_failed: 'put-away failed',
  changed: 'changed during the sweep',
  remove_failed: 'git would not remove it',
};

// One line per run for the job's log.
function sweepLogLine(report, { now = Date.now() } = {}) {
  const t = sweepTotals(report);
  const why = Object.entries(t.why).map(([reason, count]) => `${count} ${KEPT_WORDS[reason] || reason}`).join(', ');
  const freed = Number.isFinite(report.before) && Number.isFinite(report.after) && report.after > report.before
    ? `${((report.after - report.before) / space.GB).toFixed(1)} GB` : '0.0 GB';
  const scan = report.process_scan ? '' : '; could not list running programs, so only the time rule protected copies';
  return `${new Date(now).toISOString()} sweep ${report.workspace}: seen ${t.seen}, removed ${t.removed} (put away ${t.putAway}), kept ${t.kept}${why ? ` (${why})` : ''}, freed ${freed} (${formatKib(t.kib)} by size)${scan}`;
}

// ---------------------------------------------------------------------------
// Ceiling.

// Before a new copy: when the workspace's copies hold more than the size
// limit, or this repo already has the most copies allowed, the idle ones go,
// oldest first, idle for an hour instead of a day. In-use copies stay.
function enforceCeiling({ repo, workspace, env = process.env, now = Date.now(), cwds, current = process.cwd(), home, by = 'atris worktree start' } = {}) {
  const limits = ceilingFromEnv(env);
  const result = { ...limits, removed: [], inUse: [], over: false, checked: false };
  const found = repoCopies(repo);
  if (!found) return result;
  const ws = workspace || path.dirname(found.primary);
  const targets = sweepTargets(ws, [found.primary]);
  const all = [];
  for (const target of targets) {
    const listed = repoCopies(target);
    if (!listed) continue;
    for (const { wt, path: copy } of listed.copies) {
      if (wt.bare || wt.prunable || !fs.existsSync(copy)) continue;
      all.push({ primary: listed.primary, wt, path: copy, mine: canonical(listed.primary) === canonical(found.primary) });
    }
  }
  const count = () => all.filter((item) => item.mine && !item.gone).length;
  const countOver = () => limits.maxPerRepo > 0 && count() + 1 > limits.maxPerRepo;
  let sizes = null;
  const totalBytes = () => {
    if (!(limits.maxBytes > 0)) return 0;
    if (!sizes) {
      sizes = new Map();
      for (const item of all) sizes.set(item.path, copyKib(item.path, { primary: item.primary }));
    }
    return all.filter((item) => !item.gone).reduce((sum, item) => sum + (sizes.get(item.path) || 0) * 1024, 0);
  };
  const sizeOver = () => limits.maxBytes > 0 && totalBytes() > limits.maxBytes;
  if (!countOver() && !sizeOver()) return result;
  result.checked = true;
  const scan = cwds === undefined ? listProcessCwds() : cwds;
  for (const item of all) item.newest = newestChangeMs(item.path).ms;
  const order = [...all].sort((a, b) => a.newest - b.newest);
  for (const item of order) {
    const needCount = countOver();
    const needSize = sizeOver();
    if (!needCount && !needSize) break;
    // Count pressure only frees this repo's copies; size pressure any.
    if (!needSize && !item.mine) continue;
    const use = copyInUse(item.path, { wt: item.wt, cwds: scan, idleMs: CEILING_IDLE_MS, now, current });
    if (use) {
      item.use = use;
      continue;
    }
    const before = { status: statusEntries(item.path), newestMs: item.newest };
    const done = removeCopy({ primary: item.primary, copy: item.path, wt: item.wt, reason: 'ceiling', by, home, now, before });
    if (done.removed) {
      item.gone = true;
      result.removed.push({ path: item.path, kib: done.kib, record: done.record });
    } else {
      item.use = { reason: done.reason, text: done.text };
    }
  }
  result.over = countOver() || sizeOver();
  if (result.over) {
    for (const item of all) {
      if (item.gone || !item.use) continue;
      result.inUse.push({ path: item.path, name: path.basename(item.path), kib: sizes ? sizes.get(item.path) || 0 : copyKib(item.path, { primary: item.primary }), text: item.use.text });
    }
  }
  return result;
}

function ceilingLine(result) {
  if (!result || !result.checked) return '';
  const parts = [];
  if (result.removed.length) {
    parts.push(`ceiling: put away and removed ${result.removed.length} idle ${result.removed.length === 1 ? 'copy' : 'copies'} (${formatKib(result.removed.reduce((sum, item) => sum + (item.kib || 0), 0))}); nothing was lost, atris worktree restore <name> brings one back`);
  }
  if (result.over) {
    const busy = result.inUse.slice(0, 6).map((item) => `${item.name} (${formatKib(item.kib)}, ${item.text})`).join(', ');
    parts.push(`ceiling: still over ${result.maxPerRepo} copies or ${(result.maxBytes / space.GB).toFixed(0)} GB because these are in use: ${busy || 'none could be checked'}; starting anyway`);
  }
  return parts.join('\n');
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

function findRecord(name, { home, repo } = {}) {
  const matches = readRecords({ home }).filter((record) => record.name === name
    && (!repo || record.repo_name === repo || canonical(record.repo) === canonical(repo)));
  if (!matches.length) return { error: `nothing called ${name} is put away (atris worktree put-away list shows what is)` };
  if (matches.length > 1) return { error: `${matches.length} repos have a copy called ${name}; add --repo <name>` };
  return { record: matches[0] };
}

// Rebuilds a put-away copy at its old path: its branch (or its old HEAD if
// the branch moved), the saved work as uncommitted changes, the tar unpacked.
function restoreCopy({ name, home, repo, target } = {}) {
  const found = findRecord(name, { home, repo });
  if (found.error) return { ok: false, error: found.error };
  const record = found.record;
  const dest = path.resolve(target || record.path);
  if (fs.existsSync(dest) && !onlyEmptyFolders(dest)) return { ok: false, error: `${dest} already exists and is not empty` };
  if (!fs.existsSync(path.join(record.repo, '.git'))) return { ok: false, error: `the repo ${record.repo} is gone` };
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const notes = [];
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
  if (record.commit) {
    // Plumbing diff with fixed prefixes, so no user diff setting (color,
    // noprefix, external tools) can change what gets applied.
    const diff = git(record.repo, ['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', record.head, record.commit], { encoding: 'buffer' });
    if (diff.status !== 0) return { ok: false, error: `could not read the saved work: ${failText({ stderr: String(diff.stderr || '') })}` };
    if (diff.stdout && diff.stdout.length) {
      const applied = git(dest, ['apply', '--whitespace=nowarn', '--binary'], { input: diff.stdout, encoding: 'utf8' });
      if (applied.status !== 0) return { ok: false, error: `could not put the saved work back: ${failText(applied)}; it is still on ${record.ref}` };
    }
    if (record.staged_commit) notes.push(`a staged version that differed from the files is kept in ${record.staged_commit}`);
  }
  if (record.tar) {
    const unpacked = spawnSync('tar', ['-xf', record.tar, '-C', dest], { encoding: 'utf8', timeout: 30 * 60 * 1000 });
    if (unpacked.status !== 0) return { ok: false, error: `could not unpack ${record.tar}: ${String(unpacked.stderr || '').trim()}` };
  }
  if (record.ref && !record.staged_commit) git(record.repo, ['update-ref', '-d', record.ref, record.commit]);
  if (!record.staged_commit) { try { fs.rmSync(record.dir, { recursive: true, force: true }); } catch {} }
  return { ok: true, path: dest, record, notes };
}

// Records older than 30 days go when their branch is merged into the main
// branch or they hold no saved commit. The rest stay.
function prunePutAway({ home, now = Date.now(), maxAgeMs = PRUNE_AFTER_MS } = {}) {
  const pruned = [];
  const kept = [];
  for (const record of readRecords({ home })) {
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || now - at < maxAgeMs) { kept.push(record); continue; }
    let gone = !record.commit;
    if (!gone && fs.existsSync(path.join(record.repo, '.git'))) {
      const base = mainlineRef(record.repo);
      const tip = record.branch ? out(git(record.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`])) : '';
      gone = Boolean(base && tip && git(record.repo, ['merge-base', '--is-ancestor', tip, base]).status === 0);
    }
    if (!gone) { kept.push(record); continue; }
    if (record.ref && fs.existsSync(path.join(record.repo, '.git'))) git(record.repo, ['update-ref', '-d', record.ref]);
    if (record.staged_commit) { /* reachable only through the ref, which is gone now */ }
    try { fs.rmSync(record.dir, { recursive: true, force: true }); } catch {}
    pruned.push(record);
  }
  return { pruned, kept };
}

// ---------------------------------------------------------------------------
// The installed job.

// What is wrong with an installed sweep job, or ''. A job that names an
// atris.js file runs that frozen copy forever instead of the installed tool;
// one that runs less often than hourly lets copies pile up between runs.
function sweepJobProblem(contents, { kind = 'launchd' } = {}) {
  const text = String(contents || '');
  if (!text.trim()) return '';
  const frozen = /atris\.js\b/.test(text);
  let schedule = false;
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
  CEILING_IDLE_MS,
  DEFAULT_IDLE_HOURS,
  ceilingLine,
  copyInUse,
  enforceCeiling,
  formatKib,
  idleMsFromEnv,
  isRebuildable,
  isToolMade,
  listProcessCwds,
  prunePutAway,
  putAwayHome,
  readRecords,
  removeCopy,
  restoreCopy,
  sweep,
  sweepJobHint,
  sweepJobProblem,
  sweepLogLine,
  sweepRepo,
};
