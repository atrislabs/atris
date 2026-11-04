'use strict';

// What a work copy holds that removing it would destroy, and the folder that
// saves it first. Removing a copy keeps its branch and commits, so what is at
// risk is uncommitted changes, untracked files, ignored files that are not
// rebuildable, and commits on a detached head that no branch or tag reaches.
//
// A rescue lives at ~/.atris/worktree-rescue/<YYYY-MM-DD>/<name>/, outside every
// repository, so no push can carry it. It appears there only once complete: the
// work happens in a hidden folder that is renamed at the end, and any failure
// deletes that folder and tells the caller to keep the copy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const space = require('./worktree-space');

const IGNORED_RESCUE_LIMIT_BYTES = 50 * 1000 * 1000;
// A build or an install makes these again, so they are not data.
const REBUILDABLE_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'venv', '.venv', '__pycache__', '.turbo', '.cache', 'coverage']);
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

function git(cwd, args, options = {}) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', ...options,
  });
}

function defaultRescueRoot() {
  return process.env.ATRIS_WORKTREE_RESCUE_DIR || path.join(os.homedir(), '.atris', 'worktree-rescue');
}

// Tracked changes and every untracked file, named one by one. The flags beat
// any repo setting that would hide untracked files or submodule changes.
function readCopyStatus(worktree) {
  const result = git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  if (result.error || result.status !== 0) return null;
  const status = { staged: 0, unstaged: 0, untracked: 0, untrackedFiles: [], untrackedBytes: 0, newestMs: 0, raw: result.stdout };
  const tokens = result.stdout.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry) continue;
    const [x, y] = entry;
    const file = entry.slice(3);
    // A rename or copy lists its old path as the next entry.
    if ('RC'.includes(x) || 'RC'.includes(y)) index += 1;
    let stat = null;
    try { stat = fs.lstatSync(path.join(worktree, file)); } catch {}
    if (stat) status.newestMs = Math.max(status.newestMs, stat.mtimeMs);
    if (x === '?') {
      status.untracked += 1;
      status.untrackedFiles.push(file);
      if (stat) status.untrackedBytes += stat.size;
    } else {
      if (x !== ' ') status.staged += 1;
      if (y !== ' ') status.unstaged += 1;
    }
  }
  return status;
}

// The ignored files a removal would lose. Never follows a link. Stops adding up
// once past the limit, since the answer is already known. null means the
// folder could not be read, so nobody can say what is in it.
function scanIgnored(worktree, { limitBytes = IGNORED_RESCUE_LIMIT_BYTES } = {}) {
  const listed = git(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (listed.error || listed.status !== 0) return null;
  const scan = { raw: listed.stdout, files: [], bytes: 0, rebuildable: [], skipped: [], newestMs: 0, overLimit: false, holdsLinkedCopy: false };
  const visit = (relative) => {
    if (scan.overLimit) return;
    const name = path.basename(relative);
    const stat = fs.lstatSync(path.join(worktree, relative));
    if ((stat.isDirectory() || stat.isSymbolicLink()) && REBUILDABLE_DIRS.has(name)) {
      scan.rebuildable.push(relative);
      return;
    }
    scan.newestMs = Math.max(scan.newestMs, stat.mtimeMs);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(path.join(worktree, relative))) visit(path.join(relative, child));
    } else if (stat.isSymbolicLink() || stat.isFile()) {
      // A .git file marks another linked copy, whose work is not ours to judge.
      if (stat.isFile() && name === '.git') scan.holdsLinkedCopy = true;
      scan.files.push(relative);
      if (stat.isFile()) scan.bytes += stat.size;
      if (scan.bytes >= limitBytes) scan.overLimit = true;
    } else {
      scan.skipped.push(relative);
    }
  };
  try {
    for (const entry of listed.stdout.split('\0').filter(Boolean)) {
      const relative = entry.replace(/\/$/, '');
      if (relative.split('/').slice(0, -1).some((part) => REBUILDABLE_DIRS.has(part))) {
        scan.rebuildable.push(relative);
        continue;
      }
      visit(relative);
    }
  } catch {
    return null;
  }
  return scan;
}

function localDate(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function rescueFolder(rescueRoot, worktree, now) {
  const dir = path.join(rescueRoot, localDate(now));
  const name = path.basename(worktree);
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target); n += 1) target = path.join(dir, `${name}-${n}`);
  return target;
}

// One file or folder, links kept as links. A pipe or socket holds no saved
// data, and reading a pipe would hang forever, so those are named and skipped.
function copyEntry(source, target, skipped) {
  const stat = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), target);
  } else if (stat.isDirectory()) {
    if (fs.lstatSync(path.join(source, '.git'), { throwIfNoEntry: false })?.isFile()) throw new Error(`${source} is another linked copy`);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const child of fs.readdirSync(source)) copyEntry(path.join(source, child), path.join(target, child), skipped);
  } else if (stat.isFile()) {
    // A clone where the disk can do it: instant, and costs almost no room.
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    if (fs.lstatSync(target).size !== stat.size) throw new Error(`${source} changed while it was being saved`);
    fs.utimesSync(target, stat.atime, stat.mtime);
  } else {
    skipped.push(source);
  }
}

// git writes the patch itself: through a pipe, Node's buffer would cap its size.
// A patch that cannot be applied back onto its own commit is no rescue.
function saveTrackedPatch(worktree, work) {
  const patch = path.join(work, 'tracked.patch');
  const diff = git(worktree, ['diff', '--binary', '--no-ext-diff', '--no-color', '--full-index', '--ignore-submodules=none', `--output=${patch}`, 'HEAD']);
  if (diff.error || diff.status !== 0) throw new Error(`could not write the patch: ${String(diff.stderr || diff.error || '').trim()}`);
  if (!fs.statSync(patch).size) throw new Error('git reports tracked changes but the patch is empty');
  const env = { ...process.env, GIT_INDEX_FILE: path.join(work, '.check-index') };
  const read = git(worktree, ['read-tree', 'HEAD'], { env });
  const check = read.status === 0 ? git(worktree, ['apply', '--cached', '--check', patch], { env }) : read;
  fs.rmSync(env.GIT_INDEX_FILE, { force: true });
  if (check.error || check.status !== 0) throw new Error(`the patch does not apply back: ${String(check.stderr || check.error || '').trim()}`);
}

function saveCommitBundle(worktree, work, baseCommit) {
  if (!baseCommit) throw new Error('no base commit to measure the detached commits against');
  const bundle = path.join(work, 'commits.bundle');
  const made = git(worktree, ['bundle', 'create', '-q', bundle, 'HEAD', `^${baseCommit}`]);
  const verified = made.status === 0 ? git(worktree, ['bundle', 'verify', '-q', bundle]) : made;
  if (verified.error || verified.status !== 0) throw new Error(`could not save the detached commits: ${String(verified.stderr || verified.error || '').trim()}`);
}

// Every failure comes back as { ok: false, error }. The caller keeps the copy.
function saveRescue({
  worktree,
  branch = '',
  head = '',
  reason = '',
  status,
  ignored,
  bundleCommits = false,
  baseCommit = '',
  rescueRoot = defaultRescueRoot(),
  now = Date.now(),
  freeSpace = space.freeBytes,
}) {
  let work = '';
  try {
    const dateDir = path.join(rescueRoot, localDate(now));
    for (const dir of [rescueRoot, dateDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    const needed = status.untrackedBytes + ignored.bytes;
    const free = freeSpace(rescueRoot);
    if (typeof free === 'number' && needed > free) throw new Error(`needs ${needed} bytes and only ${free} are free`);
    work = fs.mkdtempSync(path.join(dateDir, '.partial-'));
    const skipped = [];
    const hasTrackedChanges = Boolean(status.staged || status.unstaged);
    if (hasTrackedChanges) saveTrackedPatch(worktree, work);
    if (bundleCommits) saveCommitBundle(worktree, work, baseCommit);
    for (const file of status.untrackedFiles) copyEntry(path.join(worktree, file), path.join(work, 'untracked', file), skipped);
    for (const file of ignored.files) copyEntry(path.join(worktree, file), path.join(work, 'ignored', file), skipped);
    const target = rescueFolder(rescueRoot, worktree, now);
    const manifest = {
      saved_at: new Date(now).toISOString(),
      path: worktree,
      branch: branch || null,
      head: head || null,
      reason,
      tracked_patch: hasTrackedChanges,
      commits_bundle: bundleCommits,
      untracked_files: status.untrackedFiles.length,
      ignored_files: ignored.files.length,
      ignored_bytes: ignored.bytes,
      not_saved_rebuildable: ignored.rebuildable,
      not_saved_special: [...ignored.skipped, ...skipped],
      restore: `git worktree add <folder> ${bundleCommits ? head : branch || head}${bundleCommits ? ` (first: git fetch ${path.join(target, 'commits.bundle')} HEAD)` : ''}`
        + `${hasTrackedChanges ? `, then git -C <folder> apply ${path.join(target, 'tracked.patch')}` : ''}`
        + ', then copy untracked/ and ignored/ back into <folder>',
    };
    fs.writeFileSync(path.join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(work, target);
    work = '';
    fs.chmodSync(target, 0o700);
    return { ok: true, path: target, manifest };
  } catch (error) {
    if (work) {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    }
    return { ok: false, error: String((error && error.message) || error) };
  }
}

module.exports = {
  IGNORED_RESCUE_LIMIT_BYTES,
  defaultRescueRoot,
  readCopyStatus,
  rescueFolder,
  saveRescue,
  scanIgnored,
};
