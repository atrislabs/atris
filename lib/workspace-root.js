'use strict';

// Which project a folder belongs to: the key every task row is stored under.
// Moved out of lib/task-db.js (which re-exports it) so light readers can
// resolve a project without opening the task store.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isGenericScratchRoot } = require('./scratch-root');
const { stateHome, samePath } = require('./state-home');

function isGlobalAtrisHome(dir) {
  if (!dir) return false;
  return samePath(dir, os.homedir()) || samePath(dir, stateHome());
}

// Resolve the canonical workspace root so `atris task` from any subdirectory
// keys the SAME store as the repo root. Precedence (nearest ancestor wins per
// pass):
//   1. A deliberate workspace spine, .atris/business.json (a bound customer
//      sub-workspace) or atris/atris.md (the framework protocol file). These are
//      intentional nested workspaces INSIDE a repo and must stay isolated.
//   2. The git toplevel (.git). One git repo == one workspace; this rescues a
//      subdirectory whose only markers are a bare atris/ or .atris/ dir.
//   3. Legacy fallback for non-git trees: a bare atris/ or .atris/ dir.
//
// Before this, a bare atris/ or .atris/ dir short-circuited ahead of the git
// root, so a subdir like backend/ (which has an atris/ folder plus a stray
// .atris) hijacked itself as a second workspace root and split task/usage state
// into backend/.atris (proven footgun 2026-07-16). Checking .git only at the
// same level meant the walk returned before ever reaching the real repo root.
function findWorkspaceRoot(start) {
  const origin = path.resolve(start || process.cwd());
  // Cap each walk at 32 levels to avoid pathological symlink loops.
  const walkUp = (test) => {
    let cur = origin;
    for (let i = 0; i < 32; i++) {
      if (test(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      // /tmp (and the other first-minute scratch roots) may themselves be a
      // workspace. A child of that root is a new room and must not inherit it.
      if (isGenericScratchRoot(parent)) break;
      cur = parent;
    }
    return null;
  };
  const spine = walkUp((dir) => fs.existsSync(path.join(dir, '.atris', 'business.json'))
    || fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  if (spine) return spine;
  const gitRoot = walkUp((dir) => fs.existsSync(path.join(dir, '.git')));
  if (gitRoot) return gitRoot;
  const legacy = walkUp((dir) => !isGlobalAtrisHome(dir)
    && (fs.existsSync(path.join(dir, 'atris')) || fs.existsSync(path.join(dir, '.atris'))));
  if (legacy) return legacy;
  return origin;
}

function workspaceRoot(cwd) {
  // Normalize symlinks (notably macOS /tmp → /private/tmp), then walk up to
  // the project root so subdirs and the repo root agree on the same key.
  let target = cwd || process.cwd();
  try { target = fs.realpathSync(target); } catch {}
  return findWorkspaceRoot(target);
}

// The git worktrees linked to a main checkout, read from .git/worktrees on
// disk instead of asking git, so a read path starts no child process. Each
// entry's gitdir file names the linked copy's .git file; its folder is the root.
function linkedWorktreeRootsFromDisk(root) {
  const dir = path.join(root, '.git', 'worktrees');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const roots = [];
  for (const name of names) {
    let gitdir = '';
    try { gitdir = fs.readFileSync(path.join(dir, name, 'gitdir'), 'utf8').trim(); } catch { continue; }
    if (!gitdir) continue;
    let linked = path.dirname(path.resolve(dir, name, gitdir));
    try { linked = fs.realpathSync(linked); } catch {}
    if (linked !== root && !roots.includes(linked)) roots.push(linked);
  }
  return roots;
}

module.exports = {
  findWorkspaceRoot,
  linkedWorktreeRootsFromDisk,
  workspaceRoot,
};
