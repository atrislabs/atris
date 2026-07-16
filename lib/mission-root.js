'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// The mission store lives at <workspace>/.atris/state. Historically every
// mission entry point defaulted its root to process.cwd(), so running any
// `atris mission ...` verb from a subdirectory (e.g. atris/features/food-ordering)
// silently created a NESTED .atris there — a second, split-brain mission store
// the fleet never reads. Resolve to the git toplevel so mission state always
// lands at the workspace root, whichever subdir the caller happened to be in.
// A git worktree reports its own toplevel, which is the correct per-worktree
// store, so this is safe for --worktree missions too. Outside a git repo the
// caller's cwd is returned unchanged.
function resolveWorkspaceRoot(cwd = process.cwd()) {
  try {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    const root = String(top.stdout || '').trim();
    if (top.status === 0 && root) return root;
  } catch {}
  return cwd;
}

// Chdir to the workspace root before any mission state is written, so a caller
// standing in a subdirectory does not spawn a nested .atris store. Only
// redirects when cwd is strictly INSIDE the resolved root (a subdirectory);
// if cwd already IS the root, or somehow sits outside it, nothing moves.
// Returns { from, root } when it redirected so the caller can warn loudly,
// or null when it left cwd untouched.
function redirectToWorkspaceRoot(cwd = process.cwd()) {
  const from = path.resolve(cwd);
  const root = path.resolve(resolveWorkspaceRoot(from));
  if (root === from) return null;
  const rel = path.relative(root, from);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  process.chdir(root);
  return { from, root };
}

module.exports = { resolveWorkspaceRoot, redirectToWorkspaceRoot };
