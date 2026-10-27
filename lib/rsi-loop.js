'use strict';

// atris rsi loop: find and ship notebook fixes with no mission queued.
//
// One run works on one isolated branch cut from the remote mainline. Built-in
// checks find problems in the atris/ notebook and fix them with no engine:
// line refs in the map docs that point at moved code, and plain-wording
// repairs the slop rules can make safely. Each check is applied, kept inside
// the allowed paths, verified, and committed on its own; a check that fails
// its verify is undone. The run then pushes the branch within the time left.
//
// Cleanup happens only after delivery is proven: the remote branch tip equals
// the checkout's HEAD and the checkout has no uncommitted changes. Any other
// end keeps the checkout and branch, and the next run picks the branch up.
// The main checkout is never edited, so its own uncommitted work is safe.
//
// Report: one atris.rsi.loop.v1 row per run in <rsi state>/loops.jsonl.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const rsi = require('./rsi-record');
const mapRefs = require('./map-refs');
const slop = require('../commands/slop');
const worktree = require('../commands/worktree');

const LOOP_SCHEMA = 'atris.rsi.loop.v1';
const DEFAULT_MINUTES = 5;
const MAX_MINUTES = 60;
const OWNER = 'rsi';
const JOB = 'notebook';
const BRANCH_PREFIX = `codex/${OWNER}-${JOB}`;
const MAX_WORDING_FILES = 10;
const CO_AUTHOR = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';
// The board and journal are rewritten by atris itself; team templates and
// atris/CLAUDE.md ship to every user project and need a version bump.
const OFF_LIMITS = /^atris\/(?:team\/|logs\/|TODO\.md$|CLAUDE\.md$)/;

function allowedPath(file) {
  return /^atris\/.+\.md$/.test(file) && !OFF_LIMITS.test(file);
}

function git(cwd, args, options = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', killSignal: 'SIGKILL', ...options });
}

function gitOut(cwd, args) {
  const r = git(cwd, args);
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

// Changed paths in a checkout, untracked files listed one by one.
function changedPaths(cwd) {
  const r = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\0').filter(Boolean)
    .map((entry) => ({ code: entry.slice(0, 2), file: entry.slice(3) }));
}

// Put back exactly what a check touched in the run's own checkout.
function undo(wt, changes) {
  for (const { code, file } of changes) {
    if (code === '??') fs.rmSync(path.join(wt, file), { force: true });
    else {
      git(wt, ['reset', '-q', '--', file]);
      git(wt, ['checkout', '--', file]);
    }
  }
}

function lockPath(root) {
  return path.join(path.dirname(rsi.attemptsPath(root)), 'loop.lock');
}

function loopsPath(root) {
  return path.join(path.dirname(rsi.attemptsPath(root)), 'loops.jsonl');
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// One loop per workspace. A lock whose process is gone is stale and is taken.
function acquireLock(root, { pid = process.pid, host = os.hostname(), isAlive = alive } = {}) {
  const file = lockPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${JSON.stringify({ pid, host, started_at: new Date().toISOString() })}\n`, { flag: 'wx' });
      return {
        ok: true,
        release: () => {
          const holder = read();
          if (holder && holder.pid === pid && holder.host === host) fs.rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = read();
    if (holder && (holder.host !== host || isAlive(holder.pid))) return { ok: false, holder };
    fs.rmSync(file, { force: true });
  }
  return { ok: false, holder: read() };
}

// Map docs: rewrite refs whose symbol moved to one clear line. Passes when no
// moved ref is left and no more refs need a person than before.
const mapRefsCheck = {
  name: 'map_refs',
  run(wt) {
    const root = fs.realpathSync(wt);
    const unsafe = mapRefs.existingMapDocs(wt).some((doc) => {
      try {
        const full = path.join(wt, doc);
        return !fs.lstatSync(full).isFile() || !fs.realpathSync(full).startsWith(`${root}${path.sep}`);
      } catch { return true; }
    });
    if (unsafe) throw new Error('map file is a symlink or outside the isolated checkout');
    const before = mapRefs.checkMapDocs(wt);
    const fixed = mapRefs.fixMapDocs(wt).changes.length;
    return {
      found: fixed,
      message: `rsi: point ${fixed} notebook line ref${fixed === 1 ? '' : 's'} at the moved code`,
      verify: () => {
        const after = mapRefs.checkMapDocs(wt);
        const left = (s) => s.ambiguous + s.missing + s.missing_file;
        return after.moved === 0 && left(after) <= left(before);
      },
    };
  },
};

// Wording: the slop rules' safe repairs on tracked notebook pages, a few
// files per run. Passes when the edited lines scan clean.
const wordingCheck = {
  name: 'wording',
  run(wt) {
    const tracked = gitOut(wt, ['ls-files', '--', 'atris']).split('\n').filter(allowedPath).filter((file) => {
      try {
        const full = path.join(wt, file);
        return fs.lstatSync(full).isFile() && fs.realpathSync(full).startsWith(`${fs.realpathSync(wt)}${path.sep}`);
      } catch { return false; }
    });
    const rules = slop.RULES.concat(slop.loadProjectRules(wt));
    const fixable = new Set(rules.filter((r) => typeof r.fix === 'function').map((r) => r.id));
    const flagged = [...new Set(slop.scanPaths(tracked, { root: wt, rules }).findings
      .filter((f) => fixable.has(f.rule)).map((f) => f.file))];
    const { fixedFiles } = slop.applyFixes(flagged.slice(0, MAX_WORDING_FILES), rules);
    return {
      found: fixedFiles.length,
      message: `rsi: plain wording in ${fixedFiles.length} notebook page${fixedFiles.length === 1 ? '' : 's'}`,
      verify: () => slop.scanPaths(fixedFiles, { root: wt, changedLines: slop.gitChangedLines(false, wt) }).findings.length === 0,
    };
  },
};

const CHECKS = [mapRefsCheck, wordingCheck];

// The newest kept run whose commits never reached the base, when its checkout
// is gone or clean, so a cut-off run is finished instead of redone.
function openCheckout(root, base) {
  const branch = BRANCH_PREFIX;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteHead = gitOut(root, ['rev-parse', '--verify', remoteRef]);
  const localHead = gitOut(root, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  // Never overwrite an existing local branch. Resume only our clean checkout.
  const checkout = worktree.listWorktrees(root).find((wt) => wt.branch === branch);
  if (checkout) {
    const changes = changedPaths(checkout.path);
    if (!changes || changes.length) return { error: 'RSI checkout contains uncommitted work; preserve it and resolve it before retrying' };
  }
  const start = localHead || remoteHead || base;
  if (remoteHead && git(root, ['merge-base', '--is-ancestor', remoteHead, start]).status !== 0) {
    return { error: 'local RSI branch does not contain the remote RSI branch; resolve the divergence before retrying' };
  }
  // Do not silently omit changes from the current mainline.
  if (git(root, ['merge-base', '--is-ancestor', base, start]).status !== 0) {
    return { error: 'RSI branch is behind or diverged from the remote mainline; integrate it before retrying' };
  }
  if (checkout) return { branch, wt: checkout.path, resumed: true };
  const wt = path.join(path.dirname(root), '.agent-worktrees', path.basename(root), 'rsi-notebook');
  const args = localHead ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, start];
  const added = git(root, args);
  if (added.status !== 0) return { error: String(added.stderr || 'worktree add failed').trim() };
  return { branch, wt, resumed: Boolean(localHead || remoteHead), error: null };
}

// Remove the checkout and local branch. Plain removal refuses a checkout with
// changes, so nothing unsaved is ever lost here.
function cleanup(root, wt, branch) {
  if (git(root, ['worktree', 'remove', wt]).status !== 0) return false;
  return git(root, ['branch', '-D', branch]).status === 0;
}

/**
 * Run the notebook checks and ship them within opts.minutes. deps can replace
 * now, checks, and isAlive for tests. Returns the report row plus
 * report_path, or { ok: false, refused } when the run does not start.
 */
async function runLoop(opts = {}, deps = {}) {
  const root = path.resolve(opts.workspace || process.cwd());
  const clock = deps.now || Date.now;
  const checks = deps.checks || CHECKS;
  const minutes = opts.minutes === undefined ? DEFAULT_MINUTES : opts.minutes;
  if (!(typeof minutes === 'number' && minutes > 0 && minutes <= MAX_MINUTES)) {
    return { ok: false, refused: `--minutes must be a number above 0 and at most ${MAX_MINUTES}` };
  }
  if (process.env[rsi.GUARD_ENV]) return { ok: false, refused: 'an rsi attempt is already open in this process; a loop inside it would nest' };
  if (!gitOut(root, ['rev-parse', '--verify', 'HEAD'])) return { ok: false, refused: 'not a git checkout with a commit' };
  if (!gitOut(root, ['remote', 'get-url', 'origin'])) return { ok: false, refused: 'no origin remote to push the fixes to' };
  const lock = acquireLock(root, { isAlive: deps.isAlive || alive });
  if (!lock.ok) {
    const h = lock.holder || {};
    return { ok: false, refused: `another rsi loop holds this workspace (pid ${h.pid || '?'} on ${h.host || '?'})` };
  }

  const startedMs = clock();
  const deadline = startedMs + minutes * 60000;
  const left = () => deadline - clock();
  const row = {
    schema: LOOP_SCHEMA,
    started_at: new Date(startedMs).toISOString(),
    max_minutes: minutes,
    branch: null,
    resumed: false,
    checks: [],
    commits: 0,
    pushed_sha: null,
    delivered: false,
    cleaned: false,
    kept: null,
    stop_reason: null,
  };
  try {
    await shipOnce(root, row, { checks, left, now: clock });
  } catch (error) {
    row.stop_reason = row.stop_reason || 'error';
    row.error = String((error && error.message) || error);
  } finally {
    lock.release();
  }
  row.finished_at = new Date(clock()).toISOString();
  row.ok = ['delivered', 'nothing_to_do'].includes(row.stop_reason);
  const reportPath = loopsPath(root);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.appendFileSync(reportPath, `${JSON.stringify(row)}\n`, 'utf8');
  return { ...row, report_path: reportPath };
}

async function shipOnce(root, row, { checks, left, now }) {
  if (left() <= 0) { row.stop_reason = 'time_budget'; return; }
  const fetched = git(root, ['fetch', '-q', 'origin'], { timeout: Math.max(1, Math.min(30000, left())), env: worktree.gitNetworkEnvironment(process.env, root) });
  if (fetched.status !== 0) { row.stop_reason = 'fetch_failed'; row.error = String(fetched.stderr || fetched.error || 'fetch failed').trim(); return; }
  if (left() <= 0) { row.stop_reason = 'time_budget'; return; }
  const base = worktree.defaultMainlineBase(root);
  const opened = openCheckout(root, base);
  if (opened.error) { row.stop_reason = 'checkout_failed'; row.error = opened.error; return; }
  const { wt, branch } = opened;
  row.branch = branch;
  row.resumed = opened.resumed;
  const keep = (reason) => { row.stop_reason = reason; row.kept = wt; };

  for (const check of checks) {
    if (left() <= 0) return keep('time_budget');
    const result = check.run(wt);
    const changes = changedPaths(wt);
    if (!changes) return keep('status_failed');
    const entry = { name: check.name, found: result.found || 0, files: changes.map((c) => c.file), outcome: 'nothing' };
    row.checks.push(entry);
    if (!changes.length) continue;
    if (changes.some((c) => !allowedPath(c.file))) { undo(wt, changes); entry.outcome = 'outside_allowed_paths'; continue; }
    if (!result.verify()) { undo(wt, changes); entry.outcome = 'verify_failed'; continue; }
    const staged = git(wt, ['add', '--', ...entry.files]);
    if (staged.status !== 0) { row.error = String(staged.stderr || 'git add failed').trim(); return keep('stage_failed'); }
    const committed = git(wt, ['commit', '-q', '-m', `${result.message}\n\n${CO_AUTHOR}`]);
    if (committed.status !== 0) {
      entry.outcome = 'commit_blocked';
      row.error = String(committed.stderr || committed.stdout || '').trim().slice(0, 400);
      return keep('commit_blocked');
    }
    entry.outcome = 'committed';
    row.commits += 1;
  }

  const remoteHead = gitOut(root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
  const headBeforePush = gitOut(wt, ['rev-parse', 'HEAD']);
  const ahead = remoteHead ? remoteHead !== headBeforePush : gitOut(wt, ['cherry', base, 'HEAD']).split('\n').some((line) => line.startsWith('+'));
  if (!ahead) {
    row.stop_reason = 'nothing_to_do';
    row.cleaned = cleanup(root, wt, branch);
    if (!row.cleaned) row.kept = wt;
    return;
  }
  if (left() <= 0) return keep('time_budget');
  const head = gitOut(wt, ['rev-parse', 'HEAD']);
  const pushed = git(wt, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], {
    timeout: left(),
    env: worktree.gitNetworkEnvironment(process.env, wt),
  });
  if (pushed.status !== 0) {
    row.error = String(pushed.stderr || (pushed.error && pushed.error.message) || '').trim().slice(0, 400);
    return keep(pushed.signal || left() <= 0 ? 'time_budget' : 'push_failed');
  }
  const remoteTip = git(wt, ['ls-remote', 'origin', `refs/heads/${branch}`], { timeout: Math.max(1, left()), env: worktree.gitNetworkEnvironment(process.env, wt) }).stdout?.trim().split(/\s+/)[0];
  const clean = (changedPaths(wt) || [null]).length === 0;
  if (remoteTip !== head || !clean) return keep('delivery_unproven');
  row.pushed_sha = head;
  row.delivered = true;
  row.stop_reason = 'delivered';
  row.cleaned = cleanup(root, wt, branch);
  if (!row.cleaned) row.kept = wt;
}

const STOP_WORDS = {
  delivered: 'the fixes are pushed',
  nothing_to_do: 'the checks found nothing to fix',
  time_budget: 'the time ran out before the push',
  push_failed: 'the push was refused',
  commit_blocked: 'a commit was refused',
  delivery_unproven: 'the remote branch does not match the commit',
  checkout_failed: 'the isolated checkout could not be made',
  error: 'something failed',
};

function formatLoopReport(result = {}) {
  if (result.refused) return `rsi loop did not start: ${result.refused}.`;
  const lines = [`rsi loop: ${result.commits} fix commit${result.commits === 1 ? '' : 's'}, stopped because ${STOP_WORDS[result.stop_reason] || result.stop_reason}.`];
  for (const c of result.checks || []) lines.push(`  ${c.name}: ${c.outcome}${c.files.length ? ` (${c.files.length} file${c.files.length === 1 ? '' : 's'})` : ''}`);
  if (result.branch) lines.push(`branch: ${result.branch}${result.pushed_sha ? ` at ${result.pushed_sha.slice(0, 12)}` : ''}`);
  if (result.kept) lines.push(`kept for the next run: ${result.kept}`);
  if (result.error) lines.push(`detail: ${String(result.error).split('\n')[0]}`);
  if (result.report_path) lines.push(`report: ${result.report_path}`);
  return lines.join('\n');
}

module.exports = {
  BRANCH_PREFIX,
  CHECKS,
  allowedPath,
  runLoop,
  formatLoopReport,
  loopsPath,
  lockPath,
};
