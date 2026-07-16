'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// The mission store lives at <workspace>/.atris/state. Historically every
// mission entry point defaulted its root to process.cwd(), so running any
// `atris mission ...` verb from a subdirectory (e.g. atris/features/food-ordering)
// silently created a NESTED .atris there — a second, split-brain mission store
// the fleet never reads. Resolve to the workspace root so mission state always
// lands there, whichever subdir the caller happened to be in.
//
// This delegates to the SAME resolver the task/usage/goal store uses
// (lib/task-db findWorkspaceRoot): a bound customer sub-workspace spine
// (.atris/business.json | atris/atris.md) wins, else the git toplevel, else the
// caller's cwd. Sharing one resolver keeps mission state and task state in the
// same root — previously mission used only the git toplevel, so a mission
// started inside a bound sub-workspace split away from that workspace's task
// state. A git worktree reports its own toplevel (its .git marker), which is
// the correct per-worktree store, so --worktree missions are unaffected. If the
// shared resolver can't load, fall back to the git toplevel, then to cwd.
function resolveWorkspaceRoot(cwd = process.cwd()) {
  try {
    const { workspaceRoot } = require('./task-db');
    const root = workspaceRoot(cwd);
    if (root) return root;
  } catch {}
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
