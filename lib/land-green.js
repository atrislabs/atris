'use strict';

// Green landing for stale branches.
//
// The landing board already classifies every branch: landed, active, due.
// Before this module the loop had exactly two moves for finished work that
// nobody merged: carry it in the digest, then salvage-reap it after the TTL.
// Both of the branches that sat "in the air" on 2026-09-01 were green and
// merged cleanly; they waited four days for a human to run the suite by hand.
//
// This is the third move. A stale active branch that merges without conflict,
// touches no protected surface, and passes the full verify command in its own
// scratch checkout is fast-forwarded onto the base branch and pushed. A branch
// that fails opens one close flag naming the failing checks so the owner sees
// it the same day instead of on reap day. Everything else is left alone with
// a named reason. One branch per tick: the suite is minutes, not seconds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runGit } = require('./git-spawn');

const DEFAULT_VERIFY = 'npm test';
const DEFAULT_VERIFY_TIMEOUT_MS = 20 * 60 * 1000;
const FAILING_LINE = /^(?:✖|not ok)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/;

function gitOut(args, cwd) {
  const result = runGit(args, { cwd, check: false });
  return { ok: result.status === 0, out: String(result.stdout || '').trim(), err: String(result.stderr || '').trim() };
}

function branchAuthor(root, branch) {
  const result = gitOut(['log', '-1', '--format=%an', branch], root);
  return result.ok && result.out ? result.out : 'operator';
}

function mergeConflicts(root, base, branch) {
  // --write-tree exits 1 on conflict, 0 on clean, >1 on error (git >= 2.38).
  const result = runGit(['merge-tree', '--write-tree', '--name-only', base, branch], { cwd: root, check: false });
  if (result.status === 0) return { ok: true, conflicts: [] };
  if (result.status === 1) {
    // Output: tree id, conflicted paths, a blank line, then messages.
    const block = String(result.stdout || '').split(/\r?\n\r?\n/)[0] || '';
    const lines = block.split(/\r?\n/).filter(Boolean);
    return { ok: true, conflicts: lines.slice(1) };
  }
  return { ok: false, error: String(result.stderr || result.stdout || 'merge-tree failed').trim() };
}

function protectedSurfaces(root, base, branch) {
  let matcher = null;
  try {
    ({ matchProtectedMissionDiff: matcher } = require('./mission-protected-lane'));
  } catch {
    return { protected: false, surfaces: [] };
  }
  const diff = runGit(['diff', `${base}...${branch}`], { cwd: root, check: false, maxBuffer: 64 * 1024 * 1024 });
  if (diff.status !== 0) return { protected: true, surfaces: ['unreadable diff'] };
  const verdict = matcher(String(diff.stdout || ''));
  return { protected: Boolean(verdict.protected), surfaces: verdict.surfaces || [] };
}

function dirtyCheckouts(root, branch) {
  let listWorktrees;
  let statusCounts;
  try {
    ({ listWorktrees, statusCounts } = require('../commands/worktree'));
  } catch {
    return [];
  }
  const dirty = [];
  for (const wt of listWorktrees(root)) {
    const name = String(wt.branch || '').replace(/^refs\/heads\//, '');
    if (name !== branch) continue;
    const counts = statusCounts(wt.path) || { staged: 0, unstaged: 0, untracked: 0 };
    if (counts.staged + counts.unstaged + counts.untracked > 0) dirty.push(wt.path);
  }
  return dirty;
}

function failingLines(text, limit = 8) {
  const seen = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const match = raw.trim().match(FAILING_LINE);
    if (!match) continue;
    const name = match[1].trim();
    if (/^failing tests:?$/i.test(name)) continue;
    if (!seen.includes(name)) seen.push(name);
    if (seen.length >= limit) break;
  }
  return seen;
}

function runVerify(command, cwd, { timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, env = process.env } = {}) {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    command,
    status: result.status,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    duration_ms: Date.now() - started,
    failing: failingLines(output),
    tail: output.trim().split(/\r?\n/).slice(-12).join('\n'),
  };
}

function baseCheckoutState(root, base) {
  const head = gitOut(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  const onBase = head.ok && head.out === base;
  if (!onBase) return { onBase: false, dirty: false };
  const status = gitOut(['status', '--porcelain', '--untracked-files=no'], root);
  return { onBase: true, dirty: status.ok && status.out.length > 0 };
}

// Move the base ref to `sha`, respecting a checked-out base worktree: when
// the root has base checked out and is clean, a fast-forward merge updates
// both the ref and the files; otherwise the ref moves alone.
function advanceBase(root, base, sha) {
  const hasLocal = gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], root);
  if (!hasLocal.ok) return { ok: true, skipped: 'no_local_branch' };
  const state = baseCheckoutState(root, base);
  if (state.onBase && state.dirty) return { ok: false, reason: 'base_checkout_dirty' };
  if (state.onBase) {
    const merged = gitOut(['merge', '--ff-only', sha], root);
    if (!merged.ok) return { ok: false, reason: 'fast_forward_failed', detail: merged.err || merged.out };
    return { ok: true };
  }
  const before = gitOut(['rev-parse', base], root);
  const moved = gitOut(['update-ref', `refs/heads/${base}`, sha, before.ok ? before.out : ''], root);
  if (!moved.ok) return { ok: false, reason: 'update_ref_failed', detail: moved.err || moved.out };
  return { ok: true };
}

function pushBase(root, base, sha) {
  const remote = gitOut(['remote', 'get-url', 'origin'], root);
  if (!remote.ok) return { attempted: false, ok: false, reason: 'no_remote' };
  const pushed = runGit(['push', 'origin', `${sha}:refs/heads/${base}`], { cwd: root, check: false });
  return { attempted: true, ok: pushed.status === 0, detail: String(pushed.stderr || pushed.stdout || '').trim().slice(0, 300) };
}

// The board names the base as origin/master when a remote exists, so the
// merge target is the remote tip by construction. Refresh it first, and hold
// when the local branch carries commits origin lacks: pushing would fail and
// fast-forwarding the local branch would rewrite someone's unpushed work.
function localBaseName(base) {
  return String(base).replace(/^origin\//, '');
}

function resolveMergeTarget(root, base) {
  const local = localBaseName(base);
  const remote = gitOut(['remote', 'get-url', 'origin'], root);
  if (!remote.ok) return { ok: true, target: local, refreshed: false };
  spawnSync('git', ['fetch', 'origin', local], { cwd: root, encoding: 'utf8', timeout: 30000 });
  const remoteRef = `refs/remotes/origin/${local}`;
  const exists = gitOut(['rev-parse', '--verify', '--quiet', remoteRef], root);
  if (!exists.ok) return { ok: true, target: local, refreshed: true };
  const hasLocal = gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], root);
  if (hasLocal.ok) {
    const counts = gitOut(['rev-list', '--left-right', '--count', `refs/heads/${local}...${remoteRef}`], root);
    const [localOnly, remoteOnly] = counts.ok ? counts.out.split(/\s+/).map((n) => Number(n) || 0) : [0, 0];
    if (localOnly > 0) {
      return { ok: false, reason: 'base_diverged', detail: `local ${local} has ${localOnly} commit(s) origin lacks${remoteOnly ? ` and origin has ${remoteOnly} local lacks` : ''}` };
    }
  }
  return { ok: true, target: remoteRef, refreshed: true };
}

function scratchCheckout(root, branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-green-'));
  const added = gitOut(['worktree', 'add', '--detach', dir, branch], root);
  if (!added.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: added.err || added.out };
  }
  return { ok: true, dir };
}

function dropScratch(root, dir) {
  if (!dir) return;
  runGit(['worktree', 'remove', '--force', dir], { cwd: root, check: false });
  fs.rmSync(dir, { recursive: true, force: true });
  runGit(['worktree', 'prune'], { cwd: root, check: false });
}

function installDeps(dir) {
  // Zero-dependency repos verify without install; only run it when a lockfile
  // exists so the scratch checkout can resolve dev tooling.
  if (!fs.existsSync(path.join(dir, 'package-lock.json'))) return { ran: false, ok: true };
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  return { ran: true, ok: result.status === 0, detail: String(result.stderr || '').trim().slice(0, 300) };
}

function verdictFor(branch, base, extra) {
  return { branch, base, ...extra };
}

// Try to land exactly one branch. Returns a verdict with `action` in:
//   landed, red, skipped, error
function landOneBranch(root, base, branch, {
  verifyCommand = DEFAULT_VERIFY,
  verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  dryRun = false,
  push = true,
  runVerifyFn = runVerify,
  env = process.env,
} = {}) {
  const dirty = dirtyCheckouts(root, branch);
  if (dirty.length) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'checkout_dirty', detail: dirty.join(', ') });
  }
  const conflicts = mergeConflicts(root, base, branch);
  if (!conflicts.ok) return verdictFor(branch, base, { action: 'error', reason: 'merge_check_failed', detail: conflicts.error });
  if (conflicts.conflicts.length) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'merge_conflict', detail: conflicts.conflicts.slice(0, 6).join(', ') });
  }
  const lane = protectedSurfaces(root, base, branch);
  if (lane.protected) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'protected_surface', detail: lane.surfaces.join(', ') });
  }
  const target = resolveMergeTarget(root, base);
  if (!target.ok) return verdictFor(branch, base, { action: 'skipped', reason: target.reason, detail: target.detail });
  if (dryRun) return verdictFor(branch, base, { action: 'skipped', reason: 'dry_run', target: target.target });

  const scratch = scratchCheckout(root, branch);
  if (!scratch.ok) return verdictFor(branch, base, { action: 'error', reason: 'scratch_checkout_failed', detail: scratch.error });
  try {
    // Verify the merged state, not the branch tip: base may have moved since.
    const merged = gitOut(['merge', '--no-edit', '--no-ff', target.target, '-m', `land: ${branch} onto ${base} after a green verify`], scratch.dir);
    if (!merged.ok) return verdictFor(branch, base, { action: 'error', reason: 'merge_failed', detail: merged.err || merged.out });
    const deps = installDeps(scratch.dir);
    if (!deps.ok) return verdictFor(branch, base, { action: 'error', reason: 'install_failed', detail: deps.detail });
    const verify = runVerifyFn(verifyCommand, scratch.dir, { timeoutMs: verifyTimeoutMs, env });
    if (verify.status !== 0) {
      return verdictFor(branch, base, {
        action: 'red',
        reason: verify.timed_out ? 'verify_timed_out' : 'verify_failed',
        verify,
        owner: branchAuthor(root, branch),
      });
    }
    const sha = gitOut(['rev-parse', 'HEAD'], scratch.dir);
    if (!sha.ok) return verdictFor(branch, base, { action: 'error', reason: 'merged_sha_unreadable' });
    const local = localBaseName(base);
    const pushed = push ? pushBase(root, local, sha.out) : { attempted: false, ok: false, reason: 'push_disabled' };
    if (pushed.attempted && !pushed.ok) {
      // A race with another landing: origin moved after the fetch. Leave the
      // local branch alone so the next tick retries onto the new tip.
      return verdictFor(branch, base, { action: 'skipped', reason: 'push_rejected', detail: pushed.detail, verify });
    }
    const advanced = advanceBase(root, local, sha.out);
    if (!advanced.ok) return verdictFor(branch, base, { action: 'landed', sha: sha.out, verify, push: pushed, local_base: advanced.reason });
    return verdictFor(branch, base, { action: 'landed', sha: sha.out, verify, push: pushed });
  } finally {
    dropScratch(root, scratch.dir);
  }
}

function flagWhat(verdict) {
  const names = (verdict.verify && verdict.verify.failing) || [];
  const head = names.length ? names.slice(0, 3).join('; ') : (verdict.reason === 'verify_timed_out' ? 'the verify timed out' : 'the verify command failed');
  return `branch ${verdict.branch} fails its checks and cannot land: ${head}`;
}

function openRedFlag(root, verdict, { runCli } = {}) {
  const what = flagWhat(verdict);
  const args = ['close', 'add', what, '--owner', verdict.owner || 'operator', '--lane', 'code', '--ttl', '3',
    '--when', `${verdict.branch} passes ${verdict.verify ? verdict.verify.command : 'its checks'} and lands on ${verdict.base}`,
    '--source', 'land-green'];
  if (typeof runCli === 'function') return runCli(args);
  const bin = path.join(__dirname, '..', 'bin', 'atris.js');
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

// The tick entry point: pick the stale active branches the board already
// knows about, oldest activity first, and land at most `limit` of them.
function landStaleGreenBranches(root, {
  board = null,
  staleHours,
  ttlDays,
  base: baseOverride = '',
  limit = 1,
  now = Date.now(),
  verifyCommand = DEFAULT_VERIFY,
  verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  dryRun = false,
  push = true,
  openFlags = true,
  runVerifyFn = runVerify,
  runCli,
  env = process.env,
} = {}) {
  const { collectBoard } = require('../commands/land');
  const live = board || collectBoard(root, { staleHours, ttlDays, base: baseOverride, now, light: true });
  const candidates = live.branches
    .filter((b) => b.state === 'active' && b.stale)
    .sort((a, b) => b.activityHours - a.activityHours);
  const verdicts = [];
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= limit) {
      verdicts.push(verdictFor(candidate.name, live.base, { action: 'skipped', reason: 'per_tick_limit' }));
      continue;
    }
    attempts += 1;
    let verdict;
    try {
      verdict = landOneBranch(root, live.base, candidate.name, { verifyCommand, verifyTimeoutMs, dryRun, push, runVerifyFn, env });
    } catch (err) {
      verdict = verdictFor(candidate.name, live.base, { action: 'error', reason: 'exception', detail: String((err && err.message) || err).slice(0, 300) });
    }
    if (verdict.action === 'red' && openFlags) {
      try {
        const flagged = openRedFlag(root, verdict, { runCli });
        verdict.flag = { status: flagged.status, out: String(flagged.stdout || '').slice(0, 200) };
      } catch (err) {
        verdict.flag = { status: 1, out: String((err && err.message) || err).slice(0, 200) };
      }
    }
    verdicts.push(verdict);
  }
  return {
    at: new Date(now).toISOString(),
    base: live.base,
    candidates: candidates.map((b) => b.name),
    landed: verdicts.filter((v) => v.action === 'landed').map((v) => v.branch),
    red: verdicts.filter((v) => v.action === 'red').map((v) => v.branch),
    verdicts,
  };
}

function summaryLine(result) {
  if (!result || !result.candidates || result.candidates.length === 0) return 'no stale branches to land';
  const parts = [];
  if (result.landed.length) parts.push(`landed ${result.landed.join(', ')}`);
  if (result.red.length) parts.push(`red: ${result.red.join(', ')}`);
  for (const v of result.verdicts) {
    if (v.action === 'skipped' && v.reason !== 'per_tick_limit') parts.push(`${v.branch} held (${v.reason.replace(/_/g, ' ')}${v.detail ? `: ${v.detail}` : ''})`);
    if (v.action === 'error') parts.push(`${v.branch} error (${v.reason.replace(/_/g, ' ')})`);
  }
  const waiting = result.verdicts.filter((v) => v.reason === 'per_tick_limit').length;
  if (waiting) parts.push(`${waiting} more waiting for the next tick`);
  return parts.join('; ') || 'nothing landed';
}

module.exports = {
  DEFAULT_VERIFY,
  landStaleGreenBranches,

  failingLines,
  flagWhat,
  summaryLine,
};
