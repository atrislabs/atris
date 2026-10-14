'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
    const visit = (dir, root) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.name.endsWith('.lock') || (dir === roots[0] && entry.name === 'locked')) {
          locks.push({ path: file, ageSeconds: Math.max(0, Math.floor((now - fs.lstatSync(file).mtimeMs) / 1000)) });
        } else if (entry.isDirectory() && !(dir === root && ['objects', 'worktrees'].includes(entry.name))) {
          visit(file, root);
        }
      }
    };
    for (const root of roots) visit(root, root);
    locks.sort((a, b) => a.path.localeCompare(b.path));
    return {
      safe: locks.length === 0,
      locks,
      reason: locks.length ? `git locks: ${locks.map((lock) => `${lock.path} (${lock.ageSeconds}s old)`).join(', ')}` : null,
    };
  } catch (error) {
    return { safe: false, locks, reason: `could not check git activity: ${error.message}` };
  }
}

// A locked folder can be gone from disk (an unplugged drive), so read git's
// own lock file from the main repo instead of from inside the folder.
function missingFolderLock(repoRoot, folder, now = Date.now()) {
  const locks = [];
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 15000,
    });
    const admin = path.join(String(result.stdout || '').trim(), 'worktrees');
    for (const name of result.status === 0 ? fs.readdirSync(admin) : []) {
      const gitdir = path.join(admin, name, 'gitdir');
      if (!fs.existsSync(gitdir) || path.dirname(path.resolve(fs.readFileSync(gitdir, 'utf8').trim())) !== path.resolve(folder)) continue;
      const lock = path.join(admin, name, 'locked');
      if (fs.existsSync(lock)) locks.push({ path: lock, ageSeconds: Math.max(0, Math.floor((now - fs.lstatSync(lock).mtimeMs) / 1000)) });
    }
  } catch {}
  const named = locks.map((lock) => `${lock.path} (${lock.ageSeconds}s old)`).join(', ');
  return { locks, reason: `folder is missing; git lock: ${named || 'lock file not found'}` };
}

module.exports = { inspectGitActivity, missingFolderLock };
