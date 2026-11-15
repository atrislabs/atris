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
//
// The run at 11:18Z the same day took 82 minutes and landed nothing: four
// healthy branches ran the whole suite locally on a machine with a load near
// 150, hit the 20 minute limit and were marked red. The base there is guarded
// by a required merge queue that runs the same suite in about 5 minutes. So
// when the base's rules require hosted checks, the lander runs no local suite:
// it catches the branch up, queues the pull request and lets the hosted checks
// decide. Policy green_landing_local_check (true or false) overrides that. A
// local check that runs out of time is "could not tell", never red, and one
// per run. Each run first reads back what happened to the pull requests it
// queued: merged is done, failed hosted checks go back to a builder as a job.
// That hand-back marks the queue entry, and the queue sweep leaves auto-merge
// off for a marked entry until this lander screens the fix and queues it.
// Where the local check stays, a run starts one suite by default, one at a
// time across the machine, and none while the machine is busy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runGit } = require('./git-spawn');
const { proveCheckBeforePublish, proveLanding } = require('./landing-proof');

const DEFAULT_VERIFY = 'npm test';
const DEFAULT_VERIFY_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_LIMIT = 5;
// Local suites one run may start. Policy green_landing_local_suites raises it.
const DEFAULT_LOCAL_SUITES = 1;
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
// Failing test lines from the node test runner (✖, not ok), vitest (FAIL
// file > test, × test) and pytest (FAILED path::test, ERROR path.py). Until
// 2026-11-15 only the node lines were read, so a red web or backend check
// named no test and could never be compared with the base.
const FAILING_LINES = [
  /^(?:✖|not ok)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/,
  /^FAIL\s+(\S.*?)\s*$/,
  /^×\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/,
  /^FAILED\s+(\S+::\S+?)(?:\s+-\s.*)?\s*$/,
  /^ERROR\s+(\S+\.py(?:::\S+?)?)(?:\s+-\s.*)?\s*$/,
];
const ANSI = /\x1b\[[0-9;]*m/g;
// A check that died on the computer, not on the branch: the shell could not
// find a program, npm has no such script, or the system would not start one.
const SETUP_EXIT = new Set([126, 127]);
const SETUP_LINE = /command not found|^env: .+: No such file or directory|Missing script|can't exec|Operation not permitted|spawn \S+ ENOENT/i;
// The line most worth showing when no failing test was named.
const ERROR_WORDS = /error|not found|failed|missing|cannot|can't|denied|not permitted|no such file/i;
const NOISE_LINE = /^npm (?:error|ERR!) (?:A complete log|command|path|workspace|location|Lifecycle|code \d)|^npm (?:error|ERR!)\s*$|^>\s/;

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
    const line = raw.replace(ANSI, '').trim();
    const match = FAILING_LINES.map((re) => line.match(re)).find(Boolean);
    if (!match) continue;
    const name = match[1].trim();
    if (/^failing tests:?$/i.test(name)) continue;
    if (!seen.includes(name)) seen.push(name);
    if (seen.length >= limit) break;
  }
  return seen;
}

// The first line that says what went wrong, or the last line said.
function errorLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(ANSI, '').trim()).filter(Boolean);
  const useful = lines.filter((l) => !NOISE_LINE.test(l));
  const hit = useful.find((l) => SETUP_LINE.test(l)) || useful.find((l) => ERROR_WORDS.test(l)) || useful[useful.length - 1] || '';
  return hit.slice(0, 200);
}

// A failed check that named no failing test and died the way a missing tool
// or setup dies. The branch's code was never reached, so it says nothing
// about the branch.
function setupFailure(verify) {
  if (!verify || verify.status === 0 || verify.timed_out) return false;
  if (verify.status === null || verify.status === undefined) return true;
  if (SETUP_EXIT.has(verify.status)) return true;
  const named = (verify.failing_all || verify.failing || []).length > 0;
  return !named && SETUP_LINE.test(String(verify.error_line || ''));
}

// The test file a failing name points at (vitest file > test, pytest
// path::test), or '' when the name is only a test title.
function failingFile(name) {
  const file = String(name || '').split(/\s+>\s+|::/)[0].trim();
  return /^[\w./@-]+\.[A-Za-z0-9]+$/.test(file) ? file : '';
}

// A failure that is only a test running out of time in files the branch
// never touched. Under load the web MemberChat file did that on 2026-11-15
// and parked a good branch until it or master moved.
function unrelatedTimeout(verify, dir, baseSha) {
  if (!verify || verify.status === 0 || verify.timed_out || !verify.mentions_timeout || !baseSha) return false;
  const files = (verify.failing_all || verify.failing || []).map(failingFile).filter(Boolean);
  if (!files.length) return false;
  const changed = gitOut(['diff', '--name-only', baseSha, 'HEAD'], dir);
  if (!changed.ok) return false;
  const touched = new Set(changed.out.split(/\r?\n/).filter(Boolean));
  return files.every((file) => !touched.has(file));
}

// Cron starts the tick with PATH=/usr/bin:/bin, where npm and gh do not
// live. The folder of the node running this tick holds npm; the usual package
// folders hold gh, and ATRIS_TOOL_DIRS can name others. They go after the
// caller's own PATH, so a PATH that already finds the tools still wins.
function toolEnv(env = process.env) {
  const current = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const named = String(env.ATRIS_TOOL_DIRS || '').split(path.delimiter).filter(Boolean);
  const extra = [...named, path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin']
    .filter((dir, i, all) => all.indexOf(dir) === i && !current.includes(dir) && fs.existsSync(dir));
  return { ...env, PATH: [...current, ...extra].join(path.delimiter) };
}

// root is the main checkout. The scratch copy has none of its untracked
// tools (a venv, .env.local), so ATRIS_LAND_ROOT tells project scripts
// where to find them.
function runVerify(command, cwd, { timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, env = process.env, root = '' } = {}) {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...toolEnv(env), ATRIS_SKIP_UPDATE_CHECK: '1', ...(root ? { ATRIS_LAND_ROOT: root } : {}) },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    command,
    status: result.status,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    duration_ms: Date.now() - started,
    failing: failingLines(output),
    failing_all: failingLines(output, Infinity),
    tail: output.trim().split(/\r?\n/).slice(-12).join('\n'),
    error_line: result.status === 0 ? '' : (errorLine(output) || (result.error && result.error.message) || ''),
    mentions_timeout: result.status !== 0 && /\btimed out\b/i.test(output),
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

// The scratch copy lives in the repo's git folder, not the system temp
// folder: some suites refuse to run from inside the temp folder their tests
// write to (the login write guard does), so every branch read red there.
function scratchParent(root) {
  const common = gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (!common.ok || !common.out) return os.tmpdir();
  const dir = path.join(common.out, 'atris-land-green-scratch');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.tmpdir();
  }
}

function scratchCheckout(root, branch) {
  const dir = fs.mkdtempSync(path.join(scratchParent(root), 'atris-land-green-'));
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

// A reused pull request keeps the jobs, source and catch-up count it was
// queued with; a new one starts with none. The lander only gets here after it
// screened the commit, so a hand-back mark (failed hosted checks, auto-merge
// off) is cleared: the queue sweep may catch this one up again.
function defaultRecordQueued(root, fields) {
  const queue = require('./member-autoland');
  const entry = queue.recordQueuedPullRequest(root, fields, { catchUp: true });
  if (!entry || !('checks_handed_back' in entry || 'checks_task' in entry)) return entry;
  const { checks_handed_back: _mark, checks_task: _task, ...rest } = entry;
  return queue.recordQueuedPullRequest(root, rest, { fresh: true });
}

// Rewrite one entry as given, marks included.
function defaultMarkEntry(root, fields) {
  return require('./member-autoland').recordQueuedPullRequest(root, fields, { fresh: true });
}

// Every pull request on the list the queue sweep watches, keyed by branch.
// Same file member-autoland keeps, beside the main checkout's policy.
function defaultReadEntries(root) {
  const common = gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (!common.ok || !common.out) return {};
  try {
    const data = JSON.parse(fs.readFileSync(path.join(path.dirname(common.out), '.atris', 'state', 'autoland-queue.json'), 'utf8'));
    return data && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries) ? data.entries : {};
  } catch {
    return {};
  }
}

// Does the base branch make GitHub run checks before anything merges? One
// read of the branch rules (rulesets, readable by anyone who can read the
// repo); when they name no check, one read of classic protection, which
// needs admin and is a 404 otherwise. Unreadable means not known, and the
// local check stays.
function readHostedGate(root, base, { runGh = defaultRunGh, env = process.env } = {}) {
  const local = encodeURIComponent(localBaseName(base));
  const rules = runGh(['api', `repos/{owner}/{repo}/rules/branches/${local}`], root, env);
  let rows = null;
  if (rules.ok) { try { rows = JSON.parse(rules.stdout || '[]'); } catch { rows = null; } }
  if (!Array.isArray(rows)) {
    return { known: false, guarded: false, merge_queue: false, checks: [], detail: String(rules.stderr || 'the branch rules could not be read').split('\n')[0].slice(0, 200) };
  }
  const mergeQueue = rows.some((row) => row && row.type === 'merge_queue');
  const checks = rows
    .filter((row) => row && row.type === 'required_status_checks')
    .flatMap((row) => ((row.parameters && row.parameters.required_status_checks) || []).map((c) => c && c.context))
    .filter(Boolean);
  if (!checks.length) {
    const classic = runGh(['api', `repos/{owner}/{repo}/branches/${local}/protection/required_status_checks`], root, env);
    if (classic.ok) {
      try {
        const data = JSON.parse(classic.stdout || '{}');
        checks.push(...(data.contexts || []), ...((data.checks || []).map((c) => c && c.context)));
      } catch {}
    }
  }
  const named = [...new Set(checks.filter((c) => typeof c === 'string' && c))];
  return { known: true, guarded: named.length > 0, merge_queue: mergeQueue, checks: named };
}

// Policy green_landing_local_check: true always checks locally, false never
// does on the pull request path, anything else follows the base's rules. Off
// the pull request path the local check is the only gate, so it always runs.
function localCheckMode(value) {
  if (value === true || value === 'on' || value === 'always') return 'on';
  if (value === false || value === 'off' || value === 'never') return 'off';
  return 'auto';
}

function decideLocalCheck(value, { prFlow, gate }) {
  const mode = localCheckMode(value);
  const facts = { mode, checks: gate ? gate.checks : [], merge_queue: Boolean(gate && gate.merge_queue) };
  if (!prFlow) return { ...facts, local: true, why: 'no pull request path, so the local check is the gate' };
  if (mode === 'on') return { ...facts, local: true, why: 'policy asks for the local check' };
  if (mode === 'off') return { ...facts, local: false, why: 'policy turns the local check off' };
  if (gate && gate.guarded) return { ...facts, local: false, why: `the base requires hosted checks (${gate.checks.join(', ')})` };
  return { ...facts, local: true, why: gate && gate.known ? 'the base requires no hosted checks' : `the base's rules could not be read${gate && gate.detail ? ` (${gate.detail})` : ''}` };
}

// The owner's switch, read the same way by the hourly run and by "atris land
// --auto". An explicit verify command asks for that check to run here, so it
// turns the local check on whatever the base's rules say.
function localCheckSetting(policy, { explicitVerify = false } = {}) {
  if (explicitVerify) return true;
  const value = policy && typeof policy === 'object' ? policy.green_landing_local_check : undefined;
  return value === undefined || value === null ? 'auto' : value;
}

function defaultReadQueued(root, branch) {
  return require('./member-autoland').queuedPullRequest(root, branch);
}

function isAncestor(root, older, newer) {
  return runGit(['merge-base', '--is-ancestor', older, newer], { cwd: root, check: false }).status === 0;
}

// Where the catch-up starts. Once the lander pushed a catch-up, origin's copy
// of the branch holds the local head plus master; building on it keeps every
// later push a fast-forward. A copy on origin that holds neither side's work
// is someone else's push and holds.
function branchStart(root, branch) {
  const fetched = runGit(['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: root, check: false });
  const remote = gitOut(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], root);
  const head = gitOut(['rev-parse', branch], root);
  if (fetched.status !== 0 || !remote.ok || !head.ok) return { ok: true, start: branch };
  if (remote.out === head.out || isAncestor(root, remote.out, head.out)) return { ok: true, start: branch };
  if (isAncestor(root, head.out, remote.out)) return { ok: true, start: remote.out };
  return { ok: false, detail: `origin's ${branch} has commits the local branch lacks, and the local branch has commits origin lacks` };
}

// The repo's own merge path: push the caught-up branch, open or reuse its
// pull request, and put it in the merge queue pinned to the checked commit.
// GitHub runs the hosted checks and merges; the tick's queue sweep watches it.
function queueThroughPullRequest(root, { branch, local, sha, verify, hostedChecks = null, runGh, recordQueued, env }) {
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
    const body = Array.isArray(hostedChecks)
      ? `Caught up with ${local} by the green lander. No local run: the hosted checks${hostedChecks.length ? ` (${hostedChecks.join(', ')})` : ''} and the merge queue decide.`
      : `Caught up with ${local} and checked with \`${verify}\` by the green lander. The merge queue runs the hosted checks.`;
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

// The machine guard for local suites. On 2026-11-15 the hourly runs of five
// projects on one machine each started whole suites at once; the load went
// from about 150 to 573 and every suite ran out of time. So a local suite
// starts only when the one-minute load is at most twice the cores, and only
// one at a time across the machine: a lock under the user's .atris folder
// that every project's run takes. A lock older than the suite time limit is
// abandoned and taken over. A run that cannot start a suite says machine
// busy and moves on; that is never red and never a flag.
const MACHINE_BUSY = Object.freeze({ machine_busy: true });

function suiteLockPath(env = process.env) {
  return path.join(require('./state-home').atrisHome(env), 'locks', 'land-green-local-suite.lock');
}

function makeMachineGuard(root, { lockFile, loadAvg = os.loadavg, cpuCount = () => os.cpus().length, limitMs = DEFAULT_VERIFY_TIMEOUT_MS } = {}) {
  const file = lockFile || suiteLockPath();
  const { acquireFileLock } = require('./file-lock');
  const loadBusy = () => {
    let one = NaN;
    let cores = 1;
    try { one = Number((loadAvg() || [])[0]); } catch {}
    try { cores = Math.max(1, Number(cpuCount()) || 1); } catch {}
    return Number.isFinite(one) && one > 2 * cores ? `the machine is busy (load ${one.toFixed(1)} on ${cores} cores); no local check started` : '';
  };
  const holderLine = (holder) => `another local check holds the machine${holder && holder.repo ? ` (${path.basename(String(holder.repo))})` : ''}; no local check started`;
  return {
    // A cheap look before any scratch copy is made.
    peek() {
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { holder = null; }
      const at = Date.parse((holder && holder.at) || '');
      if (Number.isFinite(at) && Date.now() - at <= limitMs) return holderLine(holder);
      return loadBusy();
    },
    // Taken right before the suite and released right after it. Age is the
    // only way a lock goes stale: a killed run can leave its suite running.
    acquire() {
      const load = loadBusy();
      if (load) return { ok: false, detail: load };
      let lock;
      try {
        lock = acquireFileLock(file, { staleAfterMs: limitMs, isAlive: () => true, meta: { repo: root, limit_ms: limitMs } });
      } catch (err) {
        return { ok: false, detail: `the machine lock could not be taken (${String((err && err.code) || (err && err.message) || err)})` };
      }
      if (!lock.ok) return { ok: false, detail: holderLine(lock.holder) };
      return { ok: true, release: () => { try { lock.release(); } catch {} } };
    },
  };
}

// Run one local suite under the machine lock, or say why it did not start.
function guardedVerify(guard, runVerifyFn, command, cwd, opts) {
  const lock = guard ? guard.acquire() : null;
  if (lock && !lock.ok) return { busy: true, detail: lock.detail };
  try {
    return runVerifyFn(command, cwd, opts);
  } finally {
    if (lock) lock.release();
  }
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
  readQueued = defaultReadQueued,
  knownRed = null,
  // false: the hosted checks are the gate, so no install and no local suite.
  localCheck = true,
  hostedChecks = [],
  // Branches whose pull request fails its hosted checks right now, read by
  // this run's follow-up.
  checksFailing = null,
  // Branch to the commit this run's follow-up read every hosted check
  // passing on. A handed-back entry is queued again only on that commit.
  checksPassing = null,
  // Shared across one run: set once a local check ran out of time.
  busy = null,
  env = process.env,
} = {}) {
  const dirty = dirtyCheckouts(root, branch);
  if (dirty.length) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'checkout_dirty', detail: dirty.join(', ') });
  }
  // On the pull request path the catch-up starts from origin's copy when it
  // is ahead (the lander's own catch-up, or a builder's fix after a hand-
  // back). The screens below read that same start, so commits that sit only
  // on origin's copy are screened too.
  let start = branch;
  if (prFlow) {
    const from = branchStart(root, branch);
    if (!from.ok) return verdictFor(branch, base, { action: 'skipped', reason: 'branch_diverged', detail: from.detail });
    start = from.start;
  }
  // Protected work waits for its owner whatever else is true of it.
  const lane = protectedSurfaces(root, base, start);
  if (lane.protected) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'protected_surface', detail: lane.surfaces.join(', ') });
  }
  const conflicts = mergeConflicts(root, base, start);
  if (!conflicts.ok) return verdictFor(branch, base, { action: 'error', reason: 'merge_check_failed', detail: conflicts.error });
  const clashing = conflicts.conflicts;
  const realClash = clashing.filter((file) => !REGENERABLE.test(file));
  if (realClash.length) {
    return verdictFor(branch, base, { action: 'skipped', reason: 'merge_conflict', detail: realClash.slice(0, 6).join(', '), files: realClash });
  }
  const target = resolveMergeTarget(root, base, { fetch, prFlow });
  if (!target.ok) return verdictFor(branch, base, { action: 'skipped', reason: target.reason, detail: target.detail });
  const plan = prFlow ? 'queue_pull_request' : 'merge_to_base';
  if (prFlow) {
    // Already in the merge queue with this work in it: the queue sweep
    // watches it and catches it up if GitHub drops it. Checking it again
    // here on every master move would spend a slot for nothing. A push on
    // top of the queued commit is new work and goes through again.
    //
    // A handed-back entry is not in the queue: auto-merge is off and the
    // sweep leaves it off until this lander screens it. It is screened and
    // queued again only when this run read every hosted check passing on the
    // very commit that would be queued. Failing, still running or unreadable
    // all hold it: the mark stays and auto-merge stays off.
    let queued = null;
    try { queued = readQueued(root, branch); } catch { queued = null; }
    const head = gitOut(['rev-parse', start], root);
    const pushedOk = queued && /^[0-9a-f]{40,64}$/.test(String(queued.pushed || ''));
    if (pushedOk && queued.checks_handed_back) {
      const passing = checksPassing && head.ok ? checksPassing.get(branch) : '';
      if (!passing || passing !== head.out) {
        const job = `with a builder as job ${queued.checks_task || 'on the list'}`;
        const failing = checksFailing && checksFailing.has(branch) && head.ok && head.out === queued.pushed;
        return verdictFor(branch, base, {
          action: 'skipped', reason: 'handed_back', pr: queued.number,
          detail: failing
            ? `pull request #${queued.number} still fails its hosted checks; ${job}`
            : `pull request #${queued.number} waits until its hosted checks are read passing on this commit; ${job}`,
        });
      }
    } else if (pushedOk && head.ok && isAncestor(root, head.out, queued.pushed)) {
      return verdictFor(branch, base, { action: 'skipped', reason: 'in_merge_queue', detail: `pull request #${queued.number}; the queue sweep watches it`, pr: queued.number });
    }
  }
  const checkedBy = localCheck ? 'local' : 'hosted';
  if (dryRun) {
    return verdictFor(branch, base, {
      action: 'skipped', reason: 'dry_run', target: target.target, plan,
      would: prFlow ? 'queue' : 'merge', local_check: checkedBy,
      regenerate: clashing.length ? clashing : undefined,
    });
  }
  // One local check already ran out of time this run: the machine is too
  // busy to tell, so the rest wait for the next run instead of burning it.
  if (localCheck && busy && busy.timedOut) {
    return verdictFor(branch, base, {
      action: 'unknown', reason: 'machine_busy', local_check: checkedBy,
      detail: 'a local check already ran out of time this run; tries again next run',
    });
  }
  if (localCheck && busy) {
    const max = Number(busy.max) > 0 ? Number(busy.max) : DEFAULT_LOCAL_SUITES;
    if ((Number(busy.started) || 0) >= max) {
      return verdictFor(branch, base, {
        action: 'skipped', reason: 'local_check_limit', local_check: checkedBy,
        detail: `${max} local ${max === 1 ? 'check' : 'checks'} per run; tries again next run`,
      });
    }
    const why = busy.guard ? busy.guard.peek() : '';
    if (why) return verdictFor(branch, base, { action: 'unknown', reason: 'machine_busy', local_check: checkedBy, detail: `${why}; tries again next run` });
  }

  const scratch = scratchCheckout(root, start);
  if (!scratch.ok) return verdictFor(branch, base, { action: 'error', reason: 'scratch_checkout_failed', detail: scratch.error, tried: true });
  try {
    const out = (extra) => verdictFor(branch, base, { tried: true, local_check: checkedBy, ...extra });
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
    if (!localCheck) {
      // The hosted checks are the gate. Publish only the merged commit with
      // nothing left over in the tree, and let the queue decide.
      const leftover = gitOut(['status', '--porcelain'], scratch.dir);
      if (!leftover.ok || leftover.out) {
        return out({ action: 'skipped', reason: 'merged_tree_dirty', detail: (leftover.out || leftover.err).split('\n').slice(0, 4).join(', '), ...notes });
      }
      const merged = gitOut(['rev-parse', 'HEAD'], scratch.dir);
      if (!merged.ok) return out({ action: 'error', reason: 'merged_sha_unreadable', ...notes });
      if (!push) return out({ action: 'skipped', reason: 'push_disabled', detail: 'caught up; would queue it for the hosted checks', sha: merged.out, plan, ...notes });
      const queued = queueThroughPullRequest(root, {
        branch, local: localBaseName(base), sha: merged.out, verify: null, hostedChecks, runGh, recordQueued, env,
      });
      return out({ ...queued, sha: merged.out, ...notes });
    }
    const deps = installDeps(scratch.dir, env);
    if (!deps.ok) return out({ action: 'error', reason: 'install_failed', detail: deps.detail, ...notes });
    const verifyOpts = { timeoutMs: verifyTimeoutMs, env, root };
    let verify = guardedVerify(busy && busy.guard, runVerifyFn, verifyCommand, scratch.dir, verifyOpts);
    if (verify && verify.busy) {
      return out({ action: 'unknown', reason: 'machine_busy', detail: `${verify.detail}; tries again next run`, ...notes });
    }
    if (busy) busy.started = (Number(busy.started) || 0) + 1;
    // Only a timeout in files the branch never touched: one more run
    // decides. Green goes on, red again is red.
    if (unrelatedTimeout(verify, scratch.dir, before.ok ? before.out : '')) {
      const again = guardedVerify(busy && busy.guard, runVerifyFn, verifyCommand, scratch.dir, verifyOpts);
      if (again && again.busy) {
        return out({ action: 'unknown', reason: 'machine_busy', verify, ...notes, detail: `a test outside this branch ran out of time and the second run could not start (${again.detail}); tries again next run` });
      }
      verify = { ...again, rerun_of: { status: verify.status, failing: verify.failing } };
    }
    // Out of time says nothing about the branch, only about the machine.
    // Never red and never a flag: could not tell, and tried again later.
    if (verify.timed_out) {
      if (busy) busy.timedOut = true;
      return out({
        action: 'unknown', reason: 'verify_timed_out', verify, ...notes,
        detail: `the local check ran out of time after ${Math.round((verify.duration_ms || 0) / 60000)} minutes; could not tell, tries again next run`,
      });
    }
    // The check never reached the branch's code (a missing tool, a missing
    // script). Could not tell, and nothing is kept against the branch.
    if (setupFailure(verify)) {
      return out({
        action: 'unknown', reason: 'verify_setup_failed', verify, ...notes,
        detail: `the local check could not run here (exit ${verify.status === null || verify.status === undefined ? 'none' : verify.status}): ${verify.error_line || 'it printed nothing'}. this looks like a missing tool or setup problem on this computer, not the branch; tries again next run`,
      });
    }
    // Behind a merge queue the hosted checks decide. A test that fails here
    // on master too (a sandbox test this computer cannot run) is not the
    // branch's fault, so only a failure master does not have holds it.
    if (verify.status !== 0 && prFlow && !verify.timed_out && typeof knownRed === 'function' && before.ok) {
      const names = verify.failing_all || verify.failing || [];
      const onBase = names.length ? knownRed(before.out) : null;
      // The branch failed, and the base's own check could not start to
      // compare: could not tell, never red.
      if (onBase === MACHINE_BUSY) {
        return out({
          action: 'unknown', reason: 'machine_busy', verify, ...notes,
          detail: `the check failed here and ${localBaseName(base)}'s own check could not start to compare (the machine is busy); tries again next run`,
        });
      }
      if (Array.isArray(onBase)) {
        const fresh = names.filter((name) => !onBase.includes(name));
        if (fresh.length) verify = { ...verify, failing: fresh.slice(0, 8), failing_all: fresh, known_red: names.filter((name) => onBase.includes(name)) };
        else notes.known_red = names;
      }
    }
    if (verify.status !== 0 && !notes.known_red) {
      const named = (verify.failing || []).length > 0;
      return out({
        action: 'red',
        reason: 'verify_failed',
        verify,
        owner: branchAuthor(root, branch),
        ...notes,
        ...(named ? {} : { detail: `the local check exited with code ${verify.status} and named no failing test: ${verify.error_line || 'it printed nothing'}` }),
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
  const v = verdict.verify || {};
  const failed = v.error_line ? `the verify command failed (exit ${v.status}): ${v.error_line}` : 'the verify command failed';
  const head = names.length ? names.slice(0, 3).join('; ') : (verdict.reason === 'verify_timed_out' ? 'the verify timed out' : failed);
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

function readStateFile(file) {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function readState(file) {
  const data = readStateFile(file);
  return data.branches && typeof data.branches === 'object' ? data.branches : {};
}

// The last base commit checked on its own, so a run where master did not
// move does not check it again.
function readBaseline(file) {
  const data = readStateFile(file).baseline;
  return data && typeof data === 'object' && Array.isArray(data.failing) ? data : null;
}

function writeState(file, branches, baseline = null) {
  if (!file) return;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    const data = { schema: 'atris.land_green.v1', branches };
    if (baseline) data.baseline = baseline;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {}
}

// The failing check names on one base commit, or null when that cannot be
// told: a green base, a timeout, or no names to compare.
// MACHINE_BUSY when the machine guard would not let the check start.
function baseFailures(root, baseSha, { verifyCommand, verifyTimeoutMs, runVerifyFn, env, guard = null }) {
  if (guard && guard.peek()) return MACHINE_BUSY;
  const scratch = scratchCheckout(root, baseSha);
  if (!scratch.ok) return null;
  try {
    const deps = installDeps(scratch.dir, env);
    if (!deps.ok) return null;
    const verify = guardedVerify(guard, runVerifyFn, verifyCommand, scratch.dir, { timeoutMs: verifyTimeoutMs, env, root });
    if (verify && verify.busy) return MACHINE_BUSY;
    if (verify.status === 0) return [];
    const names = verify.failing_all || verify.failing || [];
    return verify.timed_out || !names.length ? null : names;
  } catch {
    return null;
  } finally {
    dropScratch(root, scratch.dir);
  }
}

// A try that ran out of time told nothing. The 11:18Z run on 2026-11-15
// recorded four of those as red; they count as never tried.
function untold(entry) {
  return Boolean(entry) && entry.action !== 'unknown' && entry.reason === 'verify_timed_out';
}

// Could-not-tell tries are kept as a count only, against the branch's own
// commit and check but not the base, which moves many times an hour. A
// branch with any goes last next run, so it cannot hold the line, and after
// UNTOLD_TRIES on the same commit a builder gets a job. Never red, no flag.
const UNTOLD_TRIES = 3;

function untoldCount(entry, key) {
  if (!entry || entry.action !== 'unknown' || !key.head) return 0;
  return entry.head === key.head && entry.verify === key.verify ? (Number(entry.untold) || 0) : 0;
}

// A builder gets the branch whose local check runs out of time every try.
// One job per branch head.
function defaultSlowCheckTask(root, { branch, base, head, verify, tries, member }) {
  const taskDb = require('./task-db');
  const { workspaceRoot } = require('./workspace-root');
  const db = taskDb.open();
  const metadata = {
    source: FOLLOW_SOURCE,
    branch,
    slow_check: verify,
    objective: `The local check (${verify}) on ${branch}, caught up with ${base}, ran out of time on ${tries} tries in a row on commit ${String(head).slice(0, 12)}. Find what hangs or runs slow, fix it, and push the branch. The green lander tries it again on its next run.`,
  };
  if (member) metadata.assigned_to = member;
  const added = taskDb.addTask(db, {
    title: `speed up ${branch}: its local check runs out of time on every try`,
    tag: 'code',
    workspaceRoot: workspaceRoot(root),
    sourceKey: `land-green:slow:${branch}:${String(head).slice(0, 12)}`,
    metadata,
  });
  return { id: added.id, inserted: added.inserted };
}

// A failed hosted check gets one rerun from the merge-line sweep first
// (member-autoland marks it as reran). When that sweep has not run for this
// long, the failure is taken as it stands.
const RERUN_WAIT_MS = 3 * 60 * 60 * 1000;
const FOLLOW_SOURCE = 'land-green';

function failingCheckNames(rows) {
  const names = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.bucket !== 'fail') continue;
    const name = String(row.name || row.workflow || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function pendingChecks(rows) {
  return (Array.isArray(rows) ? rows : []).some((row) => row && row.bucket === 'pending');
}

// Every hosted check finished and passed. An empty list is not a pass.
function checksPass(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  return list.some((row) => row.bucket === 'pass') && list.every((row) => row.bucket === 'pass' || row.bucket === 'skipping');
}

// A pull request's hosted checks failed: a builder gets a job naming them.
// One job per pushed commit; a later run on the same commit finds it again.
function defaultFailedChecksTask(root, { branch, base, number, pushed, checks, member }) {
  const taskDb = require('./task-db');
  const { workspaceRoot } = require('./workspace-root');
  const db = taskDb.open();
  const shown = checks.slice(0, 4).join(', ') + (checks.length > 4 ? ` and ${checks.length - 4} more` : '');
  const metadata = {
    source: FOLLOW_SOURCE,
    branch,
    pull_request: number,
    failing_checks: checks,
    objective: `Pull request #${number} (${branch} into ${base}) fails its hosted checks: ${shown}. Fetch origin's copy of ${branch}, make those checks pass, and push it. The green lander queues it again on its next run.`,
  };
  if (member) metadata.assigned_to = member;
  const added = taskDb.addTask(db, {
    title: `fix ${branch}: its hosted checks fail on pull request #${number} (${shown})`,
    tag: 'code',
    workspaceRoot: workspaceRoot(root),
    sourceKey: `land-green:checks:${branch}:${String(pushed).slice(0, 12)}`,
    metadata,
  });
  return { id: added.id, inserted: added.inserted };
}

// Read back what happened to each pull request the lander queued. Merged is
// done: its memory is cleared, and the merge-line sweep closes the list
// entry. Failed hosted checks, after their one rerun, go back to a builder as
// a job naming the checks. Nothing here opens a flag or marks a branch red.
// dryRun reads GitHub and says what it would do.
function followQueuedLandings(root, {
  runGh = defaultRunGh,
  readEntries = defaultReadEntries,
  markEntry = defaultMarkEntry,
  fileChecksTask = null,
  memory = {},
  dryRun = false,
  now = Date.now(),
  env = process.env,
} = {}) {
  const fileTask = fileChecksTask || ((r, job) => defaultFailedChecksTask(r, { member: handBackMember(r), ...job }));
  let entries = {};
  try { entries = readEntries(root) || {}; } catch { entries = {}; }
  const results = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || entry.source !== FOLLOW_SOURCE || entry.branch !== key) continue;
    if (!Number.isInteger(entry.number) || entry.number <= 0 || !/^[0-9a-f]{40,64}$/.test(String(entry.pushed || ''))) continue;
    const row = (state, line, extra = {}) => ({ branch: key, number: entry.number, state, line: `pull request #${entry.number} (${key}): ${line}`, ...extra });
    const viewed = runGh(['pr', 'view', String(entry.number), '--json', 'state,headRefOid,mergedAt'], root, env);
    let pr = null;
    if (viewed.ok) { try { pr = JSON.parse(viewed.stdout); } catch { pr = null; } }
    if (!pr || typeof pr !== 'object') { results.push(row('unreadable', 'github could not be read; will look again')); continue; }
    if (pr.state === 'MERGED') {
      delete memory[key];
      results.push(row('merged', 'merged; done'));
      continue;
    }
    if (pr.state !== 'OPEN') { results.push(row('closed', 'closed without merging; left alone')); continue; }
    const readChecks = () => {
      const checks = runGh(['pr', 'checks', String(entry.number), '--json', 'name,bucket'], root, env);
      try { const rows = JSON.parse(checks.stdout || 'null'); return Array.isArray(rows) ? rows : null; } catch { return null; }
    };
    if (pr.headRefOid !== entry.pushed) {
      if (!entry.checks_handed_back) { results.push(row('changed', 'someone pushed to it after it was queued; their push decides')); continue; }
      // The builder's fix is queued again only once its own checks pass.
      const rows = /^[0-9a-f]{40,64}$/.test(String(pr.headRefOid || '')) ? readChecks() : null;
      if (rows && checksPass(rows)) {
        results.push(row('changed', 'the builder pushed after the hand-back and its hosted checks pass; the lander screens it and queues it again', { passing_head: pr.headRefOid }));
      } else {
        results.push(row('changed', rows
          ? 'the builder pushed after the hand-back; the lander queues it again once its hosted checks pass'
          : 'the builder pushed after the hand-back; its checks could not be read, so the lander waits'));
      }
      continue;
    }
    const rows = readChecks();
    if (!Array.isArray(rows)) { results.push(row('unreadable', 'its checks could not be read; will look again')); continue; }
    const failing = failingCheckNames(rows);
    if (!failing.length && entry.checks_handed_back) {
      if (checksPass(rows)) {
        results.push(row('handed_back_clear', 'handed back earlier; its hosted checks pass now; the lander screens it and queues it again', { passing_head: entry.pushed }));
      } else {
        results.push(row('handed_back_waiting', 'handed back earlier; its hosted checks are running again; held until they pass'));
      }
      continue;
    }
    if (!failing.length) { results.push(row('queued', pendingChecks(rows) ? 'hosted checks still running' : 'waiting in the merge queue')); continue; }
    if (entry.checks_handed_back === entry.pushed) {
      results.push(row('handed_back_earlier', `its hosted checks fail; already with a builder as job ${entry.checks_task || 'on the list'}`, { checks: failing }));
      continue;
    }
    const queuedMs = Date.parse(entry.queued_at || '');
    const retried = entry.reran === entry.pushed || (Number.isFinite(queuedMs) && now - queuedMs > RERUN_WAIT_MS);
    if (!retried || pendingChecks(rows)) {
      results.push(row('waiting_for_retry', `hosted checks fail (${failing.join(', ')}); waits for their one rerun`, { checks: failing }));
      continue;
    }
    if (dryRun) {
      results.push(row('would_hand_back', `hosted checks fail (${failing.join(', ')}); would go back to a builder as a job`, { checks: failing }));
      continue;
    }
    // Auto-merge goes off first, so the builder's fix cannot merge on its own
    // before the lander screens it and queues it again.
    const autoOff = runGh(['pr', 'merge', String(entry.number), '--disable-auto'], root, env);
    let task = null;
    try {
      task = fileTask(root, { branch: key, base: entry.base, number: entry.number, pushed: entry.pushed, checks: failing });
    } catch (err) {
      results.push(row('hand_back_failed', `hosted checks fail; the job could not be filed (${String((err && err.message) || err).slice(0, 120)})`, { checks: failing }));
      continue;
    }
    try { markEntry(root, { ...entry, checks_handed_back: entry.pushed, checks_task: task && task.id }); } catch {}
    results.push(row('handed_back', `hosted checks fail (${failing.join(', ')}); went back to a builder as job ${task && task.id}`, {
      checks: failing, hand_back: { task_id: task && task.id, new: Boolean(task && task.inserted), auto_merge_off: Boolean(autoOff && autoOff.ok) },
    }));
  }
  return { checked: results.length, results };
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
  readQueued = defaultReadQueued,
  fileConflictTask = defaultFileConflictTask,
  // Policy green_landing_local_check: true, false, or auto (the base's rules).
  localCheck = 'auto',
  readEntries = defaultReadEntries,
  markEntry = defaultMarkEntry,
  fileChecksTask = null,
  fileSlowCheckTask = defaultSlowCheckTask,
  // Local suites this run may start (policy green_landing_local_suites).
  localSuites = DEFAULT_LOCAL_SUITES,
  // The machine guard. The hourly run and "atris land --auto" pass true; an
  // object turns it on with its own lockFile, loadAvg or cpuCount. Off when
  // unset, so a caller that only checks this module's logic starts no lock.
  machine = false,
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
  // What happened to the pull requests queued on earlier runs.
  const followed = prFlow
    ? followQueuedLandings(root, { runGh, readEntries, markEntry, fileChecksTask, memory, dryRun: dryRun || !handBack, now, env }).results
    : [];
  const checksFailing = new Set(followed.filter((r) => Array.isArray(r.checks) && r.checks.length).map((r) => r.branch));
  const checksPassing = new Map(followed.filter((r) => r.passing_head).map((r) => [r.branch, r.passing_head]));
  // The gate is read once per run, and only when there is work to gate.
  const mode = localCheckMode(localCheck);
  const gate = prFlow && mode === 'auto' && candidates.length ? readHostedGate(root, live.base, { runGh, env }) : null;
  const checkPlan = decideLocalCheck(localCheck, { prFlow, gate });
  const guardOn = Boolean(machine);
  const busy = {
    timedOut: false,
    started: 0,
    max: Number(localSuites) > 0 ? Math.floor(Number(localSuites)) : DEFAULT_LOCAL_SUITES,
    guard: guardOn ? makeMachineGuard(root, { limitMs: verifyTimeoutMs, ...(machine && typeof machine === 'object' ? machine : {}) }) : null,
  };
  // Any local run that times out, the base's own check included, marks the
  // machine busy for the rest of this run.
  const runVerifyTimed = (...args) => {
    const result = runVerifyFn(...args);
    if (result && result.timed_out) busy.timedOut = true;
    return result;
  };
  let baseline = readBaseline(file);
  const knownRed = (baseSha) => {
    if (baseline && baseline.sha === baseSha && baseline.verify === verifyCommand) return baseline.failing;
    if (busy.timedOut) return null;
    const failing = baseFailures(root, baseSha, { verifyCommand, verifyTimeoutMs, runVerifyFn: runVerifyTimed, env, guard: busy.guard });
    if (failing === MACHINE_BUSY) return MACHINE_BUSY;
    if (!Array.isArray(failing)) return null;
    baseline = { sha: baseSha, verify: verifyCommand, failing, at: new Date(now).toISOString() };
    return failing;
  };
  const local = localBaseName(live.base);
  const member = handBackMember(root);
  const verdicts = [];
  // A branch that failed or errored on an earlier try of its current commit
  // goes after the ones not yet tried, so with one local suite a run an old failing branch that
  // is tried again on every master move cannot keep the healthy ones behind
  // it from ever being checked. Branches whose last tries could not tell go
  // after every other branch, fewest such tries first.
  const baseNow = gitOut(['rev-parse', live.base], root);
  const keyOf = (name) => {
    const head = gitOut(['rev-parse', name], root);
    return { head: head.ok ? head.out : '', base: baseNow.ok ? baseNow.out : '', verify: verifyCommand };
  };
  // A branch that moved since its remembered try counts as never tried.
  const triedBefore = (entry, key) => Boolean(entry) && entry.action !== 'unknown' && !untold(entry) && Boolean(key.head) && entry.head === key.head;
  const order = candidates.map((c, i) => {
    const key = keyOf(c.name);
    const untoldTries = untoldCount(memory[c.name], key);
    const tier = untoldTries > 0 ? 2 : (triedBefore(memory[c.name], key) ? 1 : 0);
    return { c, i, tier, untold: untoldTries };
  });
  order.sort((a, b) => a.tier - b.tier || (a.tier === 2 ? a.untold - b.untold : 0) || a.i - b.i);
  candidates.splice(0, candidates.length, ...order.map((o) => o.c));
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
    const key = keyOf(candidate.name);
    const prior = memory[candidate.name];
    const untoldBefore = untoldCount(prior, key);
    // Its local check ran out of time on every try on this commit and a
    // builder has it: no more 20 minute tries until the branch moves.
    if (!dryRun && untoldBefore >= UNTOLD_TRIES && prior.slow_handed_back === key.head) {
      verdicts.push(verdictFor(candidate.name, live.base, {
        action: 'skipped', reason: 'waiting_for_change',
        detail: `the local check ran out of time on ${untoldBefore} tries on this commit; with a builder as job ${prior.slow_task || 'on the list'}`,
      }));
      continue;
    }
    // No permanent give-up: the same two commits wait, but a new commit on
    // the branch or on the base starts the count over.
    if (!dryRun && key.head && !untold(prior) && sameTry(prior, key) && (Number(prior.misses) || 0) >= triesAllowed(prior)) {
      verdicts.push(verdictFor(candidate.name, live.base, {
        action: 'skipped', reason: 'waiting_for_change',
        detail: `${String(prior.reason || prior.action).replace(/_/g, ' ')} on these commits; tries again once the branch or ${local} moves`,
      }));
      continue;
    }
    let verdict;
    try {
      verdict = landOneBranch(root, live.base, candidate.name, {
        verifyCommand, verifyTimeoutMs, dryRun, push, prFlow, fetch: false, runVerifyFn: runVerifyTimed, runGh, recordQueued, readQueued, knownRed,
        localCheck: checkPlan.local, hostedChecks: checkPlan.checks, checksFailing, checksPassing, busy, env,
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
      } else if (verdict.action === 'unknown' && verdict.reason === 'verify_timed_out' && key.head) {
        // Could not tell: only the count is kept. Never red, never a flag.
        const count = untoldBefore + 1;
        const entry = { ...key, action: 'unknown', reason: verdict.reason, untold: count, at: new Date(now).toISOString() };
        if (count >= UNTOLD_TRIES) {
          if (!handBack) {
            verdict.hand_back = { would: true, member: member || null };
          } else {
            try {
              const task = fileSlowCheckTask(root, { branch: candidate.name, base: local, head: key.head, verify: verifyCommand, tries: count, member });
              verdict.hand_back = { task_id: task.id, new: Boolean(task.inserted), member: member || null };
              entry.slow_handed_back = key.head;
              entry.slow_task = task.id;
            } catch (err) {
              verdict.hand_back = { error: String((err && err.message) || err).slice(0, 200) };
            }
          }
        }
        memory[candidate.name] = entry;
      } else if (verdict.action === 'unknown') {
        // Not tried this run (the machine was busy): what was known stays,
        // and an old red from a timed-out try counts as never tried.
        if (untold(prior)) delete memory[candidate.name];
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
    writeState(file, memory, baseline);
  }
  return {
    at: new Date(now).toISOString(),
    base: live.base,
    merge_path: prFlow ? 'pull_request' : (hasRemote ? 'push' : 'local'),
    local_check: checkPlan,
    local_suites: { started: busy.started, max: busy.max },
    followed,
    candidates: candidates.map((b) => b.name),
    landed: verdicts.filter((v) => v.action === 'landed').map((v) => v.branch),
    queued: verdicts.filter((v) => v.action === 'queued').map((v) => v.branch),
    red: verdicts.filter((v) => v.action === 'red').map((v) => v.branch),
    handed_back: verdicts.filter((v) => v.hand_back && v.hand_back.task_id).map((v) => v.branch),
    could_not_tell: verdicts.filter((v) => v.action === 'unknown').map((v) => v.branch),
    verdicts,
  };
}

// What came back from the pull requests queued on earlier runs.
function followLine(followed) {
  const rows = Array.isArray(followed) ? followed : [];
  const merged = rows.filter((r) => r.state === 'merged').map((r) => r.branch);
  const back = rows.filter((r) => r.state === 'handed_back');
  const parts = [];
  if (merged.length) parts.push(`merged: ${merged.join(', ')}`);
  for (const r of back) parts.push(`${r.branch} fails its hosted checks (${r.checks.join(', ')}); handed back as job ${r.hand_back.task_id}`);
  return parts.join('; ');
}

function summaryLine(result) {
  const follow = followLine(result && result.followed);
  if (!result || !result.candidates || result.candidates.length === 0) return follow ? `no stale branches to land; ${follow}` : 'no stale branches to land';
  const parts = [];
  if (follow) parts.push(follow);
  if (result.landed.length) parts.push(`landed ${result.landed.join(', ')}`);
  const queued = result.verdicts.filter((v) => v.action === 'queued');
  if (queued.length) parts.push(`in the merge queue: ${queued.map((v) => `${v.branch} (${v.url || `#${v.pr}`})`).join(', ')}`);
  if (result.red.length) parts.push(`red: ${result.red.join(', ')}`);
  const untoldRows = result.verdicts.filter((v) => v.action === 'unknown');
  const untoldWhy = { machine_busy: 'the machine is busy', verify_setup_failed: 'the local check could not run on this computer' };
  if (untoldRows.length) parts.push(`could not tell ${untoldRows.map((v) => v.branch).join(', ')} (${untoldWhy[untoldRows[0].reason] || 'the local check ran out of time'}); tries again next run`);
  for (const v of result.verdicts) {
    if (v.hand_back && v.hand_back.task_id) {
      parts.push(v.reason === 'verify_timed_out'
        ? `${v.branch} ran out of time on every local try; handed back as job ${v.hand_back.task_id}`
        : `${v.branch} clashes in ${v.detail}; handed back as job ${v.hand_back.task_id}`);
      continue;
    }
    if (v.reason === 'dry_run') {
      const how = v.would === 'queue' ? (v.local_check === 'hosted' ? 'would queue for the hosted checks' : 'would check here, then queue') : 'would check here, then merge';
      parts.push(`${v.branch} ${how}`);
      continue;
    }
    if (v.action === 'skipped' && v.reason !== 'per_tick_limit' && v.reason !== 'local_check_limit') parts.push(`${v.branch} held (${v.reason.replace(/_/g, ' ')}${v.detail ? `: ${v.detail}` : ''})`);
    if (v.action === 'error') parts.push(`${v.branch} error (${v.reason.replace(/_/g, ' ')})`);
    if (v.action === 'pushed') parts.push(`${v.branch} pushed, landing check: ${String(v.landing_check).replace(/_/g, ' ')} (${v.reason.replace(/_/g, ' ')})`);
    if (['no_op', 'not_landed', 'unverified'].includes(v.action)) parts.push(`${v.branch} not landed (${v.reason.replace(/_/g, ' ')})`);
  }
  const waiting = result.verdicts.filter((v) => v.reason === 'per_tick_limit' || v.reason === 'local_check_limit').length;
  if (waiting) parts.push(`${waiting} more waiting for the next tick`);
  return parts.join('; ') || 'nothing landed';
}

module.exports = {
  DEFAULT_VERIFY,
  DEFAULT_LIMIT,
  landStaleGreenBranches,
  followQueuedLandings,
  localCheckSetting,
  // The member merge-line sweep hands its clashes back the same way.
  fileConflictTask: (root, job) => defaultFileConflictTask(root, { member: handBackMember(root), ...job }),

  // The member merge-line sweep starts gh with the same tool folders.
  toolEnv,

  failingLines,
  flagWhat,
  summaryLine,
};
