'use strict';

// One reaper for every agent work copy on this machine.
//
// Claude Code subagents (<repo>/.claude/worktrees/agent-*), engine dispatch
// (<arena>/.agent-worktrees/<repo>/...) and the night shift
// (<arena>/atrisos-backend-worktrees/night-*) all register with their home
// repo, so asking every repo under the arena for its worktree list covers
// every launcher.
//
// The Mac ran out of disk twice (2026-09-27, 2026-10-01) because finished
// copies were never put away. The rule for putting one away: when in doubt,
// keep. provablySafeToRemove answers safe only when every proof below
// succeeds; any error, timeout, partial output, or unknown keeps the copy.
// Branches are always kept: removing a worktree deletes the checkout only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GB = 1024 * 1024 * 1024;
const DEFAULT_ROOM_GB = 15;
const DEFAULT_REFUSE_GB = 5;
const COMMAND_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const LOCK_PID_PATTERN = /\bpid[ =:](\d+)\b/i;
const LOCK_START_PATTERN = /\bstart\s+([^)]+)\)/i;
const GIT_TIMEOUT_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 60 * 1000;
const GH_TIMEOUT_MS = 30 * 1000;
const LSOF_TIMEOUT_MS = 30 * 1000;
// The low-disk sweep before a launch may take this long in total.
const PRE_LAUNCH_SWEEP_MS = 60 * 1000;
// A copy made in the last hour may still have an engine booting inside.
const FRESH_GRACE_MS = 60 * 60 * 1000;
// Untracked or ignored files that are never work, by exact folder or file
// name anywhere, plus atris's own lookup cache files at the copy's root.
// Nothing else is junk.
const JUNK_NAMES = new Set(['__pycache__', '.pytest_cache', 'node_modules', '.DS_Store']);
const JUNK_FILES = new Set(['.atris/cache/.gitignore', '.atris/cache/map-refs.json', '.atris/cache/revision-files.json']);
// Per-worktree refs: they live only in this copy and vanish with it.
const WORKTREE_REF_PREFIXES = ['refs/worktree/', 'refs/bisect/', 'refs/rewritten/'];
// An operation half done in this copy.
const IN_PROGRESS_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
const PROTECTED_BRANCHES = new Set(['main', 'master']);
// Long-lived lanes that are never put away, whatever their git state.
const PERMANENT_PATTERNS = [/atrisos-backend-serve/, /overnight-master-runner/];
const OID_PATTERN = /^[0-9a-f]{40,64}$/;

function arenaRoot() {
  return path.resolve(process.env.ATRIS_ARENA_ROOT || path.join(os.homedir(), 'arena'));
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: COMMAND_MAX_BUFFER_BYTES, ...options });
}

function canonicalPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

// ---- keep, with a reason -------------------------------------------------------

class Keep extends Error {
  constructor(reason, detail = '') {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

function keep(reason, detail = '') {
  throw new Keep(reason, detail);
}

function timeLeft(ctx, cap) {
  if (!ctx.deadline) return cap;
  const left = ctx.deadline - Date.now();
  if (left <= 0) keep('out_of_time', 'the sweep ran out of time');
  return Math.min(cap, left);
}

// Run one read for a proof. Anything but a finished run with an accepted exit
// code keeps the copy.
function proofRun(ctx, cmd, args, { cwd, cap = GIT_TIMEOUT_MS, okCodes = [0], input } = {}) {
  const runner = ctx.runner || run;
  const label = `${cmd} ${args.slice(0, 2).join(' ')}`;
  let result;
  try {
    result = runner(cmd, args, { cwd, timeout: timeLeft(ctx, cap), ...(input === undefined ? {} : { input }) });
  } catch (error) {
    if (error instanceof Keep) throw error;
    keep('check_failed', `${label} could not run`);
  }
  if (!result || result.error || result.signal || typeof result.status !== 'number') {
    keep('check_failed', `${label} did not finish`);
  }
  if (!okCodes.includes(result.status)) keep('check_failed', `${label} failed`);
  return result;
}

// ---- worktree list -----------------------------------------------------------

function parsePorcelain(text) {
  const out = [];
  let current = null;
  for (const line of `${text}\n`.split('\n')) {
    if (!line) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      if (current) out.push(current);
      current = { path: value, head: '', branch: '', locked: false, lockReason: '', prunable: false };
    } else if (!current) {
      continue;
    } else if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    } else if (key === 'locked') {
      current.locked = true;
      current.lockReason = value;
    } else if (key === 'prunable') {
      current.prunable = true;
    }
  }
  return out;
}

function listEntries(ctx) {
  const result = proofRun(ctx, 'git', ['worktree', 'list', '--porcelain'], { cwd: ctx.repo });
  const entries = parsePorcelain(result.stdout || '');
  if (!entries.length) keep('check_failed', 'git listed no worktrees');
  return entries;
}

// Launchers put work copies only here. A worktree anywhere else belongs to
// a person and is never removed.
function defaultRoots(primary) {
  const arena = path.dirname(primary);
  return [
    path.join(arena, '.agent-worktrees'),
    path.join(primary, '.claude', 'worktrees'),
    path.join(arena, 'atrisos-backend-worktrees'),
  ];
}

// ---- locks -------------------------------------------------------------------

// Claude Code locks its subagent copies with
// "claude agent agent-<id> (pid N start <lstart>)"; the night shift with
// "night shift live run (pid N start <lstart>)". A lock that names a pid is
// stale only with proof its owner is gone: the pid is dead, or it is alive
// but started at a different time (a reused pid). A lock with no pid was
// placed by a person and is always honored.
function parseLockReason(reason) {
  const text = String(reason || '').trim();
  const pidMatch = LOCK_PID_PATTERN.exec(text);
  const startMatch = LOCK_START_PATTERN.exec(text);
  return {
    reason: text,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    start: startMatch ? startMatch[1].replace(/\s+/g, ' ').trim() : '',
  };
}

// 'dead' | 'alive' | 'unknown'
function ownerLife({ pid, start }, { runner = run } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'dead';
    if (!error || error.code !== 'EPERM') return 'unknown';
  }
  if (!start) return 'alive';
  const result = runner('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 10000 });
  if (!result || result.error || result.status !== 0) return 'unknown';
  const actual = String(result.stdout || '').replace(/\s+/g, ' ').trim();
  if (!actual) return 'unknown';
  return actual === start ? 'alive' : 'dead';
}

// ---- open files ----------------------------------------------------------------

// Every path any process holds open (cwd, open files, mapped binaries), or
// null when the listing is not provably whole: a non-zero exit, any warning
// on stderr, no process records, or output that does not end cleanly. A copy
// with anything open inside is in use, whatever its git state says.
function listOpenPaths({ runner = run } = {}) {
  const result = runner('lsof', ['-n', '-F', 'n'], { timeout: LSOF_TIMEOUT_MS });
  if (!result || result.error || result.signal || result.status !== 0) return null;
  if (String(result.stderr || '').trim()) return null;
  const text = String(result.stdout || '');
  if (!text.endsWith('\n') || !/^p\d+$/m.test(text)) return null;
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => !/^[a-zA-Z]/.test(line))) return null;
  const paths = new Set();
  for (const line of lines) {
    if (line.startsWith('n/')) paths.add(line.slice(1).replace(/ \(.*\)$/, ''));
  }
  return [...paths];
}

// ---- GitHub PR state ----------------------------------------------------------

// Squash merges never make the branch an ancestor of the default branch, so
// GitHub says what happened to the branch's PRs. Any gh failure answers
// "unknown", and an unknown keeps the copy.
function summarizePrs(prs) {
  if (!Array.isArray(prs)) return { state: 'unknown', prs: [] };
  if (!prs.length) return { state: 'none', prs: [] };
  if (prs.some((pr) => pr.state === 'OPEN')) return { state: 'open', prs };
  if (prs.some((pr) => pr.state === 'MERGED')) return { state: 'merged', prs };
  if (prs.every((pr) => pr.state === 'CLOSED')) return { state: 'closed', prs };
  return { state: 'unknown', prs };
}

function parsePrList(result) {
  if (!result || result.error || result.signal || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || '');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// One recent-PR listing per repo answers most branches; a branch missing from
// it gets its own `gh pr list --head <branch>` call. Every gh call has a
// time limit.
function createPrLookup({ runner = run, recentLimit = 300 } = {}) {
  const cache = new Map();
  const recentByRepo = new Map();
  const recentFor = (repoRoot, timeout) => {
    const repoKey = canonicalPath(repoRoot);
    if (recentByRepo.has(repoKey)) return recentByRepo.get(repoKey);
    const listed = parsePrList(runner('gh', [
      'pr', 'list', '--state', 'all', '--limit', String(recentLimit),
      '--json', 'number,state,headRefOid,headRefName,url',
    ], { cwd: repoRoot, timeout }));
    let index = null;
    if (listed) {
      index = new Map();
      for (const pr of listed) {
        if (!index.has(pr.headRefName)) index.set(pr.headRefName, []);
        index.get(pr.headRefName).push(pr);
      }
    }
    recentByRepo.set(repoKey, index);
    return index;
  };
  return function prLookup(repoRoot, branch, { timeout = GH_TIMEOUT_MS } = {}) {
    if (!branch) return { state: 'none', prs: [] };
    const key = `${canonicalPath(repoRoot)}\u0000${branch}`;
    if (cache.has(key)) return cache.get(key);
    const recent = recentFor(repoRoot, timeout);
    let answer;
    if (recent && recent.has(branch)) {
      answer = summarizePrs(recent.get(branch));
    } else {
      const prs = parsePrList(runner('gh', [
        'pr', 'list', '--head', branch, '--state', 'all', '--limit', '20',
        '--json', 'number,state,headRefOid,url',
      ], { cwd: repoRoot, timeout }));
      answer = prs ? summarizePrs(prs) : { state: 'unknown', prs: [] };
    }
    if (answer.state !== 'unknown') cache.set(key, answer);
    return answer;
  };
}

// ---- the proof -----------------------------------------------------------------

function isJunk(file) {
  if (file.endsWith('/')) return false;
  if (JUNK_FILES.has(file)) return true;
  return file.split('/').some((part) => JUNK_NAMES.has(part));
}

// Path: inside a launcher folder, no symlink anywhere, a registered linked
// worktree of this repo, never the main checkout.
function proveLocation(ctx, wtPath) {
  const resolved = path.resolve(wtPath);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    keep('missing_or_unreadable');
  }
  if (real !== resolved) keep('symlinked_path', 'a folder in its path is a link');
  const entries = listEntries(ctx);
  const primary = path.resolve(entries[0].path);
  if (real === primary) keep('primary_checkout');
  const roots = (ctx.roots || defaultRoots(primary)).map((root) => path.resolve(root));
  if (!roots.some((root) => real.startsWith(`${root}${path.sep}`))) keep('not_agent_copy');
  let gitFile;
  try {
    gitFile = fs.lstatSync(path.join(real, '.git'));
  } catch {
    keep('not_linked_worktree');
  }
  if (!gitFile.isFile()) keep('not_linked_worktree');
  const entry = entries.slice(1).find((item) => path.resolve(item.path) === real);
  if (!entry) keep('not_linked_worktree');
  return { real, entry };
}

// Changes: nothing staged or unstaged, and every untracked or ignored file is
// junk. Returns the junk files, which are deleted before removal.
function readStatus(ctx, real) {
  const result = proofRun(ctx, 'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'], { cwd: real });
  const out = [];
  for (const item of String(result.stdout || '').split('\0')) {
    if (!item) continue;
    if (item.length < 4 || item[2] !== ' ') keep('check_failed', 'git status gave output it could not read');
    out.push({ code: item.slice(0, 2), file: item.slice(3) });
  }
  return out;
}

function proveNoChanges(ctx, real) {
  const junk = [];
  for (const { code, file } of readStatus(ctx, real)) {
    if (code === '??' || code === '!!') {
      if (!isJunk(file)) keep(code === '??' ? 'untracked_files' : 'ignored_files', file);
      junk.push(file);
      continue;
    }
    keep('uncommitted_changes', file);
  }
  return { junk };
}

// Nothing git would not show: no file flagged to hide its edits
// (assume-unchanged or skip-worktree), no submodule, no half-done merge,
// rebase, cherry-pick, revert, or bisect.
function proveNothingHidden(ctx, real) {
  const flags = proofRun(ctx, 'git', ['ls-files', '-v'], { cwd: real });
  for (const line of String(flags.stdout || '').split('\n')) {
    if (!line) continue;
    const tag = line[0];
    if (/[a-z]/.test(tag) || tag === 'S') keep('hidden_changes', line.slice(2));
  }
  const stage = proofRun(ctx, 'git', ['ls-files', '--stage'], { cwd: real });
  if (/^160000 /m.test(String(stage.stdout || '')) || fs.existsSync(path.join(real, '.gitmodules'))) keep('has_submodule');
  const gitDir = String(proofRun(ctx, 'git', ['rev-parse', '--absolute-git-dir'], { cwd: real }).stdout || '').trim();
  if (!gitDir || !path.isAbsolute(gitDir)) keep('check_failed', 'could not find its git folder');
  const busy = IN_PROGRESS_MARKERS.find((name) => fs.existsSync(path.join(gitDir, name)));
  if (busy) keep('operation_in_progress', busy);
}

// History: every commit this copy alone remembers (its HEAD reflog and its
// own refs) is on a GitHub branch. A reflog that cannot be read keeps it.
function proveHistorySaved(ctx, real, head) {
  const reflog = proofRun(ctx, 'git', ['log', '-g', '--format=%H', 'HEAD', '--'], { cwd: real });
  const refs = proofRun(ctx, 'git', ['for-each-ref', '--format=%(objectname)', ...WORKTREE_REF_PREFIXES], { cwd: real });
  const commits = new Set([head]);
  for (const line of `${reflog.stdout || ''}\n${refs.stdout || ''}`.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    if (!OID_PATTERN.test(value)) keep('check_failed', 'its history could not be read');
    commits.add(value);
  }
  const missing = proofRun(ctx, 'git', ['rev-list', '--max-count=1', '--not', '--remotes', '--stdin'], {
    cwd: ctx.repo,
    input: `${[...commits].join('\n')}\n`,
  });
  const unsaved = String(missing.stdout || '').trim();
  if (unsaved) keep('history_not_on_github', `commit ${unsaved.slice(0, 10)} is only in this copy`);
}

function defaultRef(ctx) {
  if (ctx.base) return ctx.base;
  const head = (ctx.runner || run)('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: ctx.repo, timeout: GIT_TIMEOUT_MS });
  if (head && head.status === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^refs\/remotes\//, '');
  for (const name of ['main', 'master']) {
    const ref = (ctx.runner || run)('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], { cwd: ctx.repo, timeout: GIT_TIMEOUT_MS });
    if (ref && ref.status === 0) return `origin/${name}`;
  }
  return '';
}

// Commits: HEAD is in the default branch, or on a branch on GitHub.
function proveCommitsSaved(ctx, real) {
  const head = String(proofRun(ctx, 'git', ['rev-parse', '--verify', 'HEAD'], { cwd: real }).stdout || '').trim();
  if (!OID_PATTERN.test(head)) keep('check_failed', 'could not read its last commit');
  if (!ctx.defaultRef) keep('check_failed', 'could not find the main branch on GitHub');
  const ancestor = proofRun(ctx, 'git', ['merge-base', '--is-ancestor', head, ctx.defaultRef], { cwd: ctx.repo, okCodes: [0, 1] });
  if (ancestor.status === 0) return { head, inDefault: true };
  const remote = proofRun(ctx, 'git', ['branch', '-r', '--contains', head], { cwd: ctx.repo });
  if (!String(remote.stdout || '').trim()) keep('not_on_github');
  return { head, inDefault: false };
}

// PR: work not in the main branch goes only after its PR was merged or
// closed. No PR, an open PR, or GitHub not answering keeps it.
function provePrFinished(ctx, entry) {
  if (!entry.branch) keep('unmerged', 'no branch, and not in the main branch');
  if (ctx.prLookup === false) keep('unmerged', 'not in the main branch');
  let pr;
  try {
    pr = ctx.prLookup(ctx.repo, entry.branch, { timeout: timeLeft(ctx, GH_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Keep) throw error;
    keep('pr_unknown');
  }
  if (!pr || pr.state === 'unknown') keep('pr_unknown');
  const label = (state) => {
    const match = (pr.prs || []).find((item) => item.state === state);
    return match ? `#${match.number}` : '';
  };
  if (pr.state === 'open') keep('pr_open', label('OPEN'));
  if (pr.state === 'merged') return { reason: 'pr_merged', detail: label('MERGED') };
  if (pr.state === 'closed') return { reason: 'pr_closed', detail: label('CLOSED') };
  keep('unmerged', 'on GitHub, no PR yet');
}

// Owner: no process has anything open inside, and any lock is either absent
// or provably stale.
function proveNoOwner(ctx, real, entry) {
  const open = typeof ctx.openPaths === 'function' ? ctx.openPaths() : ctx.openPaths;
  if (!Array.isArray(open)) keep('open_files_unknown');
  const prefix = `${real}${path.sep}`;
  if (open.some((item) => item === real || item.startsWith(prefix))) keep('active_process');
  if (!entry.locked) return { staleLock: null };
  const parsed = parseLockReason(entry.lockReason);
  if (!parsed.pid) keep('locked', parsed.reason);
  const life = (ctx.ownerLife || ownerLife)(parsed, { runner: ctx.runner || run });
  if (life === 'alive') keep('locked_by_live_agent', `pid ${parsed.pid}`);
  if (life !== 'dead') keep('lock_owner_unknown', `pid ${parsed.pid}`);
  return { staleLock: entry.lockReason, stalePid: parsed.pid };
}

// { safe: true, ... } only when every proof holds; otherwise
// { safe: false, reason, detail }. Never throws.
function provablySafeToRemove(wtPath, ctx) {
  try {
    const { real, entry } = proveLocation(ctx, wtPath);
    if (PERMANENT_PATTERNS.some((pattern) => pattern.test(real))) keep('permanent_lane');
    if (PROTECTED_BRANCHES.has(entry.branch)) keep('protected_branch');
    if ((ctx.protectPaths || []).some((item) => item === real || item.startsWith(`${real}${path.sep}`))) keep('current_checkout');
    if (!ctx.ignoreGrace) {
      let ageMs;
      try {
        ageMs = (ctx.now || Date.now()) - fs.statSync(real).mtimeMs;
      } catch {
        keep('missing_or_unreadable');
      }
      if (ageMs < FRESH_GRACE_MS) keep('fresh_worktree_grace');
    }
    const { junk } = proveNoChanges(ctx, real);
    proveNothingHidden(ctx, real);
    const { head, inDefault } = proveCommitsSaved(ctx, real);
    proveHistorySaved(ctx, real, head);
    const landed = inDefault ? { reason: 'merged_into_base' } : provePrFinished(ctx, entry);
    const owner = proveNoOwner(ctx, real, entry);
    return {
      safe: true,
      path: real,
      branch: entry.branch,
      head,
      junk,
      reason: landed.reason,
      ...(landed.detail ? { detail: landed.detail } : {}),
      staleLock: owner.staleLock,
      ...(owner.stalePid ? { stale_lock_pid: owner.stalePid } : {}),
    };
  } catch (error) {
    if (error instanceof Keep) {
      return { safe: false, reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) };
    }
    return { safe: false, reason: 'check_failed', detail: String((error && error.message) || error).slice(0, 200) };
  }
}

function lockReasonNow(ctx, real) {
  try {
    const entry = listEntries(ctx).find((item) => path.resolve(item.path) === real);
    if (!entry) return null;
    return entry.locked ? entry.lockReason : '';
  } catch {
    return null;
  }
}

// Delete one junk file git reported, never through a link. Empty junk
// folders left behind go too.
function deleteJunkFile(real, file) {
  const parts = file.split('/');
  let dir = real;
  for (const part of parts.slice(0, -1)) {
    if (!part || part === '.' || part === '..') return;
    dir = path.join(dir, part);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) return;
  }
  const target = path.join(dir, parts[parts.length - 1]);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || stat.isDirectory()) return;
  fs.unlinkSync(target);
  for (let parent = path.dirname(target); parent !== real && parent.startsWith(`${real}${path.sep}`); parent = path.dirname(parent)) {
    try {
      fs.rmdirSync(parent);
    } catch {
      break;
    }
  }
}

// Put a copy away. Prove it all again with a fresh look at open files, delete
// the junk files, then check once more that git sees nothing at all (no
// change, no new or ignored file, nothing hidden) and that the lock is
// exactly what was proven stale, and only then run a plain
// `git worktree remove`. There is no --force anywhere: if anything appeared
// in between, git refuses, the copy stays, and its lock is put back.
function removeIfProvablySafe(wtPath, ctx, first) {
  const runner = ctx.runner || run;
  const fresh = { ...ctx, openPaths: () => (ctx.freshOpenPaths || listOpenPaths)({ runner }) };
  const again = provablySafeToRemove(wtPath, fresh);
  if (!again.safe) return { removed: false, reason: again.reason, detail: again.detail };
  const real = again.path;
  if ((first && first.staleLock) !== again.staleLock) return { removed: false, reason: 'lock_changed' };
  try {
    for (const file of again.junk || []) deleteJunkFile(real, file);
    const left = readStatus(ctx, real);
    if (left.length) keep('changed_while_checking', left[0].file);
    proveNothingHidden(ctx, real);
  } catch (error) {
    if (error instanceof Keep) return { removed: false, reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) };
    return { removed: false, reason: 'check_failed', detail: String((error && error.message) || error).slice(0, 160) };
  }
  if (lockReasonNow(ctx, real) !== (again.staleLock || '')) return { removed: false, reason: 'lock_changed' };
  if (again.staleLock) {
    const unlocked = runner('git', ['worktree', 'unlock', real], { cwd: ctx.repo, timeout: GIT_TIMEOUT_MS });
    if (!unlocked || unlocked.status !== 0) return { removed: false, reason: 'remove_failed', detail: 'git would not unlock it' };
  }
  const removed = runner('git', ['worktree', 'remove', real], { cwd: ctx.repo, timeout: GIT_TIMEOUT_MS });
  if (!removed || removed.status !== 0) {
    if (again.staleLock) runner('git', ['worktree', 'lock', '--reason', again.staleLock, real], { cwd: ctx.repo, timeout: GIT_TIMEOUT_MS });
    const said = String((removed && (removed.stderr || removed.stdout)) || '').trim().split('\n').pop() || 'no answer';
    return { removed: false, reason: 'remove_failed', detail: said.slice(0, 160) };
  }
  return { removed: true, reason: again.reason };
}

// ---- one repo --------------------------------------------------------------------

// Judge every linked worktree of one repo; with apply, put the safe ones
// away. Returns { apply, base, candidates, removed, kept }.
function sweepRepo({
  repo,
  base = '',
  apply = false,
  roots = null,
  openPaths = undefined,
  prLookup = null,
  protectPaths = [],
  ignoreGrace = false,
  only = null,
  deadline = 0,
  runner = null,
  beforeRemove = null,
  fetch = true,
  ownerLife: ownerLifeOverride = null,
  freshOpenPaths = null,
} = {}) {
  const ctx = {
    repo,
    base,
    roots,
    prLookup: prLookup === false ? false : (prLookup || createPrLookup()),
    protectPaths: [repo, ...protectPaths].filter(Boolean).map(canonicalPath),
    ignoreGrace,
    deadline,
    runner,
    ownerLife: ownerLifeOverride,
    freshOpenPaths: freshOpenPaths || (openPaths === undefined || typeof openPaths === 'function' ? null : () => openPaths),
  };
  // Listing open files takes a few seconds: ask once, and only when a copy
  // gets that far. An array is a listing; null means the listing failed.
  let open = openPaths;
  ctx.openPaths = typeof openPaths === 'function' ? openPaths : () => {
    if (open === undefined) open = listOpenPaths({ runner: runner || run });
    return open;
  };
  const entries = parsePorcelain(String(proofRunOrThrow(ctx, ['worktree', 'list', '--porcelain']).stdout || ''));
  if (!entries.length) throw new Error('git listed no worktrees');
  ctx.defaultRef = ctx.base || defaultRef(ctx);
  // Fresh main branch first, with a time limit. A failed fetch only makes
  // the sweep keep more.
  if (!ctx.base && fetch && !deadline && ctx.defaultRef) {
    (runner || run)('git', ['fetch', '--quiet', 'origin', ctx.defaultRef.replace(/^origin\//, '')], { cwd: repo, timeout: FETCH_TIMEOUT_MS });
  }
  const onlyPaths = Array.isArray(only) ? new Set(only.map(canonicalPath)) : null;
  const candidates = [];
  const removed = [];
  const kept = [];
  for (const entry of entries.slice(1)) {
    if (onlyPaths && !onlyPaths.has(canonicalPath(entry.path))) continue;
    const item = { path: entry.path, branch: entry.branch || 'detached', head: entry.head };
    const verdict = provablySafeToRemove(entry.path, ctx);
    if (!verdict.safe) {
      kept.push({ ...item, reason: verdict.reason, ...(verdict.detail ? { detail: verdict.detail } : {}) });
      continue;
    }
    const candidate = {
      ...item,
      reason: verdict.reason,
      ...(verdict.detail ? { detail: verdict.detail } : {}),
      ...(verdict.stale_lock_pid ? { stale_lock_pid: verdict.stale_lock_pid } : {}),
    };
    candidates.push(candidate);
    if (!apply) continue;
    if (typeof beforeRemove === 'function') {
      try { beforeRemove(entry.path); } catch {}
    }
    const outcome = removeIfProvablySafe(entry.path, ctx, verdict);
    if (outcome.removed) removed.push(candidate);
    else kept.push({ ...item, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  }
  return { apply, base: ctx.defaultRef, candidates, removed, kept };
}

function proofRunOrThrow(ctx, args) {
  try {
    return proofRun(ctx, 'git', args, { cwd: ctx.repo });
  } catch (error) {
    throw new Error(error instanceof Keep ? `${error.detail || error.reason}` : String(error));
  }
}

// ---- disk --------------------------------------------------------------------

function freeBytes(target = os.homedir()) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(target);
      return Number(stats.bavail) * Number(stats.bsize);
    }
  } catch {}
  const result = run('df', ['-k', target], { timeout: 10000 });
  const line = String(result.stdout || '').trim().split(/\r?\n/)[1] || '';
  const available = Number(line.split(/\s+/)[3]);
  return Number.isFinite(available) ? available * 1024 : Infinity;
}

function sizeBytes(target) {
  const result = run('du', ['-sk', target], { timeout: 120000 });
  const kb = Number(String(result.stdout || '').trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

function formatGb(bytes) {
  return `${(bytes / GB).toFixed(1)} GB`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}G`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))}M`;
}

// ---- repos -------------------------------------------------------------------

// Every git repo one or two levels under the arena (ecosystem/openclaw sits at
// depth two). Worktree checkouts have a .git file, not a directory, so they
// are skipped here and found through their home repo's worktree list.
function discoverRepos(root = arenaRoot()) {
  const repos = [];
  const visit = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      let isRepo = false;
      try {
        isRepo = fs.statSync(path.join(full, '.git')).isDirectory();
      } catch {}
      if (isRepo) repos.push(full);
      else if (depth < 2) visit(full, depth + 1);
    }
  };
  visit(root, 1);
  return repos.sort();
}

function repoHasWorktrees(repo) {
  try {
    return fs.readdirSync(path.join(repo, '.git', 'worktrees')).length > 0;
  } catch {
    return false;
  }
}

// ---- the arena sweep ----------------------------------------------------------

const VERDICT_REMOVE = 'remove';
const VERDICT_KEEP = 'keep';

function rowsFromSweep(repo, result) {
  const rows = [];
  const removedPaths = new Set((result.removed || []).map((item) => item.path));
  const keptPaths = new Set((result.kept || []).map((item) => item.path));
  for (const item of result.candidates || []) {
    if (result.apply && keptPaths.has(item.path)) continue;
    rows.push({
      repo,
      path: item.path,
      branch: item.branch,
      verdict: VERDICT_REMOVE,
      reason: item.reason,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.stale_lock_pid ? { stale_lock_pid: item.stale_lock_pid } : {}),
      removed: result.apply ? removedPaths.has(item.path) : false,
    });
  }
  for (const item of result.kept || []) {
    rows.push({
      repo,
      path: item.path,
      branch: item.branch,
      verdict: VERDICT_KEEP,
      reason: item.reason,
      ...(item.detail ? { detail: item.detail } : {}),
    });
  }
  return rows;
}

// Sweep the given repos (default: every repo under the arena). apply=false
// only reports. sizes: 'all' measures every copy, 'removed' only what goes,
// false nothing. deadline (ms since epoch) bounds the whole sweep.
function reapArena({
  arena = arenaRoot(),
  repos = null,
  apply = false,
  sizes = apply ? 'removed' : 'all',
  log = () => {},
  openPaths = undefined,
  prLookup = null,
  deadline = 0,
  only = null,
  runner = null,
} = {}) {
  const freeBefore = freeBytes(arena);
  let open = openPaths;
  const sharedOpen = () => {
    if (open === undefined) open = listOpenPaths({ runner: runner || run });
    return open;
  };
  const lookup = prLookup === false ? false : (prLookup || createPrLookup());
  const self = canonicalPath(process.cwd());
  const rows = [];
  const errors = [];
  const repoList = (repos || discoverRepos(arena)).filter(repoHasWorktrees);
  for (const repo of repoList) {
    if (deadline && Date.now() >= deadline) {
      errors.push({ repo, error: 'out of time, checked next sweep' });
      continue;
    }
    try {
      const sizeOf = new Map();
      const measure = (wtPath) => {
        if (!sizes) return;
        if (!sizeOf.has(wtPath)) sizeOf.set(wtPath, sizeBytes(wtPath));
      };
      const result = sweepRepo({
        repo,
        apply,
        openPaths: sharedOpen,
        freshOpenPaths: openPaths === undefined ? null : () => openPaths,
        prLookup: lookup,
        protectPaths: [self],
        deadline,
        runner,
        only,
        beforeRemove: sizes ? measure : null,
      });
      const repoRows = rowsFromSweep(repo, result);
      for (const row of repoRows) {
        if (sizes === 'all' || (sizes && row.verdict === VERDICT_REMOVE)) {
          if (!sizeOf.has(row.path) && fs.existsSync(row.path)) measure(row.path);
          row.bytes = sizeOf.get(row.path) || 0;
        }
      }
      rows.push(...repoRows);
      log(`${path.basename(repo)}: ${repoRows.filter((r) => r.verdict === VERDICT_REMOVE).length} to remove, ${repoRows.filter((r) => r.verdict === VERDICT_KEEP).length} kept`);
    } catch (error) {
      errors.push({ repo, error: String((error && error.message) || error).slice(0, 300) });
    }
  }
  const removable = rows.filter((row) => row.verdict === VERDICT_REMOVE);
  const removed = rows.filter((row) => row.removed);
  const sum = (list) => list.reduce((total, row) => total + (row.bytes || 0), 0);
  return {
    apply,
    arena,
    repos: repoList,
    rows,
    errors,
    removable: removable.length,
    removableBytes: sum(removable),
    removed: removed.length,
    freedBytes: sum(removed),
    freeBefore,
    freeAfter: apply ? freeBytes(arena) : freeBefore,
  };
}

const REASON_TEXT = {
  merged_into_base: 'landed in the main branch',
  pr_merged: 'PR merged, every commit on GitHub',
  pr_closed: 'PR closed, every commit on GitHub',
  unmerged: 'work not landed',
  pr_open: 'PR still open',
  pr_unknown: 'GitHub did not say what happened to its PR',
  not_on_github: 'has commits that are not on GitHub',
  uncommitted_changes: 'uncommitted changes',
  untracked_files: 'new files that were never committed',
  ignored_files: 'ignored files that may be work',
  locked_by_live_agent: 'in use by a running agent',
  lock_owner_unknown: 'could not tell if the agent that locked it is still running',
  locked: 'locked by hand',
  lock_changed: 'its lock changed while checking',
  active_process: 'a program has files open in it',
  open_files_unknown: 'could not check which files are open',
  fresh_worktree_grace: 'made in the last hour',
  not_agent_copy: 'outside the agent work folders, left for its owner',
  symlinked_path: 'reached through a link, left alone',
  not_linked_worktree: 'not a work copy git knows about',
  primary_checkout: 'the main checkout',
  permanent_lane: 'permanent lane',
  current_checkout: 'this checkout',
  protected_branch: 'main branch checkout',
  missing_or_unreadable: 'folder missing or unreadable',
  check_failed: 'a check failed',
  out_of_time: 'out of time, checked next sweep',
  remove_failed: 'git would not remove it',
  hidden_changes: 'a file is flagged so git hides its edits',
  has_submodule: 'has a submodule',
  operation_in_progress: 'a merge, rebase, or similar is half done',
  history_not_on_github: 'its history has commits that are not on GitHub',
  changed_while_checking: 'a file appeared while checking',
};

function reasonText(row) {
  const base = REASON_TEXT[row.reason] || row.reason;
  const extras = [];
  if (row.detail) extras.push(row.detail);
  if (row.stale_lock_pid) extras.push(`its agent (pid ${row.stale_lock_pid}) has exited`);
  return extras.length ? `${base} (${extras.join('; ')})` : base;
}

function shortPath(value) {
  const home = os.homedir();
  return value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

function renderReapTable(report, { all = true } = {}) {
  const lines = [];
  const rows = all ? report.rows : report.rows.filter((row) => row.verdict === VERDICT_REMOVE);
  const ordered = [...rows].sort((a, b) => (a.verdict === b.verdict ? (b.bytes || 0) - (a.bytes || 0) : a.verdict === VERDICT_REMOVE ? -1 : 1));
  const pathWidth = Math.min(90, Math.max(4, ...ordered.map((row) => shortPath(row.path).length)));
  lines.push(`${'PATH'.padEnd(pathWidth)}  ${'SIZE'.padStart(6)}  ${'VERDICT'.padEnd(7)}  REASON`);
  for (const row of ordered) {
    const shown = shortPath(row.path);
    const clipped = shown.length > pathWidth ? `...${shown.slice(shown.length - pathWidth + 3)}` : shown;
    const verdict = row.removed ? 'removed' : row.verdict;
    lines.push(`${clipped.padEnd(pathWidth)}  ${formatSize(row.bytes).padStart(6)}  ${verdict.padEnd(7)}  ${reasonText(row)}`);
  }
  lines.push('');
  if (report.apply) {
    lines.push(`removed ${report.removed} of ${report.rows.length} copies, freed ${formatGb(report.freedBytes)}; ${formatGb(report.freeAfter)} free now`);
  } else {
    lines.push(`would remove ${report.removable} of ${report.rows.length} copies, freeing ${formatGb(report.removableBytes)}; ${formatGb(report.freeBefore)} free now`);
  }
  for (const item of report.errors) lines.push(`could not check ${shortPath(item.repo)}: ${item.error}`);
  return lines.join('\n');
}

// ---- disk room before a new copy -------------------------------------------

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Called by every launcher before it makes a worktree. Under roomGb free, put
// finished copies of the repo being launched away first (never the whole
// arena, and never longer than a minute); still under refuseGb, refuse with a
// plain message instead of filling the disk. Test runs skip it (a test repo
// must never sweep a real one) unless a caller passes force.
function ensureDiskRoom({
  target = arenaRoot(),
  repos = [],
  roomGb = envNumber('ATRIS_DISK_ROOM_GB', DEFAULT_ROOM_GB),
  refuseGb = envNumber('ATRIS_DISK_REFUSE_GB', DEFAULT_REFUSE_GB),
  free = freeBytes,
  reap = reapArena,
  budgetMs = PRE_LAUNCH_SWEEP_MS,
  force = false,
  log = () => {},
} = {}) {
  if (!force && (process.env.ATRIS_DISK_GUARD === 'off' || process.env.NODE_TEST_CONTEXT)) {
    return { ok: true, skipped: true };
  }
  const before = free(target);
  if (before >= roomGb * GB) return { ok: true, freeBytes: before, reaped: 0 };
  let removed = 0;
  const launchRepos = (repos || []).filter(Boolean);
  if (launchRepos.length) {
    log(`disk: ${formatGb(before)} free, under ${roomGb} GB; putting finished copies of this repo away first`);
    try {
      const reaped = reap({ repos: launchRepos, apply: true, sizes: false, deadline: Date.now() + budgetMs });
      removed = reaped ? reaped.removed : 0;
    } catch (error) {
      log(`disk: cleanup failed: ${String((error && error.message) || error).slice(0, 200)}`);
    }
  }
  const after = free(target);
  if (removed) log(`disk: put away ${removed} finished cop${removed === 1 ? 'y' : 'ies'}, ${formatGb(after)} free now`);
  if (after < refuseGb * GB) {
    return {
      ok: false,
      freeBytes: after,
      reaped: removed,
      message: `Not starting another work copy: only ${formatGb(after)} of disk is free, and each copy can take close to 1 GB. `
        + `Finished copies of this repo were already put away. Free some space, then try again. To see what is still kept: atris worktree reap`,
    };
  }
  return { ok: true, freeBytes: after, reaped: removed };
}

module.exports = {
  GB,
  arenaRoot,
  canonicalPath,
  createPrLookup,
  discoverRepos,
  ensureDiskRoom,
  formatGb,
  freeBytes,
  ownerLife,
  parseLockReason,
  provablySafeToRemove,
  reapArena,
  reasonText,
  renderReapTable,
  sweepRepo,
};
