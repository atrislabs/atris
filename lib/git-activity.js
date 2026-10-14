'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function collectGitLocks(roots, privateRoot, now, locks) {
  const visit = (dir, root) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.name.endsWith('.lock') || (dir === privateRoot && entry.name === 'locked')) {
        locks.push({ path: file, ageSeconds: Math.max(0, Math.floor((now - fs.lstatSync(file).mtimeMs) / 1000)) });
      } else if (entry.isDirectory() && !(dir === root && ['objects', 'worktrees'].includes(entry.name))) {
        visit(file, root);
      }
    }
  };
  for (const root of new Set(roots)) visit(root, root);
  locks.sort((a, b) => a.path.localeCompare(b.path));
}

// Locks do not expire. Check this copy's metadata and shared repository
// metadata, without walking object storage or other copies' private metadata.
function inspectGitActivity(folder, now = Date.now()) {
  const locks = [];
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
      cwd: folder, encoding: 'utf8', timeout: 15000,
    });
    if (result.error || result.status !== 0) throw new Error('could not locate git metadata');
    const roots = [...new Set(result.stdout.trim().split('\n'))];
    if (roots.length === 0 || roots.some((root) => !path.isAbsolute(root))) throw new Error('could not locate git metadata');
    collectGitLocks(roots, roots[0], now, locks);
    return {
      safe: locks.length === 0,
      locks,
      reason: locks.length ? `git locks: ${locks.map((lock) => `${lock.path} (${lock.ageSeconds}s old)`).join(', ')}` : null,
    };
  } catch (error) {
    return { safe: false, locks, reason: `could not check git activity: ${error.message}` };
  }
}

// A folder can be gone from disk, so locate its private metadata through the
// main repo. Shared locks still apply, but neighboring private locks do not.
function missingFolderLock(repoRoot, folder, now = Date.now()) {
  const locks = [];
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 15000,
    });
    const common = String(result.stdout || '').trim();
    if (result.error || result.status !== 0 || !path.isAbsolute(common)) throw new Error('could not locate git metadata');
    const admin = path.join(common, 'worktrees');
    let privateRoot = null;
    for (const name of fs.existsSync(admin) ? fs.readdirSync(admin) : []) {
      const gitdir = path.join(admin, name, 'gitdir');
      if (!fs.existsSync(gitdir) || path.dirname(path.resolve(fs.readFileSync(gitdir, 'utf8').trim())) !== path.resolve(folder)) continue;
      privateRoot = path.join(admin, name);
      break;
    }
    collectGitLocks(privateRoot ? [privateRoot, common] : [common], privateRoot, now, locks);
  } catch {}
  const named = locks.map((lock) => `${lock.path} (${lock.ageSeconds}s old)`).join(', ');
  return { locks, reason: `folder is missing; git lock: ${named || 'lock file not found'}` };
}

// After Git refuses a removal, name what still holds the folder. The folder
// can move during the refusal; its private and shared locks still apply then.
function locksAfterRefusal(repoRoot, folder, now = Date.now(), realFolder = folder) {
  const missing = !fs.existsSync(folder);
  const retained = missing ? missingFolderLock(repoRoot, folder, now) : inspectGitActivity(realFolder, now);
  return { missing, locks: retained.locks, reason: retained.locks.length ? retained.reason : missing ? 'folder is missing' : null };
}

module.exports = { inspectGitActivity, missingFolderLock, locksAfterRefusal };
