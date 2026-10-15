'use strict';

const path = require('path');
const { runGit } = require('./git-spawn');

// Member work copies are cut from committed history, so files `atris init`
// leaves uncommitted never reach a member's first run. Init snapshots what was
// already dirty, then commits only the paths it touched itself. The person's
// own uncommitted work and anything they had staged stay exactly as they were.

const FALLBACK_IDENTITY = ['-c', 'user.name=Atris', '-c', 'user.email=299057014+atris-builder[bot]@users.noreply.github.com'];

function repoRootFor(cwd) {
  const result = runGit(['rev-parse', '--show-toplevel'], { cwd, check: false });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

// Paths git reports as changed or untracked, relative to the repo root.
function dirtyPaths(root) {
  const result = runGit(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, check: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  const entries = result.stdout.split('\0');
  const paths = new Set();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    paths.add(entry.slice(3));
    // Renames and copies carry the old path as the next entry.
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return paths;
}

// Machine-local config (for example .devin/config.local.json) never belongs in history.
function isLocalOnly(relPath) {
  return /\.local(\.|$)/.test(path.basename(relPath));
}

function snapshotBeforeInit(cwd = process.cwd()) {
  const root = repoRootFor(cwd);
  if (!root) return null;
  const before = dirtyPaths(root);
  if (!before) return null;
  return { root, before };
}

function commitInitFiles(snapshot, { message = 'Set up Atris' } = {}) {
  if (!snapshot) return { committed: false, reason: 'not_git' };
  const after = dirtyPaths(snapshot.root);
  if (!after) return { committed: false, reason: 'status_failed' };
  const paths = [...after].filter((p) => !snapshot.before.has(p) && !isLocalOnly(p)).sort();
  if (paths.length === 0) return { committed: false, reason: 'nothing_new', paths };

  const add = runGit(['add', '--', ...paths], { cwd: snapshot.root, check: false });
  if (add.status !== 0) return { committed: false, reason: 'add_failed', detail: (add.stderr || '').trim(), paths };

  const commitArgs = ['commit', '-q', '-m', message, '--only', '--', ...paths];
  let commit = runGit(commitArgs, { cwd: snapshot.root, check: false });
  if (commit.status !== 0 && /tell me who you are|unable to auto-detect email/i.test(commit.stderr || '')) {
    commit = runGit([...FALLBACK_IDENTITY, ...commitArgs], { cwd: snapshot.root, check: false });
  }
  if (commit.status !== 0) {
    // Leave the index as we found it so a blocked commit stays easy to redo by hand.
    runGit(['reset', '-q', '--', ...paths], { cwd: snapshot.root, check: false });
    return { committed: false, reason: 'commit_failed', detail: (commit.stderr || commit.stdout || '').trim(), paths };
  }
  return { committed: true, paths };
}

module.exports = { snapshotBeforeInit, commitInitFiles, dirtyPaths, isLocalOnly };
