'use strict';

// Green landing for stale branches.
//
// The landing board already classifies every branch: landed, active, due.
// Before this module the loop had exactly two moves for finished work that
// nobody merged: carry it in the digest, then salvage-reap it after the TTL.
// Both of the branches that sat "in the air" on 2026-09-01 were green and
// merged cleanly; they waited four days for a human to run the suite by hand.
//
// This is the third move. A stale active branch that touches no protected
// surface is caught up with the base in a scratch checkout and passes the full
// verify there. On a GitHub remote it then goes through the repo's own merge
// path: the caught-up branch is pushed, a pull request is opened or reused,
// and it joins the merge queue so the hosted checks decide. The base branch
// itself is never pushed there. A repo with no remote moves its local base;
// another kind of remote is pushed as before. A branch that fails opens one
// close flag naming the failing checks. A clash only in the map files takes
// the base's copy and refreshes the map; any other clash goes back to a
// builder as a job naming the files. Up to five branches per tick, one at a
// time.
//
// What the receipts showed on 2026-11-15, over 304 hourly runs that landed
// nothing: the same four clashing branches sat at the head of the queue every
// hour and counted as misses, so every branch behind them was held as
// attempt_cap (1897 times). Under cron, npm was not on PATH, so every install
// failed with an empty reason (496 times). And the landing push went straight
// to master, which the merge queue rule rejects.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runGit } = require('./git-spawn');
const { proveCheckBeforePublish, proveLanding } = require('./landing-proof');

const DEFAULT_VERIFY = 'npm test';
const DEFAULT_VERIFY_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_LIMIT = 5;
// Stop the walk after this many consecutive branches that errored in a
// scratch checkout, so a queue of broken branches does not burn a scratch
// checkout per branch. A cheap hold (a clash, a protected surface, a busy
// checkout) is not a miss: it costs no checkout and must not starve the rest.
const DEFAULT_MAX_MISSES = 4;
// Tries on one branch head against one base before it waits for either to
// move. An error may be the machine, so it gets a few; a red verify does not
// change on a rerun of the same two commits.
const ERROR_TRIES = 3;
// Files a command can rebuild: the map and its reference notes. A clash only
// here takes the base's copy and runs the map refresh instead of holding.
const REGENERABLE = /^atris\/(?:MAP\.md|refs\/MAP-NOTES\.md|refs\/map\/[^/]+\.md)$/;
const MAP_REFRESH_MESSAGE = 'Refresh map references that moved';
const ATRIS_TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';
const FAILING_LINE = /^(?:✖|not ok)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/;

function gitOut(args, cwd) {
  const result = runGit(args, { cwd, check: false });
  return { ok: result.status === 0, out: String(result.stdout || '').trim(), err: String(result.stderr || '').trim() };
}

// A git step that may run the repo's own hooks (commit, merge). The hooks
// call node, so they get the same PATH the install and verify get.
function gitHooked(args, cwd, env = process.env) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: toolEnv(env), maxBuffer: 16 * 1024 * 1024 });
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

// Cron starts the tick with PATH=/usr/bin:/bin, where npm and gh do not
// live. The folder of the node running this tick holds npm; the usual package
// folders hold gh. They go after the caller's own PATH, so a PATH that already
// finds the tools still wins.
function toolEnv(env = process.env) {
  const current = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extra = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin']
    .filter((dir, i, all) => all.indexOf(dir) === i && !current.includes(dir) && fs.existsSync(dir));
  return { ...env, PATH: [...current, ...extra].join(path.delimiter) };
}

function runVerify(command, cwd, { timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, env = process.env } = {}) {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...toolEnv(env), ATRIS_SKIP_UPDATE_CHECK: '1' },
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

function fetchBase(root, base) {
  spawnSync('git', ['fetch', 'origin', localBaseName(base)], { cwd: root, encoding: 'utf8', timeout: 30000 });
}

// prFlow: the landing goes through a pull request, so the local base branch
// is never moved and a local base that diverged from origin does not matter.
function resolveMergeTarget(root, base, { fetch = true, prFlow = false } = {}) {
  const local = localBaseName(base);
  const remote = gitOut(['remote', 'get-url', 'origin'], root);
  if (!remote.ok) return { ok: true, target: local, refreshed: false };
  if (fetch) fetchBase(root, base);
  const remoteRef = `refs/remotes/origin/${local}`;
  const exists = gitOut(['rev-parse', '--verify', '--quiet', remoteRef], root);
  if (!exists.ok) return { ok: true, target: local, refreshed: true };
  const hasLocal = gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], root);
  if (hasLocal.ok && !prFlow) {
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

// A lockfile that names no package besides the project itself has nothing to
// install. One that cannot be read is handed to npm, which says why.
function lockNeedsInstall(file) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return true;
  }
  if (!lock || typeof lock !== 'object') return true;
  const packages = lock.packages && typeof lock.packages === 'object' ? Object.keys(lock.packages).filter((key) => key !== '') : null;
  const deps = lock.dependencies && typeof lock.dependencies === 'object' ? Object.keys(lock.dependencies) : [];
  return packages ? packages.length > 0 : deps.length > 0;
}

function installDeps(dir, env = process.env) {
  // Zero-dependency repos verify without install; only run it when a lockfile
  // names packages so the scratch checkout can resolve dev tooling.
  const lock = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(lock) || !lockNeedsInstall(lock)) return { ran: false, ok: true };
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: toolEnv(env),
  });
  const why = String(result.stderr || '').trim() || String(result.stdout || '').trim()
    || (result.error ? `npm could not start (${result.error.code || result.error.message})` : `npm exited ${result.status}`);
  return { ran: true, ok: result.status === 0, detail: why.slice(0, 300) };
}

function isGithubRemote(root) {
  const remote = gitOut(['remote', 'get-url', 'origin'], root);
  return remote.ok && /github\.com[:/]/i.test(remote.out);
}

function defaultRunGh(args, cwd, env = process.env) {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 120000, env: toolEnv(env) });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim() || (result.error ? `gh could not start (${result.error.code || result.error.message})` : ''),
  };
}

function defaultRecordQueued(root, fields) {
  return require('./member-autoland').recordQueuedPullRequest(root, fields, { fresh: true });
}

// The repo's own merge path: push the caught-up branch, open or reuse its
// pull request, and put it in the merge queue pinned to the checked commit.
// GitHub runs the hosted checks and merges; the tick's queue sweep watches it.
function queueThroughPullRequest(root, { branch, local, sha, verify, runGh, recordQueued, env }) {
  const pushed = runGit(['push', 'origin', `${sha}:refs/heads/${branch}`], { cwd: root, check: false });
  if (pushed.status !== 0) {
    return { action: 'skipped', reason: 'push_rejected', detail: String(pushed.stderr || pushed.stdout || '').trim().slice(0, 300) };
  }
  const listed = runGh(['pr', 'list', '--head', branch, '--base', local, '--state', 'open',
    '--json', 'number,headRefName,baseRefName,isCrossRepository,url'], root, env);
  if (!listed.ok) return { action: 'error', reason: 'pull_request_unreadable', detail: listed.stderr.split('\n')[0] };
  let rows = null;
  try { rows = JSON.parse(listed.stdout || '[]'); } catch {}
  if (!Array.isArray(rows)) return { action: 'error', reason: 'pull_request_unreadable', detail: 'open pull requests could not be read' };
  const matches = rows.filter((pr) => pr && pr.headRefName === branch && pr.baseRefName === local
    && pr.isCrossRepository === false && Number.isInteger(pr.number) && pr.number > 0);
  if (matches.length > 1) return { action: 'skipped', reason: 'many_pull_requests', detail: matches.map((pr) => `#${pr.number}`).join(', ') };
  let number = matches.length ? matches[0].number : 0;
  let url = matches.length ? String(matches[0].url || '') : '';
  if (!number) {
    const subject = gitOut(['log', '-1', '--format=%s', branch], root);
    const title = String((subject.ok && subject.out) || branch).replace(/\s+/g, ' ').trim().slice(0, 70);
    const body = `Caught up with ${local} and checked with \`${verify}\` by the green lander. The merge queue runs the hosted checks.`;
    const created = runGh(['pr', 'create', '--head', branch, '--base', local, '--title', title, '--body', body], root, env);
    url = created.ok ? created.stdout.split('\n').pop().trim() : '';
    number = Number((url.match(/\/pull\/(\d+)$/) || [])[1] || 0);
    if (!created.ok || !number) {
      return { action: 'error', reason: 'pull_request_not_opened', detail: (created.stderr || url).split('\n')[0] };
    }
  }
  const merge = runGh(['pr', 'merge', String(number), '--auto', '--merge', '--match-head-commit', sha], root, env);
  if (!merge.ok) return { action: 'error', reason: 'merge_queue_refused', detail: merge.stderr.split('\n')[0], pr: number, url };
  let recorded = true;
  try { recordQueued(root, { branch, base: local, number, pushed: sha, source: 'land-green', task_ids: [], requeues: 0 }); } catch { recorded = false; }
  return { action: 'queued', pr: number, url: url || `pull request #${number}`, recorded };
}

// A clash with real code goes back to a builder as a job naming the files.
// One job per branch head: a later tick on the same commits finds it again.
function defaultFileConflictTask(root, { branch, base, head, files, member }) {
  const taskDb = require('./task-db');
  const { workspaceRoot } = require('./workspace-root');
  const db = taskDb.open();
  const shown = files.slice(0, 4).join(', ') + (files.length > 4 ? ` and ${files.length - 4} more` : '');
  const metadata = {
    source: 'land-green',
    branch,
    conflict_files: files,
    objective: `Merge ${base} into ${branch} and settle the clash in ${shown}. Run the checks and push the branch; the green lander queues it on its next run.`,
  };
  if (member) metadata.assigned_to = member;
  const added = taskDb.addTask(db, {
    title: `catch up ${branch} with ${base}: it clashes in ${shown}`,
    tag: 'code',
    workspaceRoot: workspaceRoot(root),
    sourceKey: `land-green:clash:${branch}:${String(head).slice(0, 12)}`,
    metadata,
  });
  return { id: added.id, inserted: added.inserted };
}

function handBackMember(root) {
  return fs.existsSync(path.join(root, 'atris', 'team', 'builder')) ? 'builder' : '';
}

// Rebuild the map references in a checkout and commit what moved. Returns the
// files it changed; a refresh that throws changes nothing and the verify
// still judges the map.
function refreshMap(dir, env = process.env) {
  let changes = [];
  try {
    ({ changes } = require('./map-refs').fixMapDocs(dir));
  } catch {
    return [];
  }
  const docs = [...new Set(changes.map((change) => change.doc))];
  if (!docs.length) return [];
  gitOut(['add', '--', ...docs], dir);
  if (gitOut(['diff', '--cached', '--quiet'], dir).ok) return [];
  const done = gitHooked(['commit', '-m', MAP_REFRESH_MESSAGE, '-m', ATRIS_TRAILER], dir, env);
  return done.ok ? docs : [];
}

function verdictFor(branch, base, extra) {
  return { branch, base, ...extra };
}

// Try to land exactly one branch. Returns a verdict with `action` in:
//   landed, queued, red, skipped, error, no_op, not_landed, unverified, pushed
// `tried` is set once a scratch checkout was spent on it.
function landOneBranch(root, base, branch, {
  verifyCommand = DEFAULT_VERIFY,
  verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  dryRun = false,
  push = true,
  prFlow = false,
  fetch = true,
  runVerifyFn = runVerify,
  runGh = defaultRunGh,
  recordQueued = defaultRecordQueued,
  env = process.env,
} = {}) {
  const dirty = dirtyCheckouts(root, branch);
  if (dirty.length) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'checkout_dirty', detail: dirty.join(', ') });
  }
  // Protected work waits for its owner whatever else is true of it.
  const lane = protectedSurfaces(root, base, branch);
  if (lane.protected) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'protected_surface', detail: lane.surfaces.join(', ') });
  }
  const conflicts = mergeConflicts(root, base, branch);
  if (!conflicts.ok) return verdictFor(branch, base, { action: 'error', reason: 'merge_check_failed', detail: conflicts.error });
  const clashing = conflicts.conflicts;
  const realClash = clashing.filter((file) => !REGENERABLE.test(file));
  if (realClash.length) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'merge_conflict', detail: realClash.slice(0, 6).join(', '), files: realClash });
  }
  const target = resolveMergeTarget(root, base, { fetch, prFlow });
  if (!target.ok) return verdictFor(branch, base, { action: 'skipped', reason: target.reason, detail: target.detail });
  const plan = prFlow ? 'queue_pull_request' : 'merge_to_base';
  if (dryRun) {
    return verdictFor(branch, base, {
      action: 'skipped', reason: 'dry_run', target: target.target, plan,
      regenerate: clashing.length ? clashing : undefined,
    });
  }

  const scratch = scratchCheckout(root, branch);
  if (!scratch.ok) return verdictFor(branch, base, { action: 'error', reason: 'scratch_checkout_failed', detail: scratch.error, tried: true });
  try {
    const out = (extra) => verdictFor(branch, base, { tried: true, ...extra });
    // Verify the merged state, not the branch tip: base may have moved since.
    // A branch that is only behind is caught up right here.
    const before = gitOut(['rev-parse', target.target], scratch.dir);
    const merged = gitHooked(['merge', '--no-edit', '--no-ff', target.target, '-m', `land: ${branch} onto ${base} after a green verify`], scratch.dir, env);
    let regenerated = [];
    if (!merged.ok) {
      const unmerged = gitOut(['diff', '--name-only', '--diff-filter=U'], scratch.dir);
      const files = unmerged.ok ? unmerged.out.split(/\r?\n/).filter(Boolean) : [];
      if (!files.length || files.some((file) => !REGENERABLE.test(file))) {
        gitOut(['merge', '--abort'], scratch.dir);
        return out({ action: 'error', reason: 'merge_failed', detail: merged.err || merged.out, files });
      }
      // Only map files clash: take the base's copy, then rebuild the refs.
      let step = gitOut(['checkout', target.target, '--', ...files], scratch.dir);
      if (step.ok) step = gitOut(['add', '--', ...files], scratch.dir);
      if (step.ok) step = gitHooked(['-c', 'core.editor=true', 'commit', '--no-edit'], scratch.dir, env);
      if (!step.ok) {
        gitOut(['merge', '--abort'], scratch.dir);
        return out({ action: 'error', reason: 'map_regenerate_failed', detail: `${files.join(', ')}: ${(step.err || step.out).split('\n')[0]}`.slice(0, 300) });
      }
      regenerated = files;
    }
    const refreshed = refreshMap(scratch.dir, env);
    const notes = {};
    if (regenerated.length) notes.regenerated = regenerated;
    if (refreshed.length) notes.map_refreshed = refreshed;
    // A branch of empty commits (a "Start flight" marker, a change already on
    // base) merges clean and passes every check. Landing it would record a
    // landing over nothing, so it is named a no-op and never pushed.
    if (gitOut(['diff', '--quiet', target.target, 'HEAD'], scratch.dir).ok) {
      return out({ action: 'no_op', reason: 'empty_diff', detail: `${branch} changes nothing on ${base}`, ...notes });
    }
    const deps = installDeps(scratch.dir, env);
    if (!deps.ok) return out({ action: 'error', reason: 'install_failed', detail: deps.detail, ...notes });
    const verify = runVerifyFn(verifyCommand, scratch.dir, { timeoutMs: verifyTimeoutMs, env });
    if (verify.status !== 0) {
      return out({
        action: 'red',
        reason: verify.timed_out ? 'verify_timed_out' : 'verify_failed',
        verify,
        owner: branchAuthor(root, branch),
        ...notes,
      });
    }
    const sha = gitOut(['rev-parse', 'HEAD'], scratch.dir);
    if (!sha.ok) return out({ action: 'error', reason: 'merged_sha_unreadable', ...notes });
    const checkCommand = verify.command || verifyCommand;
    // Nothing is published on a check that could not have caught a break: it
    // must be one that can fail, and it must have run on this merged commit
    // with every changed file committed and tracked. Otherwise hold.
    const unbacked = proveCheckBeforePublish(scratch.dir, {
      commit: sha.out,
      base: before.ok ? before.out : target.target,
      verify: checkCommand,
    });
    if (unbacked) {
      return out({ action: 'skipped', reason: unbacked.reason, detail: unbacked.detail, verify, ...notes });
    }
    const local = localBaseName(base);
    if (prFlow) {
      if (!push) return out({ action: 'skipped', reason: 'push_disabled', detail: 'checked green; would queue it through a pull request', sha: sha.out, verify, plan, ...notes });
      const queued = queueThroughPullRequest(root, { branch, local, sha: sha.out, verify: checkCommand, runGh, recordQueued, env });
      return out({ ...queued, sha: sha.out, verify, ...notes });
    }
    const pushed = push ? pushBase(root, local, sha.out) : { attempted: false, ok: false, reason: 'push_disabled' };
    if (pushed.attempted && !pushed.ok) {
      // A race with another landing: origin moved after the fetch. Leave the
      // local branch alone so the next tick retries onto the new tip.
      return out({ action: 'skipped', reason: 'push_rejected', detail: pushed.detail, verify, ...notes });
    }
    const advanced = advanceBase(root, local, sha.out);
    // "landed" is a fact about the target branch, checked after the fact by
    // the same rule every receipt uses: the commit must be on origin's copy.
    // A local branch only counts in a repo with no remote at all; with a
    // remote, an unpushed merge is not landed however the local ref moved.
    const noRemote = !gitOut(['remote'], root).out;
    const landing = proveLanding(root, {
      commit: sha.out,
      base: before.ok ? before.out : '',
      target: noRemote ? `refs/heads/${local}` : `refs/remotes/origin/${local}`,
      verify: checkCommand,
      localTargetOk: noRemote,
    });
    if (landing.status !== 'landed') {
      // Once pushed, the merge is on origin whatever the check says; the
      // record names both facts instead of a bare "unverified".
      return out({
        action: pushed.ok ? 'pushed' : landing.status,
        reason: landing.reason,
        detail: landing.detail,
        landing_check: landing.status,
        sha: sha.out,
        verify,
        push: pushed,
        local_base: advanced.ok ? undefined : advanced.reason,
        landing,
        ...notes,
      });
    }
    if (!advanced.ok) return out({ action: 'landed', sha: sha.out, verify, push: pushed, local_base: advanced.reason, landing, ...notes });
    return out({ action: 'landed', sha: sha.out, verify, push: pushed, landing, ...notes });
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

// What the lander remembers between ticks, per branch: the branch head, the
// base and the check it last tried, and how many times that exact try missed.
// Kept in the repo's git folder, so it is shared by every checkout and never
// shows up as a change.
function stateFilePath(root) {
  const dir = gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  return dir.ok && dir.out ? path.join(dir.out, 'atris-land-green.json') : '';
}

function readState(file) {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && data.branches && typeof data.branches === 'object' ? data.branches : {};
  } catch {
    return {};
  }
}

function writeState(file, branches) {
  if (!file) return;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ schema: 'atris.land_green.v1', branches }, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {}
}

function triesAllowed(entry) {
  return entry && entry.action === 'error' ? ERROR_TRIES : 1;
}

function sameTry(entry, key) {
  return Boolean(entry) && entry.head === key.head && entry.base === key.base && entry.verify === key.verify;
}

const SUCCESS = new Set(['landed', 'queued']);

// The tick entry point: pick the stale active branches the board already
// knows about, oldest activity first, and land at most `limit` of them.
function landStaleGreenBranches(root, {
  board = null,
  staleHours,
  ttlDays,
  base: baseOverride = '',
  limit = DEFAULT_LIMIT,
  maxMisses = DEFAULT_MAX_MISSES,
  now = Date.now(),
  verifyCommand = DEFAULT_VERIFY,
  verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  dryRun = false,
  push = true,
  openFlags = true,
  handBack = openFlags,
  mergePath = 'auto',
  runVerifyFn = runVerify,
  runCli,
  runGh = defaultRunGh,
  recordQueued = defaultRecordQueued,
  fileConflictTask = defaultFileConflictTask,
  stateFile,
  env = process.env,
} = {}) {
  const { collectBoard } = require('../commands/land');
  const live = board || collectBoard(root, { staleHours, ttlDays, base: baseOverride, now, light: true });
  const candidates = live.branches
    .filter((b) => b.state === 'active' && b.stale)
    .sort((a, b) => b.activityHours - a.activityHours);
  const prFlow = mergePath === 'pull_request' || (mergePath === 'auto' && isGithubRemote(root));
  const hasRemote = gitOut(['remote', 'get-url', 'origin'], root).ok;
  if (hasRemote && candidates.length) fetchBase(root, live.base);
  const file = stateFile === undefined ? stateFilePath(root) : stateFile;
  const memory = readState(file);
  const local = localBaseName(live.base);
  const member = handBackMember(root);
  const verdicts = [];
  // Any verdict that ran the verify suite spends the per-tick budget, landed
  // or not: a run of pushed-but-unproven or no-landing verdicts must not run
  // five 20-minute suites in one tick. A branch that errored in a scratch
  // checkout is a miss; a bounded run of misses stops the walk so a fully
  // broken queue does not burn a scratch checkout per branch per tick.
  let spent = 0;
  let misses = 0;
  for (const candidate of candidates) {
    if (spent >= limit || misses >= maxMisses) {
      verdicts.push(verdictFor(candidate.name, live.base, { action: 'skipped', reason: spent >= limit ? 'per_tick_limit' : 'attempt_cap' }));
      continue;
    }
    const headRead = gitOut(['rev-parse', candidate.name], root);
    const baseRead = gitOut(['rev-parse', live.base], root);
    const key = { head: headRead.ok ? headRead.out : '', base: baseRead.ok ? baseRead.out : '', verify: verifyCommand };
    const prior = memory[candidate.name];
    // No permanent give-up: the same two commits wait, but a new commit on
    // the branch or on the base starts the count over.
    if (!dryRun && key.head && sameTry(prior, key) && (Number(prior.misses) || 0) >= triesAllowed(prior)) {
      verdicts.push(verdictFor(candidate.name, live.base, {
        action: 'skipped', reason: 'waiting_for_change',
        detail: `${String(prior.reason || prior.action).replace(/_/g, ' ')} on these commits; tries again once the branch or ${local} moves`,
      }));
      continue;
    }
    let verdict;
    try {
      verdict = landOneBranch(root, live.base, candidate.name, {
        verifyCommand, verifyTimeoutMs, dryRun, push, prFlow, fetch: false, runVerifyFn, runGh, recordQueued, env,
      });
    } catch (err) {
      verdict = verdictFor(candidate.name, live.base, { action: 'error', reason: 'exception', tried: true, detail: String((err && err.message) || err).slice(0, 300) });
    }
    if (SUCCESS.has(verdict.action) || verdict.action === 'red' || verdict.verify) {
      spent += 1;
      misses = 0;
    } else if (verdict.action === 'error') {
      misses += 1;
    }
    if (verdict.action === 'red' && openFlags) {
      try {
        const flagged = openRedFlag(root, verdict, { runCli });
        verdict.flag = { status: flagged.status, out: String(flagged.stdout || '').slice(0, 200) };
      } catch (err) {
        verdict.flag = { status: 1, out: String((err && err.message) || err).slice(0, 200) };
      }
    }
    if (verdict.reason === 'merge_conflict' && Array.isArray(verdict.files) && verdict.files.length) {
      if (dryRun || !handBack) {
        verdict.hand_back = { would: true, member: member || null };
      } else {
        try {
          const task = fileConflictTask(root, { branch: candidate.name, base: local, head: key.head, files: verdict.files, member });
          verdict.hand_back = { task_id: task.id, new: Boolean(task.inserted), member: member || null };
        } catch (err) {
          verdict.hand_back = { error: String((err && err.message) || err).slice(0, 200) };
        }
      }
    }
    if (!dryRun) {
      if (SUCCESS.has(verdict.action)) {
        delete memory[candidate.name];
      } else if (verdict.tried && key.head) {
        const count = sameTry(prior, key) ? (Number(prior.misses) || 0) + 1 : 1;
        memory[candidate.name] = { ...key, action: verdict.action, reason: verdict.reason || null, misses: count, at: new Date(now).toISOString() };
      }
    }
    verdicts.push(verdict);
  }
  if (!dryRun) {
    // Branches the board no longer lists are forgotten.
    const listed = new Set(live.branches.map((b) => b.name));
    for (const name of Object.keys(memory)) if (!listed.has(name)) delete memory[name];
    writeState(file, memory);
  }
  return {
    at: new Date(now).toISOString(),
    base: live.base,
    merge_path: prFlow ? 'pull_request' : (hasRemote ? 'push' : 'local'),
    candidates: candidates.map((b) => b.name),
    landed: verdicts.filter((v) => v.action === 'landed').map((v) => v.branch),
    queued: verdicts.filter((v) => v.action === 'queued').map((v) => v.branch),
    red: verdicts.filter((v) => v.action === 'red').map((v) => v.branch),
    handed_back: verdicts.filter((v) => v.hand_back && v.hand_back.task_id).map((v) => v.branch),
    verdicts,
  };
}

function summaryLine(result) {
  if (!result || !result.candidates || result.candidates.length === 0) return 'no stale branches to land';
  const parts = [];
  if (result.landed.length) parts.push(`landed ${result.landed.join(', ')}`);
  const queued = result.verdicts.filter((v) => v.action === 'queued');
  if (queued.length) parts.push(`in the merge queue: ${queued.map((v) => `${v.branch} (${v.url || `#${v.pr}`})`).join(', ')}`);
  if (result.red.length) parts.push(`red: ${result.red.join(', ')}`);
  for (const v of result.verdicts) {
    if (v.hand_back && v.hand_back.task_id) {
      parts.push(`${v.branch} clashes in ${v.detail}; handed back as job ${v.hand_back.task_id}`);
      continue;
    }
    if (v.action === 'skipped' && v.reason !== 'per_tick_limit') parts.push(`${v.branch} held (${v.reason.replace(/_/g, ' ')}${v.detail ? `: ${v.detail}` : ''})`);
    if (v.action === 'error') parts.push(`${v.branch} error (${v.reason.replace(/_/g, ' ')})`);
    if (v.action === 'pushed') parts.push(`${v.branch} pushed, landing check: ${String(v.landing_check).replace(/_/g, ' ')} (${v.reason.replace(/_/g, ' ')})`);
    if (['no_op', 'not_landed', 'unverified'].includes(v.action)) parts.push(`${v.branch} not landed (${v.reason.replace(/_/g, ' ')})`);
  }
  const waiting = result.verdicts.filter((v) => v.reason === 'per_tick_limit').length;
  if (waiting) parts.push(`${waiting} more waiting for the next tick`);
  return parts.join('; ') || 'nothing landed';
}

module.exports = {
  DEFAULT_VERIFY,
  DEFAULT_LIMIT,
  landStaleGreenBranches,
  // The member merge-line sweep hands its clashes back the same way.
  fileConflictTask: (root, job) => defaultFileConflictTask(root, { member: handBackMember(root), ...job }),

  failingLines,
  flagWhat,
  summaryLine,
};
