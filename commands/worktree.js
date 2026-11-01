'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { hasFlag, readFlag } = require('../lib/arg-parser');
const { stampLatestOpenBriefForWorktree } = require('../lib/brief-ledger');
const { installKeep, planKeep, removeKeep } = require('../lib/campaign-keep');
const { isConductorArtifact, isConductorUntracked } = require('../lib/conductor-artifacts');
const { fixMapDocs } = require('../lib/map-refs');
const { runMergeGate } = require('../lib/merge-gate');
const { checkedPush } = require('../lib/checked-push');
const { sleepSync } = require('../lib/sleep-sync');
const space = require('../lib/worktree-space');
const close = require('./close');

const ATRIS_BIN = path.resolve(__dirname, '..', 'bin', 'atris.js');

// Files atris regenerates on its own. Unstaged churn in them is restored
// before ship commits, unless the commit message names the file. The task
// projection is rewritten by any task command run in a work folder, and two
// parallel landings that each carry a copy always clash.
const REGEN_ADAPTER_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.atris/state/tasks.projection.json'];
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// Push also runs local hooks. Backend startup and regression checks alone can
// exceed the short network-only allowance used by fetch and discovery.
const GIT_PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_OID_PATTERN = /^[0-9a-f]{40,64}$/;
const ONE_LAP_PROOF_REF_PATTERN = /^refs\/atris\/one-lap\/([0-9a-f]{40,64})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHIP_HEALTH_SOURCE = 'ship-health:experiments-daily';

function gitNetworkEnvironment(source = process.env, cwd = process.cwd()) {
  const env = { ...source, GIT_TERMINAL_PROMPT: '0' };
  // Custom commands may be wrappers that do not accept OpenSSH flags.
  // Leave Git's own command/config/program precedence intact.
  if (source.GIT_SSH_COMMAND || source.GIT_SSH) return env;
  const configured = spawnSync('git', ['config', '--get', 'core.sshCommand'], {
    cwd, encoding: 'utf8', env: source, timeout: 5000, killSignal: 'SIGKILL',
  });
  if (configured.status === 0 && String(configured.stdout || '').trim()) return env;
  env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15';
  return env;
}

// A killed network call leaves stderr empty; name the timeout instead.
function gitFailureDetail(result) {
  if (result && result.error && result.error.code === 'ETIMEDOUT') return 'timed out';
  return [result && result.stdout, result && result.stderr]
    .map(output => String(output || '').trim()).filter(Boolean).join('\n');
}

function runGit(args, { cwd = process.cwd(), check = true, timeout, maxBuffer } = {}) {
  const network = ['fetch', 'push', 'ls-remote'].includes(args[0]);
  // Only network calls need the SSH probe; local calls skip its extra git spawn.
  const defaultTimeout = args[0] === 'push' ? GIT_PUSH_TIMEOUT_MS : network ? 30000 : undefined;
  const options = { cwd, encoding: 'utf8', timeout: timeout ?? defaultTimeout,
    killSignal: 'SIGKILL', env: network ? gitNetworkEnvironment(process.env, cwd) : undefined };
  if (maxBuffer) options.maxBuffer = maxBuffer;
  let result = spawnSync('git', args, options);
  // Linked checkouts share config. A concurrent start must not silently lose
  // its owner/base metadata, but real config errors still stop immediately.
  for (let retry = 1; args[0] === 'config' && retry < 3 && configLocked(result); retry += 1) {
    sleepSync(100 * retry);
    result = spawnSync('git', args, options);
  }
  if (check && result.status !== 0) {
    const detail = gitFailureDetail(result);
    throw new Error(detail === 'timed out' ? `git ${args[0]} timed out` : (detail || `git ${args.join(' ')} failed`));
  }
  return result;
}

function configLocked(result) {
  return result.status !== 0 && /could not lock config file/i.test(`${result.stderr || ''}${result.stdout || ''}`);
}

function runCommand(command, { cwd = process.cwd(), check = true } = {}) {
  const result = spawnSync(command, {
    cwd,
    encoding: 'utf8',
    shell: true,
    stdio: 'pipe',
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  if (result.error) throw result.error;
  if (check && result.status !== 0) {
    const msg = (result.stderr || result.stdout || `${command} failed`).trim();
    throw new Error(msg);
  }
  return result;
}

function statusSnapshot(root) {
  const result = runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, check: false });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function newStatusRows(before, after) {
  const seen = new Set(before);
  return after.filter((row) => !seen.has(row));
}

function readOneLapProofBinding(root, branch) {
  const sidecarPath = path.join(root, '.atris', 'agent-worktree.json');
  let sidecar = null;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw new Error('one-lap proof metadata is unreadable');
  }
  const metadata = sidecar && sidecar.one_lap_proof;
  const configured = runGit(['config', '--get', `branch.${branch}.atris-proof-ref`], { cwd: root, check: false });
  const configuredRef = configured.status === 0 ? String(configured.stdout || '').trim() : '';
  if (!metadata && !configuredRef) return null;
  if (!metadata || !configuredRef) throw new Error('one-lap proof binding is incomplete');

  const proofRef = String(metadata.ref || '');
  const sourceCommit = String(metadata.commit || '');
  const sourceTree = String(metadata.tree || '');
  const refMatch = proofRef.match(ONE_LAP_PROOF_REF_PATTERN);
  if (!refMatch || proofRef !== configuredRef || !GIT_OID_PATTERN.test(sourceCommit) || !GIT_OID_PATTERN.test(sourceTree)) {
    throw new Error('one-lap proof binding is invalid');
  }
  const resolvedCommit = runGit(['rev-parse', '--verify', `${proofRef}^{commit}`], { cwd: root, check: false });
  const resolvedTree = runGit(['rev-parse', '--verify', `${proofRef}^{tree}`], { cwd: root, check: false });
  if (resolvedCommit.status !== 0 || String(resolvedCommit.stdout || '').trim() !== sourceCommit || refMatch[1] !== sourceCommit) {
    throw new Error('one-lap proof commit no longer matches its retained ref');
  }
  if (resolvedTree.status !== 0 || String(resolvedTree.stdout || '').trim() !== sourceTree) {
    throw new Error('one-lap proof tree no longer matches its retained ref');
  }
  return { ref: proofRef, commit: sourceCommit, tree: sourceTree };
}

function worktreeTree(root, source) {
  const result = runGit(source === 'index'
    ? ['write-tree']
    : ['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: root, check: false });
  if (result.status !== 0) throw new Error(`could not resolve the ${source} tree for one-lap proof`);
  return String(result.stdout || '').trim();
}

function assertOneLapProofTree(root, binding, source) {
  if (!binding) return;
  if (worktreeTree(root, source) !== binding.tree) {
    throw new Error(`one-lap ${source} tree differs from the independently verified proof tree`);
  }
}

function repoRoot(cwd = process.cwd()) {
  return runGit(['rev-parse', '--show-toplevel'], { cwd }).stdout.trim();
}

function slugify(value, fallback = 'task', limit = 48) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
}

function branchName(member, task, now = new Date()) {
  return `codex/${slugify(member, 'member', 24)}-${slugify(task, 'task', 36)}-${stamp(now)}`;
}

// The newest earlier run of this same member+job, if its commits never reached
// the base, so a retry continues that work instead of redoing it. Only the
// newest run counts: once it landed or did nothing, anything older is stale.
function lastRunBranch(root, owner, task, base, skip) {
  const prefix = `codex/${slugify(owner, 'member', 24)}-${slugify(task, 'task', 36)}-`;
  const listed = runGit(['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}*`], { cwd: root, check: false });
  if (listed.status !== 0) return null;
  // Only exact runs of this job (stamp plus optional same-second number), so
  // "fix-login" never matches "fix-login-page".
  const runs = listed.stdout.split('\n').map((name) => name.trim())
    .map((name) => ({ name, run: name.slice(prefix.length).match(/^(\d{8}-\d{6})(?:-(\d+))?$/) }))
    .filter(({ name, run }) => run && name !== skip)
    .sort((a, b) => b.run[1].localeCompare(a.run[1]) || Number(b.run[2] || 1) - Number(a.run[2] || 1));
  if (!runs.length) return null;
  const newest = runs[0].name;
  const cherry = runGit(['cherry', base, newest], { cwd: root, check: false });
  if (cherry.status !== 0) return null;
  return cherry.stdout.split('\n').some((line) => line.startsWith('+')) ? newest : null;
}

// True only when git proves the branch no longer merges cleanly with the base.
// merge-tree --write-tree exits 1 on conflict; an error or old git keeps the
// resume as before.
function conflictsWithBase(root, base, branch) {
  const result = runGit(['merge-tree', '--write-tree', '--name-only', base, branch], { cwd: root, check: false });
  return result.status === 1;
}

function defaultWorktreePath(root, member, task, now = new Date()) {
  const name = `${slugify(member, 'member', 24)}-${slugify(task, 'task', 36)}-${stamp(now)}`;
  return path.join(path.dirname(root), '.agent-worktrees', path.basename(root), name);
}

function parseWorktrees(text) {
  const out = [];
  let current = {};
  for (const raw of `${text}\n`.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current.worktree) {
        let branch = current.branch || 'detached';
        branch = branch.replace(/^refs\/heads\//, '');
        const item = { path: current.worktree, branch, head: current.HEAD || '' };
        if (current.locked) item.locked = true;
        if (current.prunable) item.prunable = true;
        out.push(item);
      }
      current = {};
      continue;
    }
    const idx = line.indexOf(' ');
    if (idx === -1) {
      current[line] = true;
    } else {
      current[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return out;
}

function listWorktrees(root = repoRoot()) {
  return parseWorktrees(runGit(['worktree', 'list', '--porcelain'], { cwd: root }).stdout);
}

// Duplicate flight guard. On 2026-08-07 two agents were dispatched onto the
// same map rewrite 44 seconds apart: fleet dispatch claims a task first, but a
// direct `worktree start` had no pre-check beyond the target path existing.
// Refuse only the same task slug. A shared word on an unrelated flight is not
// a collision (dispatch-cli-900 must not block dispatch-cli-901).
const AGENT_FLIGHT_NAME_PATTERN = /^codex\/(.+)-(\d{8}-\d{6})$/;
const FLIGHT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FLIGHT_STOPWORDS = new Set([
  'fix', 'add', 'update', 'make', 'change', 'new', 'task', 'work', 'repo',
  'cli', 'atris', 'backend', 'the', 'a', 'an', 'and', 'for', 'to', 'of', 'in', 'on',
]);

function flightStampMs(stampText) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(stampText || ''));
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function taskTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !FLIGHT_STOPWORDS.has(token));
}

// codex/<owner>-<task-slug>-<YYYYMMDD-HHMMSS>: drop the owner segment and the
// stamp, and what is left is the task the flight is working on.
function parseAgentFlightName(name) {
  const text = String(name || '').trim().replace(/^refs\/heads\//, '');
  const match = AGENT_FLIGHT_NAME_PATTERN.exec(text);
  if (!match) return null;
  const stampMs = flightStampMs(match[2]);
  if (stampMs === null) return null;
  const segments = match[1].split('-').filter(Boolean);
  if (segments.length < 2) return null;
  return {
    name: text,
    owner: segments[0],
    taskSlug: segments.slice(1).join('-'),
    stamp: match[2],
    stampMs,
    tokens: taskTokens(segments.slice(1).join('-')),
  };
}

function remoteAgentBranchNames(root) {
  // One ls-remote, best effort: offline dispatchers still get the local view.
  const result = runGit(['ls-remote', '--heads', 'origin'], { cwd: root, check: false, timeout: 10000 });
  if (result.status !== 0) return [];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => (line.split(/\s+/)[1] || '').replace(/^refs\/heads\//, '').trim())
    .filter(Boolean);
}

function inFlightAgentFlights({ root = repoRoot(), now = new Date(), windowMs = FLIGHT_WINDOW_MS } = {}) {
  const nowMs = now.getTime();
  const flights = new Map();
  const add = (name, kind) => {
    const flight = parseAgentFlightName(name);
    if (!flight) return;
    // Branch age comes from the stamp in the name, never a git log per branch.
    if (kind !== 'worktree' && nowMs - flight.stampMs > windowMs) return;
    const existing = flights.get(flight.name);
    if (existing && existing.kind === 'worktree') return;
    flights.set(flight.name, { ...flight, kind });
  };
  for (const wt of listWorktrees(root)) add(wt.branch, 'worktree');
  const local = runGit(['branch', '--format=%(refname:short)'], { cwd: root, check: false });
  if (local.status === 0) {
    for (const name of String(local.stdout || '').split(/\r?\n/)) add(name, 'branch');
  }
  for (const name of remoteAgentBranchNames(root)) add(name, 'branch');
  return [...flights.values()].sort((a, b) => b.stampMs - a.stampMs);
}

function collidingFlights(flights, taskSlug) {
  const wanted = String(taskSlug || '').trim().toLowerCase();
  if (!wanted) return [];
  return flights.filter((flight) => String(flight.taskSlug || '').toLowerCase() === wanted);
}

function describeFlightAge(flight, nowMs = Date.now()) {
  const minutes = Math.max(0, Math.round((nowMs - flight.stampMs) / 60000));
  if (minutes < 60) return `${minutes}m old`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m old`;
}

function refExists(root, ref) {
  return runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, check: false }).status === 0;
}

function currentBranch(root = repoRoot()) {
  return runGit(['branch', '--show-current'], { cwd: root, check: false }).stdout.trim();
}

function detachedShipBranch(root) {
  return `codex/${path.basename(root)}`;
}

function createDetachedShipBranch(root, branch) {
  if (refExists(root, `refs/heads/${branch}`) || refExists(root, `refs/remotes/origin/${branch}`)) {
    console.error(`blocked: detached head branch already exists: ${branch}`);
    return false;
  }
  const created = runGit(['switch', '-c', branch], { cwd: root, check: false });
  if (created.status !== 0) {
    console.error(`blocked: detached head branch create failed: ${branch}`);
    console.error((created.stderr || created.stdout || '').trim());
    return false;
  }
  console.log(`ship: detached head, created branch ${branch}`);
  return true;
}

function currentUpstream(root) {
  const result = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root, check: false });
  return result.status === 0 ? result.stdout.trim() : '';
}

function remoteHead(root) {
  // The saved origin/HEAD survives branch renames. Ask the remote before
  // trusting it, keeping the offline fallback when the remote is unavailable.
  const remote = runGit(['remote', 'get-url', 'origin'], { cwd: root, check: false });
  if (remote.status === 0) {
    const live = runGit(['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: root, check: false, timeout: 5000 });
    const match = live.status === 0 && String(live.stdout || '').match(/^ref: refs\/heads\/(.+)\s+HEAD$/m);
    if (match) {
      const head = `origin/${match[1]}`;
      if (!refExists(root, head)) {
        const fetched = runGit(['fetch', 'origin', `refs/heads/${match[1]}:refs/remotes/${head}`], { cwd: root, check: false, timeout: 5000 });
        if (fetched.status !== 0 || !refExists(root, head)) {
          throw new Error('could not fetch the remote default branch; stop and retry when the remote is available');
        }
      }
      return head;
    }
  }
  const result = runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root, check: false });
  return result.status === 0 ? result.stdout.trim() : '';
}

function normalizeTargetRef(root, target) {
  const value = String(target || '').trim();
  if (!value) return '';
  const remotes = runGit(['remote'], { cwd: root, check: false }).stdout.split(/\r?\n/);
  const preferRemote =
    !value.startsWith('origin/') &&
    !value.startsWith('refs/') &&
    value !== 'HEAD' &&
    !/^[0-9a-f]{7,40}$/i.test(value) &&
    remotes.includes('origin');
  const remoteRef = value.startsWith('origin/') ? value : `origin/${value}`;
  if (preferRemote && refExists(root, remoteRef)) return remoteRef;
  if (preferRemote) return remoteRef;
  if (refExists(root, value)) return value;
  if (refExists(root, remoteRef)) return remoteRef;
  if (value.startsWith('origin/') || remotes.includes('origin')) return remoteRef;
  return value;
}

function defaultMainlineBase(root) {
  const head = remoteHead(root);
  if (head && refExists(root, head)) return head;
  for (const candidate of ['origin/main', 'origin/master']) {
    if (refExists(root, candidate)) return candidate;
  }
  return 'HEAD';
}

function defaultStartBase(root) {
  const upstream = currentUpstream(root);
  const mainline = defaultMainlineBase(root);
  // Always refresh before cutting a worktree: a stale origin/master base sent
  // an engine off to rebuild work that had already landed (2026-07-09, packs
  // one-click flight rebuilt the stars backend from a base two PRs behind).
  refreshRemoteRef(root, mainline);
  if (!upstream || !refExists(root, upstream)) return mainline;
  if (mainline === 'HEAD' || mainline === upstream) return upstream;
  // A launcher upstream that is behind the mainline is a stale cut point
  // (2026-07-05: a stale origin/task branch sent two flights into rebase
  // conflicts). Start from the mainline unless the upstream carries new work.
  refreshRemoteRef(root, upstream);
  const behind = runGit(['merge-base', '--is-ancestor', upstream, mainline], { cwd: root, check: false });
  return behind.status === 0 ? mainline : upstream;
}

function defaultShipTarget(root) {
  const branch = currentBranch(root);
  if (branch) {
    const configured = runGit(['config', '--get', `branch.${branch}.atris-base`], { cwd: root, check: false }).stdout.trim();
    if (configured && refExists(root, configured)) return configured;
  }
  const head = remoteHead(root);
  if (head && refExists(root, head)) return head;
  for (const candidate of ['origin/main', 'origin/master']) {
    if (refExists(root, candidate)) return candidate;
  }
  return 'HEAD';
}

function refreshRemoteRef(root, ref) {
  if (!ref.startsWith('origin/')) return;
  const remoteBranch = ref.slice('origin/'.length);
  const fetched = runGit(['fetch', 'origin', remoteBranch], { cwd: root, check: false, timeout: 5000 });
  return fetched.status === 0 ? '' : (gitFailureDetail(fetched) || 'fetch failed');
}

// Read the remote without updating the tracking ref or FETCH_HEAD. The old
// no-gate flow still owns its initial fetch and its merge-check base.
function readShipTarget(root, targetRef, localMode) {
  const target = `refs/heads/${baseBranchName(targetRef)}`;
  let oid;
  if (localMode) {
    const resolved = runGit(['rev-parse', '--verify', `${target}^{commit}`], { cwd: root, check: false });
    if (resolved.status !== 0) return { error: gitFailureDetail(resolved) || 'target branch is unavailable' };
    oid = resolved.stdout.trim();
  } else {
    const listed = runGit(['ls-remote', '--exit-code', 'origin', target], { cwd: root, check: false });
    if (listed.status !== 0) return { error: gitFailureDetail(listed) || 'target branch is unavailable' };
    const lines = listed.stdout.trim().split(/\r?\n/);
    const fields = lines[0].split(/\s+/);
    if (lines.length !== 1 || fields[1] !== target || !GIT_OID_PATTERN.test(fields[0])) {
      return { error: 'could not identify the target branch' };
    }
    oid = fields[0];
    const fetched = runGit(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', oid], { cwd: root, check: false });
    if (fetched.status !== 0) return { error: gitFailureDetail(fetched) || 'target fetch failed' };
  }
  const gate = runGit(['ls-tree', oid, '--', 'scripts/merge-gate.sh'], { cwd: root, check: false });
  if (gate.status !== 0) return { error: gitFailureDetail(gate) || 'could not read the target tree' };
  return { oid, gate: !!gate.stdout.trim() };
}

function baseBranchName(ref) {
  return String(ref || '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

function statusCounts(root, {
  ignoredUnstagedFiles = new Set(),
  ignoredUntrackedFiles = new Set(),
  ignoreUntracked = null,
  ignoreAny = null,
} = {}) {
  if (!fs.existsSync(root)) return null;
  // -uall expands untracked directories to individual files so ignoredUntrackedFiles
  // and ignoreUntracked can match exact paths (plain porcelain collapses them to "?? dir/").
  const expandUntracked = ignoredUntrackedFiles.size
    || typeof ignoreUntracked === 'function'
    || typeof ignoreAny === 'function';
  const statusArgs = expandUntracked ? ['status', '--porcelain', '-uall'] : ['status', '--porcelain'];
  const result = runGit(statusArgs, { cwd: root, check: false });
  if (result.status !== 0) return null;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const file = line.slice(3);
    if (typeof ignoreAny === 'function' && ignoreAny(file)) continue;
    if (ignoredUnstagedFiles.has(file) && line[0] === ' ' && line[1] !== ' ') continue;
    if (line.startsWith('??')) {
      if (ignoredUntrackedFiles.has(file)) continue;
      if (typeof ignoreUntracked === 'function' && ignoreUntracked(file)) continue;
      untracked += 1;
      continue;
    }
    if (line[0] !== ' ') staged += 1;
    if (line[1] !== ' ') unstaged += 1;
  }
  return { staged, unstaged, untracked };
}

// Remove conductor plumbing from the index after a broad `git add -A`, so the commit
// records engine output only. Paths that were never staged are simply not listed.
// GitHub refuses a merge with "Base branch was modified" when another PR
// merged into the same base a moment earlier; the same merge succeeds on a
// second try. On 2026-10-15 five parallel dispatches lost three landings to
// it. Retry only that message, a few times, with a short wait.
const BASE_MODIFIED_PATTERN = /Base branch was modified/i;
function mergePrWithRetry(mergeArgs, root, { run = spawnSync, wait = sleepSync, attempts = 4 } = {}) {
  let merged = run('gh', mergeArgs, { cwd: root, encoding: 'utf8' });
  for (let attempt = 1; attempt < attempts && merged.status !== 0
    && BASE_MODIFIED_PATTERN.test(`${merged.stderr || ''}${merged.stdout || ''}`); attempt += 1) {
    console.log(`merge: base branch moved, retrying (${attempt + 1}/${attempts})`);
    wait(1500 * attempt);
    merged = run('gh', mergeArgs, { cwd: root, encoding: 'utf8' });
  }
  return merged;
}

function unstageConductorArtifacts(root) {
  const staged = runGit(['diff', '--cached', '--name-only'], { cwd: root, check: false });
  if (staged.status !== 0) return [];
  const added = runGit(['diff', '--cached', '--name-only', '--diff-filter=A'], { cwd: root, check: false });
  const newFiles = new Set(String(added.stdout || '').split(/\r?\n/).filter(Boolean));
  // A file this commit would add under .atris/ is the tool's own state, never work.
  const drop = String(staged.stdout || '').split(/\r?\n/).filter(Boolean)
    .filter((file) => isConductorArtifact(file) || (newFiles.has(file) && isConductorUntracked(file)));
  if (drop.length) runGit(['reset', '-q', 'HEAD', '--', ...drop], { cwd: root, check: false });
  return drop;
}

function changedFiles(root, args) {
  const result = runGit([...args, '--', ...REGEN_ADAPTER_FILES], { cwd: root, check: false });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

function restoreRegeneratedAdapterChurn(root, message, { dryRun = false } = {}) {
  const unstaged = changedFiles(root, ['diff', '--name-only']);
  const staged = changedFiles(root, ['diff', '--cached', '--name-only']);
  const commitMessage = String(message || '');
  const skipped = REGEN_ADAPTER_FILES.filter(
    (file) => unstaged.has(file) && !staged.has(file) && !commitMessage.includes(file)
  );
  if (!skipped.length) return [];
  console.log(`ship: skipped regenerated adapter churn: ${skipped.join(', ')}`);
  if (!dryRun) runGit(['checkout', '--', ...skipped], { cwd: root });
  return skipped;
}

function swarloClaim(root, { channel, taskKey, content }) {
  const script = path.join(root, 'scripts', 'swarlo.py');
  if (!fs.existsSync(script)) return 'skip: scripts/swarlo.py not found';
  const result = spawnSync('python3', [script, 'claim', channel, taskKey, content], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status === 0) return output || `claimed ${taskKey}`;
  return `skip: swarlo claim failed: ${output || result.status}`;
}

function printStatus() {
  const root = repoRoot();
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  for (const wt of worktrees) {
    const counts = statusCounts(wt.path);
    const tags = [];
    if (wt.path === primary) tags.push('primary');
    if (path.resolve(wt.path) === path.resolve(root)) tags.push('current');
    const tagText = tags.length ? ` [${tags.join(' ')}]` : '';
    if (!counts) {
      console.log(`${wt.path}${tagText} branch=${wt.branch} missing=true`);
      continue;
    }
    console.log(`${wt.path}${tagText} branch=${wt.branch} staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
  }
}

// Programmatic core shared by `atris worktree start` and `atris mission start
// --worktree`: creates the branch + isolated checkout + identity sidecar and
// returns the facts. Throws on failure; callers own messaging and next steps.
//
// checkoutBase (what the branch is cut from) and shipBase (what `atris
// worktree ship` targets, recorded as branch.<branch>.atris-base) are kept
// separate on purpose. checkoutBase defaults to the launcher's own
// upstream/default remote base, so the agent starts from current work.
// shipBase defaults to the remote mainline for agent/member worktrees regardless of
// what branch the launcher happened to have checked out. recording the
// launcher's own feature branch as the ship target false-landed two PRs on
// 2026-07-04 (ship merged into the launcher's branch, never reached master).
// --base/--target still overrides both when the caller wants a different
// checkout point and ship target on purpose.
//
// spaceGuard and deps default to on outside temp folders: a low disk reaps
// finished copies across the workspace and then refuses (ATRIS_LOW_DISK),
// and a matching install is cloned in as node_modules. deps: false skips
// the clone; an object passes options through to seedNodeModules.
function createAgentWorktree({ root = repoRoot(), member = '', agent = '', task, formerTasks = [], branch: branchOverride, path: pathOverride, base: baseOverride, now = new Date(), env = process.env, freeSpace = space.freeBytes, spaceGuard, deps } = {}) {
  const owner = member || agent;
  if (!owner || !task) throw new Error('createAgentWorktree: owner (member/agent) and task required');
  // Pin the caller's flight base, or resolve it once for this new flight.
  const mainline = baseOverride || defaultMainlineBase(root);
  // Every new flight pays down completed checkout debt before adding another
  // full repo copy. Branches and commits survive worktree removal, while real
  // uncommitted changes remain protected by cleanupWorktrees.
  const cleanupBudget = { count: 0, kib: 0 };
  let reapedBeforeStart = [];
  let cachePrunedBeforeStart = [];
  try {
    const cleaned = cleanupWorktrees({ root, base: mainline, apply: true, by: 'atris worktree start', cleanupBudget });
    reapedBeforeStart = cleaned.removed;
    cachePrunedBeforeStart = cleaned.cachePruned;
  } catch {}
  let branch = branchOverride || branchName(owner, task, now);
  let target = path.resolve(pathOverride || defaultWorktreePath(root, owner, task, now));
  // Two runs of the same job in the same second get the same name; number
  // the later one instead of failing it.
  if (!pathOverride && !branchOverride) {
    const baseBranch = branch;
    const baseTarget = target;
    for (let n = 2; fs.existsSync(target) && n < 100; n += 1) {
      branch = `${baseBranch}-${n}`;
      target = `${baseTarget}-${n}`;
    }
  }
  // Agent/member worktrees always cut from the mainline: honoring the
  // launcher checkout's upstream let a dispatch inherit another session's
  // in-progress feature branch (2026-07-09: an auth fix arrived carrying 13
  // unpushed commits from a parallel session and could not merge).
  const checkoutBase = normalizeTargetRef(root, mainline);
  const shipBase = checkoutBase;
  if (fs.existsSync(target)) throw new Error(`worktree path already exists: ${target}`);
  // A full disk stops every flight at once. Reap first; refuse before cutting.
  const room = checkRoomForCopy({ root, target, freeSpace, env, spaceGuard, cleanupBudget });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staleBase = refreshRemoteRef(root, checkoutBase);
  // A retry of the same job starts from the last run's unlanded commits; it
  // still ships to the mainline.
  let resumedFrom = (!pathOverride && !branchOverride)
    ? lastRunBranch(root, owner, task, checkoutBase, branch)
    : null;
  // A last run that now conflicts with the mainline would hand its conflict
  // to the retry, which then cannot land on the first try. Start fresh; the
  // old branch keeps its commits.
  let skippedResume = null;
  if (resumedFrom && conflictsWithBase(root, checkoutBase, resumedFrom)) {
    skippedResume = resumedFrom;
    resumedFrom = null;
    console.error(`note: the last run's branch ${skippedResume} no longer merges cleanly with ${checkoutBase}, so this run starts fresh; that branch keeps its commits`);
  }
  // A display name is not an identity: it repeats across workspaces and changes when the task list
  // changes, so a branch under a job's older name is never a starting point and never blocks a
  // flight. It can still be this job's own unfinished work, so say where it is and leave the choice
  // to a person; this run goes on from the job's own name.
  const own = slugify(task, 'task', 36);
  for (const former of Array.isArray(formerTasks) ? formerTasks : [formerTasks]) {
    if (!former || !String(former).trim() || slugify(former, 'task', 36) === own) continue;
    const olderRun = lastRunBranch(root, owner, former, checkoutBase, branch);
    if (!olderRun) continue;
    console.error(`note: older unfinished work may be on ${olderRun}; ${resumedFrom ? `continuing from ${resumedFrom} instead` : 'starting fresh'}`);
    break;
  }
  const startPoint = resumedFrom || checkoutBase;
  const ref = `refs/heads/${branch}`;
  const existed = runGit(['show-ref', '--verify', '--quiet', ref], { cwd: root, check: false }).status !== 1;
  const baseCommit = runGit(['rev-parse', '--verify', `${startPoint}^{commit}`], { cwd: root, check: false });
  const startCommit = baseCommit.status === 0 ? baseCommit.stdout.trim() : '';
  // With no local copy the start fails on its own; only a real cut gets the warning.
  if (staleBase && startCommit) {
    console.error(`warning: could not refresh ${checkoutBase} (${staleBase.split('\n')[0]}); the new worktree starts from the local copy, which may be behind`);
  }
  const discardFailedStart = () => {
    if (existed || !startCommit) return;
    const registered = listWorktrees(root).find((wt) => wt.branch === branch);
    if (registered) {
      if (!fs.existsSync(target) || fs.realpathSync(registered.path) !== fs.realpathSync(target)
        || registered.head !== startCommit) return;
      const dirt = statusCounts(target, { ignoreUntracked: isConductorUntracked });
      if (!dirt || dirt.staged || dirt.unstaged || dirt.untracked) return;
      // No engine has started. Normal removal still refuses unexpected dirt.
      runGit(['worktree', 'remove', target], { cwd: root });
    }
    if (!fs.existsSync(target)) runGit(['update-ref', '-d', ref, startCommit], { cwd: root });
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const added = runGit(['worktree', 'add', '-b', branch, target, startPoint], { cwd: root, check: false });
    if (added.status === 0) break;
    // Git can create the branch before failing to write its tracking config.
    // Drop only that untouched ref, never an existing branch or a checkout.
    if (!/already exists|already used by worktree/i.test(added.stderr || '')) discardFailedStart();
    if (!configLocked(added) || attempt === 2) {
      throw new Error(String(added.stderr || added.stdout || 'worktree start failed').trim());
    }
    sleepSync(100 * (attempt + 1));
  }
  // A resumed branch takes in what the mainline gained since, or a job that
  // keeps resuming drifts further behind every run until it clashes
  // (2026-10-15: five long jobs sat 103 to 129 commits behind). The clash
  // check above proved this merge is clean; if git still refuses, the run
  // keeps the old start instead of failing.
  if (resumedFrom) {
    const caughtUp = runGit(['merge', '--no-edit', '-m', `Merge ${checkoutBase} into ${branch}`, checkoutBase], { cwd: target, check: false });
    if (caughtUp.status !== 0) runGit(['merge', '--abort'], { cwd: target, check: false });
  }
  try {
    runGit(['config', `branch.${branch}.atris-base`, shipBase], { cwd: target });
    runGit(['config', `branch.${branch}.atris-owner`, owner], { cwd: target });
    runGit(['config', `branch.${branch}.atris-task`, task], { cwd: target });
    fs.mkdirSync(path.join(target, '.atris'), { recursive: true });
    fs.writeFileSync(
      path.join(target, '.atris', 'agent-worktree.json'),
      JSON.stringify({
        agent: agent || null,
        member: member || null,
        owner,
        task,
        branch,
        base: shipBase,
        checkout_base: checkoutBase,
        resumed_from: resumedFrom,
        skipped_resume: skippedResume,
        workspace_root: root,
        created_at: now.toISOString(),
      }, null, 2) + '\n',
      'utf8'
    );
  } catch (error) {
    discardFailedStart();
    throw error;
  }
  const seedDeps = deps !== false && env.ATRIS_WORKTREE_NO_DEP_CLONE !== '1' && (deps ?? !space.isScratchPath(target));
  const depsResult = seedDeps ? seedCopyDeps({ root, target, options: deps && typeof deps === 'object' ? deps : {} }) : null;
  return { path: target, branch, base: shipBase, checkoutBase, resumedFrom, skippedResume, owner, reapedBeforeStart, cachePrunedBeforeStart, space: room, deps: depsResult };
}

// node_modules as a clone of a matching install (see lib/worktree-space.js),
// so a web copy costs 12 MB and 2 seconds instead of npm ci.
function seedCopyDeps({ root, target, options = {} }) {
  try {
    const primaryRoot = findPrimaryRoot(root);
    return space.seedNodeModules({
      target,
      workspace: path.dirname(primaryRoot),
      repoName: path.basename(primaryRoot),
      sources: [primaryRoot, ...listWorktrees(root).map((wt) => wt.path)],
      isIgnored: (dir) => runGit(['check-ignore', '-q', '--', 'node_modules/'], { cwd: dir, check: false }).status === 0,
      ...options,
    });
  } catch (error) {
    return { status: 'skipped', reason: `could not clone installs: ${String((error && error.message) || error)}` };
  }
}

// When the disk runs low, reaps finished copies of every repo in the
// workspace (merged, clean, nothing running inside, past the fresh-copy
// grace). Below the floor it refuses with ATRIS_LOW_DISK, before any copy
// is cut. Limits: ATRIS_WORKTREE_REAP_BELOW_GB, ATRIS_WORKTREE_MIN_FREE_GB.
// Even when the disk is low, a copy touched in the last ten minutes stays:
// the engine that just finished may still have its last message unread.
const LOW_DISK_IDLE_MS = 10 * 60 * 1000;

function ensureRoomForCopy({ root, target, freeSpace = space.freeBytes, env = process.env, by = 'atris worktree start', cleanupBudget = null }) {
  const limits = space.spaceLimits(env);
  const before = freeSpace(target);
  const room = { before, free: before, removed: [], cleared: [], ...limits };
  if (typeof before !== 'number' || !Number.isFinite(before)) return room;
  if (before >= limits.reapBelow && before >= limits.refuseBelow) return room;
  const swept = sweepWorkspace({ workspace: path.dirname(findPrimaryRoot(root)), apply: true, idleMs: LOW_DISK_IDLE_MS, freeSpace, by, cleanupBudget });
  for (const repo of swept.repos) {
    room.removed.push(...(repo.removed || []));
    room.cleared.push(...(repo.cachePruned || []));
  }
  const after = freeSpace(target);
  room.free = typeof after === 'number' && Number.isFinite(after) ? after : before;
  if (limits.refuseBelow > 0 && room.free < limits.refuseBelow) {
    const count = room.removed.length;
    const reaped = count
      ? `Removed ${count} finished build ${count === 1 ? 'copy' : 'copies'} first, and that was not enough.`
      : 'No finished build copies were safe to remove.';
    const error = new Error(
      `only ${space.formatGb(room.free)} free on this disk, and a new build copy needs at least ${space.formatGb(limits.refuseBelow)}. ${reaped} `
      + 'Free some space and retry; `atris worktree sweep` shows what is left, and ATRIS_WORKTREE_MIN_FREE_GB=0 skips this check.'
    );
    error.code = 'ATRIS_LOW_DISK';
    error.space = room;
    throw error;
  }
  return room;
}

// When the disk is checked before a copy is cut: spaceGuard says so, else anywhere but a temp folder.
function checkRoomForCopy({ root, target, freeSpace, env, spaceGuard, cleanupBudget = null }) {
  return (spaceGuard ?? !space.isScratchPath(target))
    ? ensureRoomForCopy({ root, target, freeSpace, env, cleanupBudget })
    : null;
}

// The question worktree start asks about the disk, asked on its own so a flight can ask it once before it
// claims anything: the same floor, the same reaping of finished copies, the same words. null when there is
// room, when the disk cannot be read, or when a copy would land in a temp folder. Otherwise the sentence
// worktree start would refuse with, and the numbers behind it. Any other trouble is left for worktree start
// to report when it runs. target names the folder the build will use when it is not worktree start's usual
// one (a sealed review sandbox is cut in the temp folder).
function lowDiskRefusal({ root = repoRoot(), member = '', agent = '', task = 'flight', now = new Date(), env = process.env, freeSpace = space.freeBytes, spaceGuard, target = '' } = {}) {
  try {
    checkRoomForCopy({ root, target: target ? path.resolve(target) : path.resolve(defaultWorktreePath(root, member || agent, task, now)), freeSpace, env, spaceGuard });
    return null;
  } catch (error) {
    if (!error || error.code !== 'ATRIS_LOW_DISK') return null;
    return { message: error.message, free: error.space.free, needs: error.space.refuseBelow };
  }
}

function startWorktree(args) {
  const root = repoRoot();
  const member = readFlag(args, '--member');
  const agent = readFlag(args, '--agent');
  const owner = member || agent;
  const task = readFlag(args, '--task');
  if (!owner || !task) {
    console.error('Usage: atris worktree start --member <member>|--agent <name> --task "<short task>" [--former-task "<older name of the task>"] [--claim] [--force] [--no-deps]');
    return 2;
  }
  // The task's older name, when it has gone by one. It is only mentioned: an unfinished branch under
  // it is named in one line, never resumed and never a collision (see createAgentWorktree).
  const formerTask = readFlag(args, '--former-task');
  const memberFile = member ? path.join(root, 'atris', 'team', member, 'MEMBER.md') : '';
  if (memberFile && !fs.existsSync(memberFile)) {
    console.error(`warning: no member persona at ${path.relative(root, memberFile)}`);
  }

  const force = hasFlag(args, '--force');
  const now = new Date();
  const flights = inFlightAgentFlights({ root, now });
  const active = flights.filter((flight) => flight.kind === 'worktree');
  const repoName = path.basename(findPrimaryRoot(root));
  console.log(`flights: ${active.length} active agent ${active.length === 1 ? 'worktree' : 'worktrees'} for ${repoName}`);
  const collisions = collidingFlights(flights, slugify(task, 'task', 36));
  if (collisions.length) {
    const label = force ? 'warning' : 'refusing';
    for (const flight of collisions) {
      console.error(`${label}: overlapping flight ${flight.name} (${describeFlightAge(flight, now.getTime())})`);
    }
    console.error(`${label}: another flight may already be doing this work`);
    if (!force) {
      console.error('refusing: pass --force to start anyway');
      return 2;
    }
  }

  let created;
  try {
    created = createAgentWorktree({
      root,
      member,
      agent,
      task,
      formerTasks: formerTask ? [formerTask] : [],
      branch: readFlag(args, '--branch'),
      path: readFlag(args, '--path'),
      base: readFlag(args, '--base') || readFlag(args, '--target'),
      ...(hasFlag(args, '--no-deps') ? { deps: false } : {}),
    });
  } catch (e) {
    console.error(`refusing: ${e.message}`);
    return 2;
  }
  const { path: target, branch, base } = created;

  if (created.reapedBeforeStart.length) {
    console.log(`cleanup: reaped ${created.reapedBeforeStart.length} completed ${created.reapedBeforeStart.length === 1 ? 'worktree' : 'worktrees'}`);
  }
  if (created.cachePrunedBeforeStart.length) {
    console.log(`cleanup: pruned ${created.cachePrunedBeforeStart.length} generated ${created.cachePrunedBeforeStart.length === 1 ? 'cache' : 'caches'}`);
  }
  if (created.space && created.space.removed.length) {
    const count = created.space.removed.length;
    console.log(`space: disk was low, removed ${count} finished build ${count === 1 ? 'copy' : 'copies'} across the workspace; ${space.formatGb(created.space.free)} free now`);
  } else if (created.space && created.space.free !== null && created.space.free < created.space.reapBelow) {
    console.log(`space: ${space.formatGb(created.space.free)} free; no finished build copies were safe to remove`);
  }
  if (created.deps && created.deps.status === 'cloned') {
    console.log(`deps: cloned node_modules from a matching install in ${(created.deps.ms / 1000).toFixed(1)}s; skip npm ci`);
  } else if (created.deps && created.deps.reason !== 'no package-lock.json') {
    console.log(`deps: ${created.deps.reason}`);
  }

  const counts = statusCounts(root);
  if (counts && (counts.staged || counts.unstaged || counts.untracked)) {
    console.log(`note: primary checkout is dirty staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
  }
  console.log(`path: ${target}`);
  console.log(`branch: ${branch}`);
  console.log(`${member ? 'member' : 'agent'}: ${owner}`);
  if (hasFlag(args, '--claim')) {
    const channel = readFlag(args, '--swarlo-channel', 'general');
    const taskKey = readFlag(args, '--swarlo-task-key') || `${slugify(owner, 'agent', 24)}-${slugify(task, 'task', 36)}`;
    const content = readFlag(args, '--swarlo-content') || `${owner} owns ${task} in ${target}`;
    console.log(`swarlo_channel: ${channel}`);
    console.log(`swarlo_claim: ${swarloClaim(target, { channel, taskKey, content })}`);
  }
  console.log(`base: ${base}`);
  console.log(`next: cd ${target}`);
  return 0;
}

function createOrFindPr(root, branch, targetRef, title, dryRun) {
  const targetBranch = baseBranchName(targetRef);
  // `gh pr view` (no --state filter) returns ANY PR for this branch name,
  // including one already MERGED or CLOSED. A worktree branch that ships
  // more than once (this same branch, more commits, another `worktree ship`)
  // would then reuse the dead PR number: `gh pr merge <dead pr> --merge`
  // exits 0 with just a warning (never fails), so the new commits silently
  // never land while the ship command still reports success. Only reuse a
  // PR that is still OPEN; anything else gets a fresh one.
  const existing = spawnSync('gh', ['pr', 'view', '--json', 'number,url,state', '--jq', '"\\(.number) \\(.url) \\(.state)"'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (existing.status === 0 && existing.stdout.trim()) {
    const parts = existing.stdout.trim().split(/\s+/);
    const state = parts.pop();
    if (state === 'OPEN') return parts.join(' ');
  }
  const body = [
    'Automated Atris worktree ship.',
    '',
    `Branch: ${branch}`,
    `Target: ${targetBranch}`,
  ].join('\n');
  if (dryRun) return `dry-run: gh pr create --base ${targetBranch} --head ${branch}`;
  // An engine that produced nothing leaves a branch level with its base. Asking
  // GitHub for a PR there fails with "No commits between ...", and that throw used
  // to escape the flight and abort the whole run. Say it plainly instead.
  const ahead = runGit(['rev-list', '--count', `${targetRef}..HEAD`], { cwd: root, check: false });
  if (ahead.status === 0 && String(ahead.stdout || '').trim() === '0') {
    console.log('pr: skipped (no commits ahead of base)');
    return '';
  }
  const created = spawnSync(
    'gh',
    ['pr', 'create', '--base', targetBranch, '--head', branch, '--title', title, '--body', body],
    { cwd: root, encoding: 'utf8' }
  );
  if (created.status !== 0) {
    throw new Error((created.stderr || created.stdout || 'gh pr create failed').trim());
  }
  return created.stdout.trim();
}

function prMergeRef(prOutput) {
  const text = String(prOutput || '').trim();
  if (!text || text.startsWith('dry-run:')) return '';
  return text.split(/\s+/)[0];
}

function shipHelp() {
  console.log('Usage: atris worktree ship --message "<commit>" --verify "<cmd>" [--merge] [--target <ref>] [--local]');
  console.log('');
  console.log('  --target <ref>  override the default landing target (default: branch atris-base, else origin default branch)');
  console.log('  --local         merge into the local primary checkout instead of pushing and opening a PR');
  console.log('  protected-lane tasks (billing, money, deploy, feedback, ...) can be pushed for review without --merge;');
  console.log('  landing one with --merge or --local needs --allow-denied-lane on written order');
  console.log('  gated merges verify the combined commit and fast-forward that exact commit to the target');
  console.log('  if the target moves, the check runs again before another landing attempt');
  console.log('  a landing stops before overwriting existing files, including ignored files');
  console.log('  a failed target read stops merging and makes review pushes check auto-merge');
  console.log('  local mode reads the local target without fetching it');
  console.log('  review pushes in gated repos refuse when a pull request has auto-merge on');
  console.log('  ATRIS_MERGE_GATE_TIMEOUT_MS sets its timeout in milliseconds (default 1800000)');
  console.log('  --no-map-refresh  skip the automatic refresh of moved map line references');
  console.log('  unstaged regenerated adapter files are skipped unless staged first or named in --message');
  console.log('  recommended flight verify: npm run test:fast && node --test <focused files>');
}

function deniedLaneForShip(root, branch, message) {
  try {
    const { protectedLaneOfTask } = require('../lib/fleet');
    const refs = new Set();
    for (const source of [String(branch || ''), String(message || '')]) {
      for (const m of source.toUpperCase().matchAll(/([A-Z]{2,6}-\d+)/g)) refs.add(m[1]);
      for (const m of source.toLowerCase().matchAll(/([a-z]{2,6})-(\d+)/g)) refs.add(`${m[1].toUpperCase()}-${m[2]}`);
    }
    // A flight's branch names its job by row id, lowercased, not by the display id a person reads
    // (flightTaskName in lib/fleet.js), so a branch also finds a job by its row id as a whole word.
    const words = new Set(String(branch || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const projectionPath = path.join(findPrimaryRoot(root), '.atris', 'state', 'tasks.projection.json');
    if (!fs.existsSync(projectionPath)) return null;
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    for (const task of projection.tasks || []) {
      const ids = [task.display_id, task.legacy_ref].filter(Boolean).map(v => String(v).toUpperCase());
      // Only a real row id counts: a short or odd one could match any word in a branch name.
      const rowId = typeof task.id === 'string' && /^[A-Za-z0-9]{16,}$/.test(task.id) ? task.id.toLowerCase() : '';
      if (!ids.some(id => refs.has(id)) && !(rowId && words.has(rowId))) continue;
      const hit = protectedLaneOfTask(task);
      if (hit) return { taskId: ids[0] || task.id, tag: hit };
    }
    return null;
  } catch {
    return null;
  }
}

// Pushing a protected-lane branch for review lands nothing, unless the branch
// already has a pull request with GitHub auto-merge on: that request merges
// itself the moment its checks pass, and the push is what feeds it. A branch
// that shipped earlier with --merge and was retagged into a protected lane since
// would land with no person. One branch can have several open pull requests (one
// per base), and a single push feeds every one of them, so this asks for the whole
// list: `gh pr view` shows just one, and it may be the one without auto-merge.
// Returns the words to refuse with, or '' when the push is safe. It fails closed:
// if gh cannot say, or the list may be incomplete, nothing is pushed.
const OPEN_PR_LIST_LIMIT = 100;

function protectedPushRefusal(root, branch, run = spawnSync) {
  const unknown = (why) => `blocked: cannot tell whether ${branch} has a pull request with auto-merge on (${why}); nothing was pushed`;
  // A minute is plenty for one lookup; a gh that hangs must not hang the ship.
  const listed = run('gh', [
    'pr', 'list', '--head', branch, '--state', 'open',
    '--json', 'number,url,baseRefName,autoMergeRequest',
    '--limit', String(OPEN_PR_LIST_LIMIT),
  ], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (listed.error) {
    return unknown(listed.error.code === 'ETIMEDOUT' ? 'gh took longer than a minute to answer' : `gh did not run: ${listed.error.message}`);
  }
  if (listed.status !== 0) {
    // No branch has an empty answer to read as "none": an empty list is an
    // exit 0, so a failed lookup is never taken for a clear.
    const said = `${listed.stderr || ''}\n${listed.stdout || ''}`;
    const firstLine = said.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return unknown(firstLine || `gh exited ${listed.status}`);
  }
  let open;
  try { open = JSON.parse(String(listed.stdout || '')); } catch { open = null; }
  // Every entry must say whether auto-merge is on (null means off), or the
  // answer is not one this check can lean on.
  const readable = Array.isArray(open)
    && open.every((pr) => pr && typeof pr === 'object' && !Array.isArray(pr) && Object.prototype.hasOwnProperty.call(pr, 'autoMergeRequest'));
  if (!readable) return unknown("gh's answer could not be read");
  // gh stops at its limit without saying so: a full page may be only part of the list.
  if (open.length >= OPEN_PR_LIST_LIMIT) return unknown(`${open.length} open pull requests may have been cut short`);
  const armed = open.filter((pr) => pr.autoMergeRequest);
  if (!armed.length) return '';
  const name = (pr) => `${pr.url || (pr.number ? `#${pr.number}` : branch)}${pr.baseRefName ? ` (into ${pr.baseRefName})` : ''}`;
  const off = (pr) => `gh pr merge ${pr.number || pr.url || branch} --disable-auto`;
  if (armed.length === 1) {
    return `blocked: pull request ${name(armed[0])} has auto-merge on, so pushing ${branch} would land it with no person; turn auto-merge off first (${off(armed[0])}), then ship again`;
  }
  const names = armed.map(name);
  return `blocked: pull requests ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} have auto-merge on, so pushing ${branch} would land them with no person; turn auto-merge off on each first (${armed.map(off).join(', ')}), then ship again`;
}

function findPrimaryRoot(root) {
  const worktrees = listWorktrees(root);
  return worktrees[0]?.path || root;
}

function shellQuote(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function experimentHealthProbe(statePath) {
  const script = [
    "const fs=require('fs')",
    'const state=JSON.parse(fs.readFileSync(process.argv[1],\'utf8\'))',
    'const last=Date.parse(state.last_run_date)',
    `process.exit(Number.isFinite(last)&&Date.now()-last<=${DAY_MS}?0:1)`,
  ].join(';');
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)} ${shellQuote(statePath)}`;
}

function runShipHealthCheck(workspaceRoot, options = {}) {
  try {
    const now = options.now ? new Date(options.now) : new Date();
    const statePath = path.join(workspaceRoot, '.atris', 'state', 'experiments-daily.json');
    const state = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
      : {};
    const rawLastRunDate = state && state.last_run_date;
    const lastRunMs = rawLastRunDate ? Date.parse(rawLastRunDate) : null;
    if (rawLastRunDate && !Number.isFinite(lastRunMs)) {
      throw new Error('experiment state date is unreadable');
    }

    const ageMs = Number.isFinite(lastRunMs) ? now.getTime() - lastRunMs : null;
    if (ageMs !== null && ageMs <= DAY_MS) return { healthy: true, filed: false };

    const days = ageMs === null ? 1 : Math.max(1, Math.floor(ageMs / DAY_MS));
    console.log(`health check failed: no verified experiment in ${days} days. shipping still works, the metabolism does not.`);
    const filed = close.upsertSourceFlag({
      what: 'no verified experiment has run in over a day',
      owner: 'operator',
      lane: 'code',
      ttlDays: 1,
      source: SHIP_HEALTH_SOURCE,
      closeCondition: 'a verified experiment ran within 24 hours',
      probe: experimentHealthProbe(statePath),
    }, workspaceRoot, { now });
    return { healthy: false, ...filed };
  } catch (error) {
    console.log(`health check skipped: ${String(error && error.message || error).toLowerCase()}. shipping still works.`);
    return { healthy: null, filed: false, error };
  }
}

const MAP_REFRESH_COMMIT_MESSAGE = 'Refresh map references that moved';
const MAP_REFRESH_TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

// Rewrites map line refs whose code moved (the same fix `atris doc-health
// --fix-refs` applies), then commits only the rewritten map files. A human-only
// remainder or an error never blocks the ship; pass --no-map-refresh to skip.
function refreshMovedMapRefs(root, args = []) {
  if (hasFlag(args, '--no-map-refresh')) return { skipped: true, refreshed: 0, left: 0 };
  try {
    const { changes, left } = fixMapDocs(root);
    if (changes.length) {
      const docs = [...new Set(changes.map(change => change.doc))];
      runGit(['add', '--', ...docs], { cwd: root });
      runGit(['commit', '-m', MAP_REFRESH_COMMIT_MESSAGE, '-m', MAP_REFRESH_TRAILER], { cwd: root });
      console.log(`map: refreshed ${changes.length} moved references`);
    } else {
      console.log('map: references current');
    }
    if (left.length) {
      console.log(`map: ${left.length} references need a human; run atris doc-health --fix-refs to see them`);
    }
    return { skipped: false, refreshed: changes.length, left: left.length };
  } catch (error) {
    const message = String((error && error.message) || error).toLowerCase().replace(/\s+/g, ' ').trim();
    console.log(`map: refresh skipped (${message}); the ship continues`);
    return { skipped: false, refreshed: 0, left: 0, error };
  }
}

// Read every open pull request so a candidate carries its title and we know
// which request must be confirmed after the checked commit reaches the target.
function candidatePullRequest(root, branch, targetBranch, localMode) {
  const remote = runGit(['remote', 'get-url', 'origin'], { cwd: root, check: false });
  if (localMode && remote.status !== 0) return { pr: null };
  const result = spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--limit', String(OPEN_PR_LIST_LIMIT),
    '--json', 'number,url,baseRefName,title,headRefName,headRepositoryOwner,headRefOid,autoMergeRequest'],
  { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) {
    if (localMode) return { pr: null };
    return { error: 'could not read open pull requests; branch was left unmerged' };
  }
  let list;
  try { list = JSON.parse(result.stdout); } catch { list = null; }
  if (!Array.isArray(list) || list.length >= OPEN_PR_LIST_LIMIT || list.some((pr) => !pr || typeof pr.baseRefName !== 'string')) {
    return { error: 'could not read all open pull requests; branch was left unmerged' };
  }
  const matches = list.filter((pr) => pr.baseRefName === targetBranch);
  if (matches.length > 1 || (matches[0] && (!matches[0].number || typeof matches[0].title !== 'string' || !GIT_OID_PATTERN.test(String(matches[0].headRefOid || ''))))) {
    return { error: 'could not identify the pull request and its title; branch was left unmerged' };
  }
  return { pr: matches[0] || null };
}

function candidateGateTail(output) {
  let tail = String(output || '').trimEnd().split(/\r?\n/).slice(-40).join('\n');
  if (Buffer.byteLength(tail) > 4096) {
    tail = Buffer.from(tail).subarray(-4096).toString('utf8');
    while (Buffer.byteLength(tail) > 4096) tail = tail.slice(1);
  }
  return tail;
}

// Only inspect paths Git will write, including obstructions in their parents.
// A directory replaced by a file is walked only as far as tracked entries; an
// untracked child stops the walk without scanning its contents.
function checkoutCollision(root, from, to) {
  const changed = runGit(['diff', '--name-only', '-z', '--no-renames', from, to, '--'],
    { cwd: root, check: false, maxBuffer: COMMAND_MAX_BUFFER_BYTES });
  if (changed.status !== 0) return { error: gitFailureDetail(changed) || 'could not inspect checkout paths' };
  const paths = changed.stdout.split('\0').filter(Boolean);
  if (!paths.length) return {};
  const oldFiles = new Set();
  const newFiles = new Set();
  // Keep command lines short even when a commit changes many files. A literal
  // pathspec also keeps names containing brackets or stars from matching others.
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const file of paths) {
    const size = Buffer.byteLength(file) + 1;
    if (batch.length && (batch.length >= 200 || bytes + size > 48000)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  for (const names of batches) {
    for (const [commit, files] of [[from, oldFiles], [to, newFiles]]) {
      const tree = runGit(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', commit, '--', ...names],
        { cwd: root, check: false, maxBuffer: COMMAND_MAX_BUFFER_BYTES });
      if (tree.status !== 0) return { error: gitFailureDetail(tree) || 'could not inspect checkout paths' };
      for (const file of tree.stdout.split('\0').filter(Boolean)) files.add(file);
    }
  }
  const oldDirs = new Set();
  for (const file of oldFiles) {
    const parts = file.split('/');
    for (let n = 1; n < parts.length; n += 1) oldDirs.add(parts.slice(0, n).join('/'));
  }
  const stat = (file) => {
    try { return fs.lstatSync(path.join(root, file)); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  const inspectDir = (dir) => {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const child = `${dir}/${name}`;
      const info = stat(child);
      if (!info) continue;
      if (info.isDirectory() && oldDirs.has(child)) {
        const found = inspectDir(child);
        if (found) return found;
      } else if (!oldFiles.has(child)) return child;
    }
    return '';
  };
  try {
    for (const file of paths.filter(name => newFiles.has(name))) {
      const parts = file.split('/');
      for (let n = 1; n <= parts.length; n += 1) {
        const part = parts.slice(0, n).join('/');
        const info = stat(part);
        if (!info) break;
        if (n < parts.length) {
          if (!info.isDirectory()) {
            const oldEntry = oldFiles.has(part) ? 'blob'
              : runGit(['cat-file', '-t', `${from}:${part}`], { cwd: root, check: false }).stdout.trim();
            if (oldEntry !== 'blob') return { path: part };
            break;
          }
        } else if (info.isDirectory()) {
          if (!oldDirs.has(part)) return { path: part };
          const found = inspectDir(part);
          if (found) return { path: found };
        } else if (!oldFiles.has(part)) return { path: part };
      }
    }
  } catch (error) {
    return { error: error.message };
  }
  return {};
}

function safeCheckout(root, from, to) {
  const collision = checkoutCollision(root, from, to);
  if (collision.path || collision.error) {
    console.error(`blocked: checkout would overwrite existing file ${collision.path || collision.error}; branch was left unmerged`);
    return false;
  }
  return true;
}

function checkCandidate(root, branch, candidate, verify, requireGate) {
  if (!safeCheckout(root, branch, candidate)) return false;
  const switched = runGit(['switch', '--detach', candidate], { cwd: root, check: false });
  if (switched.status !== 0) {
    console.error(`blocked: could not check the combined commit; branch was left unmerged: ${gitFailureDetail(switched)}`);
    return false;
  }
  let passed = false;
  const snapshot = () => runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }).stdout
    .split(/\r?\n/).filter(Boolean);
  const fingerprint = (rows) => new Map(rows.filter((row) => row.startsWith('?? ') && isConductorUntracked(row.slice(3)))
    .map((row) => {
      const file = row.slice(3);
      const target = path.join(root, file);
      const data = fs.lstatSync(target).isSymbolicLink() ? fs.readlinkSync(target) : fs.readFileSync(target);
      return [row, crypto.createHash('sha256').update(data).digest('hex')];
    }));
  const changesSince = (before, fingerprints, after) => {
    const current = fingerprint(after);
    const dirty = after.filter((row) => !row.startsWith('?? ') || !isConductorUntracked(row.slice(3)));
    return [...new Set([...dirty, ...newStatusRows(before, after),
      ...before.filter((row) => fingerprints.has(row) && fingerprints.get(row) !== current.get(row))])];
  };
  try {
    const beforeVerify = snapshot();
    const verifyFingerprints = fingerprint(beforeVerify);
    if (verify) {
      console.log(`verify: ${verify}`);
      const result = runCommand(verify, { cwd: root, check: false });
      if (result.status !== 0) {
        console.error(`verify failed: exit code ${result.status === null ? 'unavailable' : result.status}; branch was left unmerged`);
        const tail = candidateGateTail(`${result.stdout || ''}${result.stderr || ''}`);
        if (tail) console.error(tail);
        return false;
      }
    } else {
      console.log('verify: skipped (no --verify)');
    }
    const afterVerify = snapshot();
    const verifyChanges = changesSince(beforeVerify, verifyFingerprints, afterVerify);
    if (verifyChanges.length || runGit(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim() !== candidate) {
      console.error(`blocked: verifier changed the combined commit or files: ${verifyChanges.join(', ')}; branch was left unmerged`);
      return false;
    }
    const gatePath = path.join(root, 'scripts', 'merge-gate.sh');
    const declared = runGit(['ls-tree', candidate, '--', 'scripts/merge-gate.sh'], { cwd: root, check: false });
    if (!fs.existsSync(gatePath) || declared.status !== 0 || !/^(100644|100755|120000) blob /m.test(declared.stdout)) {
      console.error(`blocked: ${requireGate ? 'the target merge gate is missing from the combined commit' : 'the merge gate is missing from the combined commit'}; branch was left unmerged`);
      return false;
    }
    const realGate = fs.realpathSync(gatePath);
    const realRoot = fs.realpathSync(root);
    const gateRelative = path.relative(realRoot, realGate);
    if (!gateRelative || gateRelative === '..' || gateRelative.startsWith(`..${path.sep}`) || path.isAbsolute(gateRelative)) {
      console.error('blocked: the merge gate points outside the checked repository; branch was left unmerged');
      return false;
    }
    const actual = runGit(['ls-tree', candidate, '--', gateRelative], { cwd: root, check: false });
    if (actual.status !== 0 || !/^(100644|100755) blob /m.test(actual.stdout)) {
      console.error('blocked: the merge gate file is not in the combined commit; branch was left unmerged');
      return false;
    }
    const gateFingerprints = fingerprint(afterVerify);
    const result = runMergeGate(root, gatePath);
    const changed = changesSince(afterVerify, gateFingerprints, snapshot());
    const head = runGit(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    if (head !== candidate) {
      const files = runGit(['diff', '--name-only', candidate, head], { cwd: root, check: false });
      changed.push(...String(files.stdout || '').split(/\r?\n/).filter(Boolean));
    }
    if (result.code !== 0 || result.timedOut || result.error || changed.length || head !== candidate) {
      const code = result.code === null ? (result.timedOut ? '124' : 'unavailable') : String(result.code);
      console.error(`merge gate failed: scripts/merge-gate.sh, exit code ${code}${result.timedOut ? ' (timed out)' : ''}`);
      if (result.error) console.error(result.error);
      const tail = candidateGateTail(result.output);
      if (tail) console.error(tail);
      if (changed.length) console.error(`merge gate changed files: ${changed.join(', ')}`);
      if (head !== candidate) console.error('merge gate changed the commit');
      console.error('branch was left unmerged');
      return false;
    }
    console.log('merge gate: passed');
    passed = true;
  } finally {
    const checkedHead = runGit(['rev-parse', 'HEAD'], { cwd: root, check: false }).stdout.trim();
    if (checkedHead !== candidate) {
      console.error('blocked: the check changed the commit; its files were kept and the branch was left unmerged');
      passed = false;
    } else {
      const restored = safeCheckout(root, candidate, branch)
        ? runGit(['switch', branch], { cwd: root, check: false }) : { status: 1, stderr: 'existing files were kept' };
      if (restored.status !== 0) {
        console.error(`blocked: could not return to the branch; changes were kept and the branch was left unmerged: ${gitFailureDetail(restored)}`);
        passed = false;
      }
    }
  }
  return passed;
}

function shipGatedCandidate({ root, primary, branch, targetRef, localMode, verify, gateOnTarget }) {
  const targetBranch = baseBranchName(targetRef);
  const target = `refs/heads/${targetBranch}`;
  const valid = runGit(['check-ref-format', '--branch', targetBranch], { cwd: root, check: false });
  if (valid.status !== 0 || targetBranch === 'HEAD') {
    console.error('blocked: the landing target must be a branch; branch was left unmerged');
    return 3;
  }
  const source = runGit(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const review = candidatePullRequest(root, branch, targetBranch, localMode);
  if (review.error) { console.error(`blocked: ${review.error}`); return 3; }
  const pr = review.pr;
  const owner = pr && pr.headRepositoryOwner && pr.headRepositoryOwner.login;
  const title = pr ? `Merge pull request #${pr.number} from ${owner ? `${owner}/` : ''}${pr.headRefName || branch}\n\n${pr.title}` : `Merge ${branch}`;
  if (pr && pr.headRefOid) {
    const contained = runGit(['merge-base', '--is-ancestor', pr.headRefOid, source], { cwd: root, check: false });
    if (contained.status !== 0) {
      console.error('blocked: the pull request head is not in this branch; branch was left unmerged');
      return 3;
    }
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const latest = readShipTarget(root, targetRef, localMode);
    if (latest.error) {
      console.error(`blocked: could not read the target; branch was left unmerged: ${latest.error}`);
      return 3;
    }
    const base = latest.oid;
    const tree = runGit(['merge-tree', '--write-tree', base, source], { cwd: root, check: false });
    if (tree.status !== 0) {
      console.error(`blocked: branch does not merge cleanly into ${targetBranch}; branch was left unmerged`);
      console.error((tree.stderr || tree.stdout || '').trim());
      return 3;
    }
    const treeId = String(tree.stdout || '').split(/\r?\n/)[0].trim();
    if (!GIT_OID_PATTERN.test(treeId)) { console.error('blocked: could not build the combined tree; branch was left unmerged'); return 3; }
    const made = runGit(['commit-tree', treeId, '-p', base, '-p', source, '-m', title], { cwd: root, check: false });
    if (made.status !== 0) { console.error(`blocked: could not build the combined commit; branch was left unmerged: ${gitFailureDetail(made)}`); return 3; }
    const candidate = made.stdout.trim();
    if (!checkCandidate(root, branch, candidate, verify, gateOnTarget)) return 3;
    if (runGit(['rev-parse', `refs/heads/${branch}`], { cwd: root }).stdout.trim() !== source) {
      console.error('blocked: the branch moved during the check; branch was left unmerged');
      return 3;
    }
    if (pr) {
      const latest = spawnSync('gh', ['pr', 'view', String(pr.number), '--json', 'state,headRefOid,title,baseRefName'],
        { cwd: root, encoding: 'utf8', timeout: 60000 });
      let current = null;
      try { if (latest.status === 0) current = JSON.parse(latest.stdout); } catch {}
      if (!current || current.state !== 'OPEN' || current.headRefOid !== pr.headRefOid
        || current.title !== pr.title || current.baseRefName !== pr.baseRefName) {
        console.error('blocked: the pull request changed during the check; branch was left unmerged');
        return 3;
      }
    }
    if (localMode) {
      const currentTarget = runGit(['rev-parse', '--verify', target], { cwd: root, check: false });
      if (currentTarget.status !== 0) {
        console.error('blocked: could not read the target; branch was left unmerged');
        return 3;
      }
      if (currentTarget.stdout.trim() !== base) {
        console.log(`merge: target moved, checking again (${attempt}/3)`);
        continue;
      }
      const status = statusCounts(primary, { ignoreUntracked: isConductorUntracked });
      if (!status || status.staged || status.unstaged || status.untracked) {
        console.error('blocked: the primary checkout has changes; branch was left unmerged');
        return 3;
      }
      const primaryHead = runGit(['rev-parse', 'HEAD'], { cwd: primary }).stdout.trim();
      if (!safeCheckout(primary, primaryHead, base) || !safeCheckout(primary, primaryHead, candidate)) return 3;
      if (currentBranch(primary) !== targetBranch) {
        const switched = runGit(['switch', targetBranch], { cwd: primary, check: false });
        if (switched.status !== 0) {
          console.error(`blocked: could not switch the primary checkout to the target; branch was left unmerged: ${gitFailureDetail(switched)}`);
          return 3;
        }
      }
      const preview = runGit(['read-tree', '-n', '-m', '-u', base, candidate], { cwd: primary, check: false });
      if (preview.status !== 0) { console.error(`blocked: could not update the primary checkout; branch was left unmerged: ${gitFailureDetail(preview)}`); return 3; }
      const updated = runGit(['update-ref', target, candidate, base], { cwd: primary, check: false });
      if (updated.status !== 0) {
        if (runGit(['rev-parse', target], { cwd: root }).stdout.trim() !== base) {
          console.log(`merge: target moved, checking again (${attempt}/3)`);
          continue;
        }
        console.error(`blocked: could not update the target; branch was left unmerged: ${gitFailureDetail(updated)}`);
        return 3;
      }
      const checkout = runGit(['read-tree', '-m', '-u', base, candidate], { cwd: primary, check: false });
      if (checkout.status !== 0) {
        console.error(`blocked: the checked commit landed but the primary checkout could not be updated: ${gitFailureDetail(checkout)}`);
        return 3;
      }
      console.log('push: skipped (local mode)');
      console.log('merge: merged (local mode)');
      console.log('pr: skipped (local mode)');
      runShipHealthCheck(primary);
      announceShippedCopyRemoval(scheduleShippedCopyRemoval({ root, primary, branch, base: target }));
      console.log('done: worktree shipped');
      return 0;
    }
    console.log(`push: checked commit to ${targetBranch}`);
    const pushed = checkedPush({ root, candidate, target, base, sourceRef: `refs/heads/${branch}`, sourceOid: source, env: gitNetworkEnvironment(process.env, root), timeout: GIT_PUSH_TIMEOUT_MS });
    if (pushed.status !== 0) {
      const latest = runGit(['ls-remote', 'origin', target], { cwd: root, check: false });
      const latestId = String(latest.stdout || '').trim().split(/\s+/)[0];
      if (latest.status === 0 && GIT_OID_PATTERN.test(latestId) && latestId !== base) {
        console.log(`merge: target moved, checking again (${attempt}/3)`);
        continue;
      }
      console.error(`blocked: checked commit could not be pushed; branch was left unmerged: ${gitFailureDetail(pushed)}`);
      return 3;
    }
    if (pr) {
      let state = null;
      for (let check = 0; check < 5; check += 1) {
        const confirmation = spawnSync('gh', ['pr', 'view', String(pr.number), '--json', 'state,mergedAt,number,url,mergeCommit'], { cwd: root, encoding: 'utf8', timeout: 60000 });
        try { if (confirmation.status === 0) state = JSON.parse(confirmation.stdout); } catch { state = null; }
        if (state && state.state === 'MERGED' && state.mergedAt) break;
        if (check < 4) sleepSync(1000);
      }
      if (!state || state.state !== 'MERGED' || !state.mergedAt) {
        console.error('checked commit landed, but the pull request could not be confirmed; the source branch was kept');
        return 3;
      }
      console.log('merge: merged');
      const record = shipMergeRecord(state);
      if (record) console.log(`merge: record ${JSON.stringify(record)}`);
      const remoteHead = runGit(['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: root, check: false });
      const oldHead = String(remoteHead.stdout || '').trim().split(/\s+/)[0];
      if (remoteHead.status === 0 && oldHead && (!pr.headRefOid || oldHead === pr.headRefOid)) {
        const deleted = checkedPush({ root, candidate: '', target: `refs/heads/${branch}`, base: oldHead, sourceRef: `refs/heads/${branch}`, sourceOid: source, env: gitNetworkEnvironment(process.env, root), timeout: GIT_PUSH_TIMEOUT_MS });
        if (deleted.status === 0) console.log(`merge: remote branch deleted ${branch}`);
        else console.log(`merge: remote branch delete skipped: ${gitFailureDetail(deleted)}`);
      }
    } else {
      console.log('merge: merged');
      console.log('pr: skipped (no open pull request)');
    }
    runShipHealthCheck(primary || root);
    announceShippedCopyRemoval(scheduleShippedCopyRemoval({ root, primary, branch, base: targetRef }));
    console.log('done: worktree shipped');
    return 0;
  }
  console.error('blocked: the target kept moving; branch was left unmerged');
  return 3;
}

function shipWorktree(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    shipHelp();
    return 0;
  }
  const root = repoRoot();
  const dryRun = hasFlag(args, '--dry-run');
  const noPr = hasFlag(args, '--no-pr');
  const localMode = hasFlag(args, '--local') || hasFlag(args, '--local-merge');
  const merge = hasFlag(args, '--merge');
  const message = readFlag(args, '--message') || readFlag(args, '-m');
  const verify = readFlag(args, '--verify');
  let branch = currentBranch(root);
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  const targetRef = normalizeTargetRef(root, readFlag(args, '--target') || defaultShipTarget(root));

  if (!branch && path.resolve(root) === path.resolve(primary)) {
    console.error('blocked: detached head on the primary checkout');
    return 2;
  }
  if (!branch) {
    branch = detachedShipBranch(root);
    if (!createDetachedShipBranch(root, branch)) return 2;
  }
  if (branch === 'master' || branch === 'main') {
    console.error('blocked: ship from a feature worktree branch, not master/main');
    return 2;
  }
  if (path.resolve(root) === path.resolve(primary) && !hasFlag(args, '--allow-primary')) {
    console.error('blocked: ship from an isolated worktree, not the primary checkout');
    return 2;
  }
  // Denied lanes are checked at dispatch, but a flight that was staffed
  // before a task entered a denied lane (or killed mid-flight) could still
  // ship: a payments command self-landed twice this way on 2026-07-26. The
  // ship gate is the last door, so it re-checks. It guards landing only:
  // pushing the branch and opening a pull request lands nothing, and that is
  // how protected work reaches a person to review. The one exception is a
  // pull request that already has auto-merge on, which a push would feed.
  if (!hasFlag(args, '--allow-denied-lane')) {
    const denied = deniedLaneForShip(root, branch, message);
    if (denied && (merge || localMode)) {
      console.error(`blocked: this branch carries ${denied.taskId} which sits in the protected ${denied.tag} lane; a human lands it (or pass --allow-denied-lane on written order)`);
      return 2;
    }
    const refusal = denied ? protectedPushRefusal(root, branch) : '';
    if (refusal) {
      console.error(refusal);
      return 2;
    }
  }

  let oneLapProof = null;
  try {
    oneLapProof = readOneLapProofBinding(root, branch);
  } catch (error) {
    console.error(`blocked: ${error.message}`);
    return 3;
  }
  const proofTreeMatches = (source) => {
    try {
      assertOneLapProofTree(root, oneLapProof, source);
      return true;
    } catch (error) {
      console.error(`blocked: ${error.message}`);
      return false;
    }
  };

  // Local shipping keeps the legacy refresh, but reads its gate from the local target.
  if (localMode) refreshRemoteRef(root, targetRef);
  const initialTarget = dryRun ? null : readShipTarget(root, targetRef, localMode);
  const branchHasGate = fs.existsSync(path.join(root, 'scripts', 'merge-gate.sh'));
  if (!localMode && (dryRun || (initialTarget && !initialTarget.error && !initialTarget.gate && !branchHasGate))) {
    refreshRemoteRef(root, targetRef);
  }
  const skippedAdapters = restoreRegeneratedAdapterChurn(root, message, { dryRun });
  const ignoredUnstagedFiles = dryRun ? new Set(skippedAdapters) : new Set();
  // Conductor plumbing must not make the checkout look dirty, or a flight where the
  // engine wrote nothing commits the fleet's own prompt file and calls it work.
  const counts = statusCounts(root, { ignoredUnstagedFiles, ignoreUntracked: isConductorUntracked })
    || { staged: 0, unstaged: 0, untracked: 0 };
  const dirty = counts.staged || counts.unstaged || counts.untracked;
  if (dirty && !message) {
    console.error('blocked: --message is required when there are local changes to commit');
    return 2;
  }

  if (dirty) {
    console.log(`commit: ${message}`);
    if (!dryRun) {
      runGit(['add', '-A'], { cwd: root });
      // `add -A` sweeps in the fleet's own prompt file and friends. Drop them from the
      // index so a work commit carries work, not harness plumbing. Safe when absent.
      unstageConductorArtifacts(root);
      if (!proofTreeMatches('index')) return 3;
      runGit(['commit', '-m', message], { cwd: root });
      if (!proofTreeMatches('head')) return 3;
    }
  } else {
    console.log('commit: skipped (no local changes)');
    if (!dryRun && !proofTreeMatches('head')) return 3;
  }

  if (dryRun) {
    console.log('map: skipped (dry-run)');
  } else {
    refreshMovedMapRefs(root, args);
  }

  let targetRead = dryRun ? null : readShipTarget(root, targetRef, localMode);
  let gateOnTarget = !!(targetRead && targetRead.gate);
  const committedGate = !dryRun && runGit(['cat-file', '-e', 'HEAD:scripts/merge-gate.sh'], { cwd: root, check: false }).status === 0;
  const gated = !dryRun && (gateOnTarget || committedGate || branchHasGate || targetRead.error);
  if (targetRead && targetRead.error && (merge || localMode)) {
    console.error(`blocked: could not read the target; branch was left unmerged: ${targetRead.error}`);
    return 3;
  }
  if (gated && !merge && !localMode) {
    const refusal = protectedPushRefusal(root, branch);
    if (refusal) {
      console.error(`${refusal}; or use --merge to run the gate`);
      return 2;
    }
  }
  if (gated && (merge || localMode)) {
    if (!proofTreeMatches('head')) return 3;
    return shipGatedCandidate({ root, primary, branch, targetRef, localMode, verify, gateOnTarget });
  }

  if (verify) {
    const beforeVerify = dryRun ? [] : statusSnapshot(root);
    console.log(`verify: ${verify}`);
    if (!dryRun) runCommand(verify, { cwd: root });
    const afterVerifyRows = dryRun ? [] : statusSnapshot(root);
    const verifyDelta = newStatusRows(beforeVerify, afterVerifyRows);
    // This check exists to catch a verifier that writes files. Conductor plumbing was
    // already present before the verifier ran, so counting it here blocks a clean ship.
    const afterVerify = dryRun
      ? { staged: 0, unstaged: 0, untracked: 0 }
      : statusCounts(root, { ignoreUntracked: isConductorUntracked })
        || { staged: 0, unstaged: 0, untracked: 0 };
    if (!dryRun && (afterVerify.staged || afterVerify.unstaged || afterVerify.untracked)) {
      console.error(
        `blocked: verifier left checkout dirty staged=${afterVerify.staged} ` +
          `unstaged=${afterVerify.unstaged} untracked=${afterVerify.untracked}`
      );
      if (verifyDelta.length) {
        console.error(`new after verify: ${verifyDelta.slice(0, 8).join(', ')}`);
      }
      return 3;
    }
    if (!dryRun && !proofTreeMatches('head')) return 3;
  } else {
    console.log('verify: skipped (no --verify)');
  }

  // A target may gain its gate while the original verification is running.
  // Recheck before any push and, if needed, verify the combined commit too.
  if (!dryRun && !gated) {
    targetRead = readShipTarget(root, targetRef, localMode);
    gateOnTarget = !!targetRead.gate;
    if (targetRead.error && (merge || localMode)) {
      console.error(`blocked: could not read the target; branch was left unmerged: ${targetRead.error}`);
      return 3;
    }
    const branchNowHasGate = fs.existsSync(path.join(root, 'scripts', 'merge-gate.sh'))
      || runGit(['cat-file', '-e', 'HEAD:scripts/merge-gate.sh'], { cwd: root, check: false }).status === 0;
    if (gateOnTarget || branchNowHasGate || targetRead.error) {
      if (merge || localMode) {
        if (!proofTreeMatches('head')) return 3;
        return shipGatedCandidate({ root, primary, branch, targetRef, localMode, verify, gateOnTarget });
      }
      const refusal = protectedPushRefusal(root, branch);
      if (refusal) {
        console.error(`${refusal}; or use --merge to run the gate`);
        return 2;
      }
    }
  }

  const mergeCheck = dryRun
    ? { status: 0, stdout: 'dry-run' }
    : runGit(['merge-tree', '--write-tree', targetRef, 'HEAD'], { cwd: root, check: false });
  if (mergeCheck.status !== 0) {
    console.error(`blocked: branch does not merge cleanly into ${targetRef}`);
    console.error((mergeCheck.stderr || mergeCheck.stdout || '').trim());
    return 3;
  }
  console.log(`merge_check: ${targetRef} clean`);

  // Set once the change is confirmed merged; the build copy then goes away.
  let landedOn = '';
  if (localMode) {
    console.log('push: skipped (local mode)');
    if (merge) {
      console.log('merge: requested (local mode)');
      if (!dryRun) {
        const targetBranch = baseBranchName(targetRef);
        const primaryBranch = currentBranch(primary);
        if (primaryBranch !== targetBranch) {
          const switched = runGit(['switch', targetBranch], { cwd: primary, check: false });
          if (switched.status !== 0) {
            throw new Error((switched.stderr || switched.stdout || `git switch ${targetBranch} failed`).trim());
          }
        }
        const primaryCounts = statusCounts(primary, { ignoreUntracked: isConductorUntracked }) || { staged: 0, unstaged: 0, untracked: 0 };
        if (primaryCounts.staged || primaryCounts.unstaged || primaryCounts.untracked) {
          throw new Error(
            `primary checkout dirty staged=${primaryCounts.staged} ` +
            `unstaged=${primaryCounts.unstaged} untracked=${primaryCounts.untracked}`
          );
        }
        runGit(['merge', '--no-ff', branch, '-m', `Merge ${branch}`], { cwd: primary });
        console.log('merge: merged (local mode)');
        landedOn = `refs/heads/${targetBranch}`;
      }
    }
    console.log('pr: skipped (local mode)');
    if (merge && !dryRun) runShipHealthCheck(primary || root);
    if (landedOn) announceShippedCopyRemoval(scheduleShippedCopyRemoval({ root, primary, branch, base: landedOn }));
    console.log('done: worktree shipped');
    return 0;
  }

  console.log(`push: origin ${branch}`);
  if (!dryRun) runGit(['push', '-u', 'origin', branch], { cwd: root });

  if (!noPr || merge) {
    const title = message || branch;
    const pr = createOrFindPr(root, branch, targetRef, title, dryRun);
    console.log(`pr: ${pr}`);
    if (merge) {
      console.log('merge: requested');
      if (!dryRun) {
        const mergeRef = prMergeRef(pr);
        const mergeArgs = ['pr', 'merge'];
        if (mergeRef) mergeArgs.push(mergeRef);
        mergeArgs.push('--merge');
        const merged = mergePrWithRetry(mergeArgs, root);
        if (merged.status !== 0) throw new Error((merged.stderr || merged.stdout || 'gh pr merge failed').trim());
        // `gh pr merge` on an already-merged PR exits 0 with a warning
        // instead of failing, which would otherwise report a false landing.
        if (/already merged/i.test(`${merged.stdout}${merged.stderr}`)) {
          throw new Error(`gh pr merge reported the PR was already merged (stale PR reused): ${(merged.stdout || merged.stderr).trim()}`);
        }
        // A merge queue accepts the request before merging. Deleting its head
        // here closes the PR and cancels that request, so confirm the outcome.
        const confirmation = spawnSync('gh', ['pr', 'view', mergeRef, '--json', 'state,mergedAt,number,url,mergeCommit'], { cwd: root, encoding: 'utf8' });
        if (confirmation.status !== 0) {
          throw new Error('could not confirm the merge; the source branch was kept');
        }
        let state;
        try { state = JSON.parse(confirmation.stdout); } catch {
          throw new Error('could not read the merge result; the source branch was kept');
        }
        if (state.state === 'OPEN' && !state.mergedAt) {
          console.log('merge: pending; kept the source branch while required checks finish');
          return 0;
        }
        if (state.state !== 'MERGED' || !state.mergedAt) {
          throw new Error('the change was not merged; the source branch was kept');
        }
        console.log('merge: merged');
        // One machine-readable line, so a caller can save which pull request
        // and commit landed. The rating only counts a landing it can point at.
        const record = shipMergeRecord(state);
        if (record) console.log(`merge: record ${JSON.stringify(record)}`);
        landedOn = targetRef;
        const deleted = runGit(['push', 'origin', '--delete', branch], { cwd: root, check: false });
        if (deleted.status === 0) {
          console.log(`merge: remote branch deleted ${branch}`);
        } else {
          const deleteOutput = (deleted.stderr || deleted.stdout || 'remote branch delete failed').trim();
          console.log(`merge: remote branch delete skipped: ${deleteOutput}`);
        }
      }
    }
  } else {
    console.log('pr: skipped (--no-pr)');
  }

  try {
    stampLatestOpenBriefForWorktree(root, {
      result: 'pass',
      note: `worktree ship completed into ${targetRef}`,
    }, { worktree: root });
  } catch {}
  if (merge && !dryRun) runShipHealthCheck(primary || root);
  if (landedOn) announceShippedCopyRemoval(scheduleShippedCopyRemoval({ root, primary, branch, base: landedOn }));
  console.log('done: worktree shipped');
  return 0;
}

// A shipped build copy is dead weight, but the engine that shipped it is
// still inside and writes its last message there on exit. A detached
// `atris worktree reap-shipped` waits until nothing has run in the copy for
// SHIP_SETTLE_MS, then removes it if it is still merged and clean.
const SHIP_SETTLE_MS = 10 * 60 * 1000;
const SHIP_REAP_POLL_MS = 60 * 1000;
const SHIP_REAP_GIVE_UP_MS = 6 * 60 * 60 * 1000;
// Right after a merge the local copy of the target can lag; allow a short
// wait before treating the copy as unmerged and leaving it for the sweep.
const SHIP_REAP_UNMERGED_GRACE_MS = 15 * 60 * 1000;
// Reasons that can clear on their own: someone is still inside, or the
// main branch moved or could not be reached during the check.
const SHIP_REAP_RETRY_REASONS = new Set([
  'active_process', 'process_scan_failed', 'recent_activity', 'base_refresh_failed', 'base_unverified',
  'ignored_scan_failed', 'changed_or_active_during_verification',
]);

function shippedCopyRemovalPlan({ root, primary, env = process.env, atrisBin = ATRIS_BIN }) {
  const copy = path.resolve(root);
  if (env.ATRIS_WORKTREE_KEEP_AFTER_SHIP === '1') return { skip: 'ATRIS_WORKTREE_KEEP_AFTER_SHIP=1', announce: true };
  if (!primary || canonicalPath(copy) === canonicalPath(primary)) return { skip: 'primary checkout' };
  if (!space.isAgentCopyPath(copy)) return { skip: 'not an agent build copy' };
  if (space.isScratchPath(copy)) return { skip: 'temp folder' };
  // The removal runs this same atris; one that lives in the copy would delete itself.
  if (space.isInside(atrisBin, copy)) return { skip: 'this atris runs from inside the copy', announce: true };
  return { copy };
}

function scheduleShippedCopyRemoval({ root, primary, branch, base, env = process.env, spawnProcess = spawn }) {
  const plan = shippedCopyRemovalPlan({ root, primary, env });
  if (plan.skip) return plan;
  try {
    // The copy rides in the environment, not the arguments, so the process
    // scan does not count this waiter as someone working in the copy.
    const child = spawnProcess(process.execPath, [ATRIS_BIN, 'worktree', 'reap-shipped'], {
      cwd: primary,
      detached: true,
      stdio: 'ignore',
      env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_REAP_WORKTREE: plan.copy, ATRIS_REAP_BRANCH: branch || '', ATRIS_REAP_BASE: base || '' },
    });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return { ...plan, scheduled: true };
  } catch (error) {
    return { skip: `could not start the removal: ${String((error && error.message) || error)}`, announce: true };
  }
}

function announceShippedCopyRemoval(plan) {
  if (plan.scheduled) {
    console.log(`cleanup: this build copy is removed once nothing has run in it for ${Math.round(SHIP_SETTLE_MS / 60000)} minutes`);
  } else if (plan.announce) {
    console.log(`cleanup: kept this build copy (${plan.skip})`);
  }
}

function reapShippedCopy({
  root,
  target,
  base = '',
  settleMs = SHIP_SETTLE_MS,
  pollMs = SHIP_REAP_POLL_MS,
  giveUpMs = SHIP_REAP_GIVE_UP_MS,
  unmergedGraceMs = SHIP_REAP_UNMERGED_GRACE_MS,
  sleep = sleepSync,
  clock = Date.now,
  cleanup: cleanupFn = cleanupWorktrees,
} = {}) {
  const startedAt = clock();
  sleep(settleMs);
  for (;;) {
    const result = cleanupFn({
      root, base, apply: true, onlyPaths: [target], freshGraceMs: 0, idleMs: settleMs, by: 'atris worktree ship', now: clock(),
    });
    if (result.removed.length) return { removed: true, reason: result.removed[0].reason };
    const entry = result.kept.find((item) => canonicalPath(item.path) === canonicalPath(target));
    if (!entry) return { removed: false, reason: 'not_registered' };
    const waited = clock() - startedAt;
    const retry = SHIP_REAP_RETRY_REASONS.has(entry.reason) || (entry.reason === 'unmerged' && waited < unmergedGraceMs);
    if (!retry || waited >= giveUpMs) return { removed: false, reason: entry.reason };
    sleep(pollMs);
  }
}

function reapShipped() {
  const target = process.env.ATRIS_REAP_WORKTREE || '';
  if (!target) {
    console.error('reap-shipped: ATRIS_REAP_WORKTREE is not set');
    return 2;
  }
  const result = reapShippedCopy({ root: process.cwd(), target, base: process.env.ATRIS_REAP_BASE || '' });
  console.log(`reap-shipped: ${result.removed ? 'removed' : 'kept'} ${target} (${result.reason})`);
  return result.removed ? 0 : 1;
}

// The landed pull request from `gh pr view --json`, or null without a merge commit.
function shipMergeRecord(state) {
  const commit = state && state.mergeCommit && typeof state.mergeCommit === 'object' ? state.mergeCommit.oid : null;
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(commit)) return null;
  const record = { merge_commit: commit };
  if (Number.isInteger(state.number) && state.number > 0) record.number = state.number;
  if (typeof state.url === 'string' && state.url) record.url = state.url;
  if (typeof state.mergedAt === 'string' && state.mergedAt) record.merged_at = state.mergedAt;
  return record;
}

function guard(args) {
  const root = repoRoot();
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  if (path.resolve(root) === path.resolve(primary) && !hasFlag(args, '--allow-primary')) {
    console.error('blocked: this is the primary checkout; create an agent worktree first');
    console.error('run: atris worktree start --member <member>|--agent <name> --task "<short task>" --claim');
    return 2;
  }
  // Conductor plumbing (worktree metadata, the fleet prompt written for this very
  // engine, runtime scratch, the brief ledger) must not count as dirt, otherwise the
  // harness blocks the engine with the harness's own files.
  const counts = statusCounts(root, { ignoreUntracked: isConductorUntracked });
  if (counts && (counts.staged || counts.unstaged || counts.untracked) && !hasFlag(args, '--allow-dirty')) {
    console.error(`blocked: checkout is dirty staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
    return 3;
  }
  console.log('atris worktree guard: ok');
  return 0;
}

function prune(args) {
  const cmd = ['worktree', 'prune', '--verbose'];
  if (!hasFlag(args, '--apply')) cmd.push('--dry-run');
  const result = runGit(cmd, { cwd: repoRoot(), check: false });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  console.log(output || (hasFlag(args, '--apply') ? 'no stale worktree registrations removed' : 'no stale worktree registrations found'));
  return result.status || 0;
}

const PROTECTED_BRANCHES = new Set(['main', 'master']);

// A worktree fresh off `worktree start` is merged into base by definition
// (zero commits yet), so without a grace window the janitor reaps it while
// the engine that requested it is still booting inside.
const WORKTREE_REAP_GRACE_MS = 60 * 60 * 1000;
const GENERATED_WORKTREE_CACHE_DIRS = [
  '.derivedData',
  '.next',
  '.swiftpm',
  '.cache/swiftpm',
  'node_modules/.cache',
];

function worktreeWithinReapGrace(worktreePath, now = Date.now(), graceMs = WORKTREE_REAP_GRACE_MS) {
  try {
    return now - fs.statSync(worktreePath).mtimeMs < graceMs;
  } catch {
    return false;
  }
}

// Newest sign of work in a copy: its folder, its branch tip and reflog, web
// build output, and the engine's last message. The index is left out on
// purpose: a plain `git status` rewrites it.
function lastCopyActivityMs(worktreePath) {
  const marks = [worktreePath, path.join(worktreePath, '.next'), path.join(worktreePath, '.codex-last-message.txt')];
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(worktreePath, '.git'), 'utf8'));
    if (pointer) {
      const gitDir = path.resolve(worktreePath, pointer[1].trim());
      marks.push(path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD'));
    }
  } catch {}
  let newest = 0;
  for (const mark of marks) {
    try {
      newest = Math.max(newest, fs.statSync(mark).mtimeMs);
    } catch {}
  }
  return newest;
}

function canonicalPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

// null means the scan failed: we cannot tell who is inside, so callers keep
// every folder. An empty list would read as "nobody is here" and delete.
function listActiveProcessFiles() {
  const result = spawnSync('lsof', ['-n', '-F', 'n'], {
    encoding: 'utf8',
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    timeout: 20000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0 || String(result.stderr || '').trim()) return null;
  const paths = String(result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('n/'))
    .map((line) => canonicalPath(line.slice(1)))
    .filter(Boolean);
  return paths.length ? paths : null;
}

// Absolute paths named on each program's command line, including flag values
// like --require=/x.js. A program can run a script from a work folder while
// its current folder is elsewhere; the folder scan alone misses it. The list
// prints arguments unquoted, so a path with a space is also kept as the rest
// of the line from where it starts; the folder match is a prefix check.
function parseProcessArgPaths(psOutput) {
  const paths = new Set();
  const starts = /(?:^|\s)(?:[^\s=]*=)?(?=\/)/g;
  for (const raw of String(psOutput || '').split(/\r?\n/)) {
    const line = raw.trim();
    for (const match of line.matchAll(starts)) {
      const rest = line.slice(match.index + match[0].length);
      const token = rest.split(/\s/, 1)[0];
      if (token.length > 1) paths.add(token);
      if (rest.length > token.length) paths.add(rest);
    }
  }
  return [...paths];
}

function listActiveProcessArgPaths() {
  const result = spawnSync('ps', ['-axww', '-o', 'args='], {
    encoding: 'utf8',
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) return null;
  return parseProcessArgPaths(result.stdout);
}

// Open files and working folders, plus script paths on command lines.
function listActiveProcessPaths() {
  const files = listActiveProcessFiles();
  if (!Array.isArray(files)) return null;
  const args = listActiveProcessArgPaths();
  if (!Array.isArray(args)) return null;
  return files.concat(args);
}

function worktreeHasActiveProcess(worktreePath, activeCwds) {
  if (!Array.isArray(activeCwds)) return true;
  const resolved = canonicalPath(worktreePath);
  const prefix = `${resolved}${path.sep}`;
  return activeCwds.some((cwd) => {
    const active = canonicalPath(cwd);
    return active === resolved || active.startsWith(prefix);
  });
}

// Every work-folder removal leaves one line naming who removed it and why, in
// the main checkout's state so the line outlives the folder it describes.
function recordWorktreeRemoval(root, { path: removedPath, branch = '', by, reason }) {
  try {
    const common = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, check: false });
    const main = common.status === 0 ? path.dirname(common.stdout.trim()) : root;
    const file = path.join(main, '.atris', 'state', 'worktree_removals.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({
      at: new Date().toISOString(), path: removedPath, branch: branch || null, by, reason, pid: process.pid,
    })}\n`);
  } catch {}
}

// Only webpack's disposable pack files have a sufficiently narrow contract
// for unattended cleanup. Unknown files or links turn the folder into review.
function webpackCacheSnapshot(worktreePath) {
  try {
    const root = fs.realpathSync(worktreePath);
    let current = root;
    for (const part of ['.next', 'cache', 'webpack']) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    }
    if (fs.realpathSync(current) !== current) return null;
    const entries = [];
    function walk(dir) {
      for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) {
          entries.push([file, 'd', stat.ino, stat.mtimeMs]);
          if (!walk(file)) return false;
        } else if (stat.isFile() && /^(?:index|\d+)\.pack(?:\.gz|\.old)?$/.test(name)) {
          entries.push([file, 'f', stat.ino, stat.size, stat.mtimeMs]);
        } else return false;
      }
      return true;
    }
    if (!walk(current)) return null;
    const size = spawnSync('du', ['-sk', current], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    const match = size.status === 0 && String(size.stdout || '').match(/^(\d+)\s/);
    if (!match) return null;
    return { path: current, kib: Number(match[1]), fingerprint: JSON.stringify(entries) };
  } catch {
    return null;
  }
}

function pruneGeneratedWorktreeCaches(worktreePath, { apply = false, budget } = {}) {
  const candidates = [];
  const pruned = [];
  for (const relative of GENERATED_WORKTREE_CACHE_DIRS) {
    const target = path.join(worktreePath, relative);
    if (!fs.existsSync(target)) continue;
    const ignored = runGit(['check-ignore', '-q', '--', relative], { cwd: worktreePath, check: false });
    if (ignored.status !== 0) continue;
    const item = { worktree: worktreePath, path: target, relative, reason: 'manual_review_required' };
    candidates.push(item);
  }
  const relative = '.next/cache/webpack';
  const ignored = runGit(['check-ignore', '-q', '--', relative], { cwd: worktreePath, check: false });
  const snapshot = ignored.status === 0 ? webpackCacheSnapshot(worktreePath) : null;
  if (snapshot) {
    const item = { worktree: worktreePath, path: snapshot.path, relative, kib: snapshot.kib, reason: 'generated_webpack_cache' };
    candidates.push(item);
    if (apply && budget && budget.count < 20 && budget.kib + snapshot.kib <= 10 * 1024 * 1024) {
      const active = listActiveProcessPaths();
      const fresh = webpackCacheSnapshot(worktreePath);
      const stillIgnored = runGit(['check-ignore', '-q', '--', relative], { cwd: worktreePath, check: false });
      if (Array.isArray(active) && !worktreeHasActiveProcess(worktreePath, active)
          && stillIgnored.status === 0 && fresh && fresh.path === snapshot.path
          && fresh.kib === snapshot.kib && fresh.fingerprint === snapshot.fingerprint) {
        try {
          fs.rmSync(snapshot.path, { recursive: true });
          budget.count += 1;
          budget.kib += snapshot.kib;
          pruned.push(item);
        } catch (error) {
          item.error = String((error && error.message) || error);
        }
      }
    }
  }
  return { candidates, pruned };
}

function originBaseIsCurrent(root, base) {
  const prefix = base.startsWith('origin/') ? 'origin/'
    : base.startsWith('refs/remotes/origin/') ? 'refs/remotes/origin/' : '';
  if (!prefix) {
    if (base === 'HEAD') {
      const branch = runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: root, check: false });
      return branch.status === 0 && PROTECTED_BRANCHES.has(branch.stdout.trim());
    }
    return PROTECTED_BRANCHES.has(base.replace(/^refs\/heads\//, ''));
  }
  const branch = base.slice(prefix.length);
  const local = runGit(['rev-parse', '--verify', base], { cwd: root, check: false });
  const remote = runGit(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], { cwd: root, check: false, timeout: 5000 });
  const match = String(remote.stdout || '').match(/^([a-f0-9]{40,64})\s+(refs\/heads\/[^\r\n]+)$/m);
  return local.status === 0 && remote.status === 0 && Boolean(match)
    && match[2] === `refs/heads/${branch}` && local.stdout.trim() === match[1];
}

// Scope and pace options, all off by default:
//   onlyUnder / onlyPaths  touch only copies inside that folder / those paths
//   idleMs                 keep merged copies with work newer than this, and
//                          leave their caches alone
//   freshGraceMs           how long a merged copy is kept after its start
function cleanupWorktrees({
  root = repoRoot(),
  base: baseOverride = '',
  apply = false,
  activeCwds: activeCwdsOverride,
  by = 'atris worktree cleanup',
  onlyUnder = '',
  onlyPaths = null,
  idleMs = 0,
  freshGraceMs = WORKTREE_REAP_GRACE_MS,
  now = Date.now(),
  cleanupBudget = null,
} = {}) {
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path ? path.resolve(worktrees[0].path) : '';
  const current = path.resolve(root);
  const activeCwds = Array.isArray(activeCwdsOverride) ? activeCwdsOverride.map(canonicalPath) : listActiveProcessPaths();
  const base = normalizeTargetRef(root, baseOverride || defaultShipTarget(root));
  const refreshError = refreshRemoteRef(root, base);
  const candidates = [];
  const kept = [];
  const removed = [];
  const cacheCandidates = [];
  const cachePruned = [];
  const cacheBudget = cleanupBudget || { count: 0, kib: 0 };
  const scopePaths = Array.isArray(onlyPaths) ? onlyPaths.map(canonicalPath) : null;
  const inScope = (wtPath) => (!scopePaths || scopePaths.includes(canonicalPath(wtPath)))
    && (!onlyUnder || space.isInside(wtPath, onlyUnder));
  const recentlyUsed = (wtPath) => Boolean(idleMs) && now - lastCopyActivityMs(wtPath) < idleMs;
  const pruneCachesForKept = (wtPath) => {
    if (worktreeWithinReapGrace(wtPath, now)) return;
    if (recentlyUsed(wtPath)) return;
    const caches = pruneGeneratedWorktreeCaches(wtPath, { apply, budget: cacheBudget });
    cacheCandidates.push(...caches.candidates);
    cachePruned.push(...caches.pruned);
  };

  for (const wt of worktrees) {
    const wtPath = path.resolve(wt.path);
    const item = { path: wt.path, branch: wt.branch, head: wt.head };
    if (wtPath === primary) {
      kept.push({ ...item, reason: 'primary_checkout' });
      continue;
    }
    if (wtPath === current) {
      kept.push({ ...item, reason: 'current_checkout' });
      continue;
    }
    if (!inScope(wtPath)) {
      kept.push({ ...item, reason: 'out_of_scope' });
      continue;
    }
    if (wt.locked) {
      kept.push({ ...item, reason: 'locked' });
      continue;
    }
    if (PROTECTED_BRANCHES.has(wt.branch)) {
      kept.push({ ...item, reason: 'protected_branch' });
      continue;
    }
    if (worktreeHasActiveProcess(wtPath, activeCwds)) {
      kept.push({ ...item, reason: activeCwds ? 'active_process' : 'process_scan_failed' });
      continue;
    }
    const counts = statusCounts(wt.path);
    if (!counts) {
      kept.push({ ...item, reason: 'missing_or_unreadable' });
      continue;
    }
    if (counts.staged || counts.unstaged || counts.untracked) {
      pruneCachesForKept(wtPath);
      kept.push({ ...item, reason: 'dirty', staged: counts.staged, unstaged: counts.unstaged, untracked: counts.untracked });
      continue;
    }
    // Git removes ignored files along with a worktree. They may include local
    // state, credentials, or user data, so a clean status is not enough proof.
    const ignored = runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: wt.path, check: false });
    if (ignored.status !== 0 || ignored.error) {
      kept.push({ ...item, reason: 'ignored_scan_failed' });
      continue;
    }
    if (ignored.stdout) {
      pruneCachesForKept(wtPath);
      kept.push({ ...item, reason: 'ignored_data' });
      continue;
    }
    if (!wt.head) {
      pruneCachesForKept(wtPath);
      kept.push({ ...item, reason: 'missing_head' });
      continue;
    }
    if (refreshError) {
      kept.push({ ...item, reason: 'base_refresh_failed' });
      continue;
    }
    const merged = runGit(['merge-base', '--is-ancestor', wt.head, base], { cwd: root, check: false }).status === 0;
    if (!merged) {
      pruneCachesForKept(wtPath);
      kept.push({ ...item, reason: wt.branch === 'detached' ? 'detached_unmerged' : 'unmerged' });
      continue;
    }
    if (freshGraceMs > 0 && worktreeWithinReapGrace(wtPath, now, freshGraceMs)) {
      kept.push({ ...item, reason: 'fresh_worktree_grace' });
      continue;
    }
    if (recentlyUsed(wtPath)) {
      kept.push({ ...item, reason: 'recent_activity' });
      continue;
    }
    if (!originBaseIsCurrent(root, base)) {
      kept.push({ ...item, reason: 'base_unverified' });
      continue;
    }
    let real;
    try { real = fs.realpathSync(wtPath); } catch { real = ''; }
    if (!real || real !== wtPath) {
      kept.push({ ...item, reason: 'path_not_canonical' });
      continue;
    }
    const measured = spawnSync('du', ['-sk', wtPath], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
    const sizeMatch = measured.status === 0 && !String(measured.stderr || '').trim() && String(measured.stdout || '').match(/^(\d+)\s/);
    const kib = sizeMatch ? Number(sizeMatch[1]) : 0;
    if (!kib || cacheBudget.count >= 20 || cacheBudget.kib + kib > 10 * 1024 * 1024) {
      kept.push({ ...item, reason: 'size_unknown_or_cleanup_limit' });
      continue;
    }
    const candidate = { ...item, reason: 'merged_into_base', size_kib: kib };
    candidates.push(candidate);
    cacheBudget.count += 1;
    cacheBudget.kib += kib;
    if (!apply) continue;
    const freshActive = Array.isArray(activeCwdsOverride) ? activeCwds : listActiveProcessPaths();
    const freshCounts = statusCounts(wt.path);
    const freshIgnored = runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: wt.path, check: false });
    const freshSize = spawnSync('du', ['-sk', wtPath], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
    const freshMatch = freshSize.status === 0 && !String(freshSize.stderr || '').trim() && String(freshSize.stdout || '').match(/^(\d+)\s/);
    const gitdir = runGit(['rev-parse', '--absolute-git-dir'], { cwd: wtPath, check: false });
    const freshHead = runGit(['rev-parse', 'HEAD'], { cwd: wtPath, check: false });
    if (!Array.isArray(freshActive) || worktreeHasActiveProcess(wtPath, freshActive)
        || !freshCounts || freshCounts.staged || freshCounts.unstaged || freshCounts.untracked
        || freshIgnored.status !== 0 || freshIgnored.stdout || !freshMatch || Number(freshMatch[1]) !== kib
        || gitdir.status !== 0 || !gitdir.stdout.trim() || fs.existsSync(path.join(gitdir.stdout.trim(), 'locked'))
        || freshHead.status !== 0 || String(freshHead.stdout || '').trim() !== wt.head
        || runGit(['merge-base', '--is-ancestor', wt.head, base], { cwd: root, check: false }).status !== 0
        || !originBaseIsCurrent(root, base)
        || canonicalPath(wtPath) !== wtPath) {
      kept.push({ ...item, reason: 'changed_or_active_during_verification' });
      continue;
    }
    const removedResult = runGit(['worktree', 'remove', wt.path], { cwd: root, check: false });
    if (removedResult.status === 0) {
      removed.push(candidate);
      recordWorktreeRemoval(root, { path: wt.path, branch: wt.branch, by, reason: candidate.reason });
    } else {
      kept.push({ ...item, reason: 'remove_failed', error: (removedResult.stderr || removedResult.stdout || '').trim() });
    }
  }

  return { apply, base, candidates, removed, kept, cacheCandidates, cachePruned };
}

// The sweep: cleanup for every repo with build copies in the workspace.
// Removes copies that pass every cleanup check (merged into origin's main
// branch, nothing changed, untracked, or ignored, nothing running inside)
// and are unused for idleMs; clears verified webpack caches in the idle
// copies it keeps. Shared installs and unmerged work stay for review.
const SWEEP_IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_EVERY_HOURS = 3;
const SWEEP_HIDDEN_KEPT = new Set(['primary_checkout', 'current_checkout', 'out_of_scope']);

function sweepWorkspace({ workspace, apply = false, idleMs = SWEEP_IDLE_MS, activeCwds, freeSpace = space.freeBytes, by = 'atris worktree sweep', cleanupBudget = null } = {}) {
  const root = path.resolve(workspace);
  const before = freeSpace(root);
  const report = { workspace: root, apply, idle_ms: idleMs, before, after: before, repos: [] };
  const scan = Array.isArray(activeCwds) ? activeCwds.map(canonicalPath) : listActiveProcessPaths();
  // Without a process list nobody can tell which copies are in use.
  if (!Array.isArray(scan)) return { ...report, error: 'could not list running programs, so every copy was kept' };
  const scope = path.join(root, space.AGENT_COPIES_DIR);
  // One limit covers the whole sweep, not each repository separately.
  cleanupBudget = cleanupBudget || { count: 0, kib: 0 };
  for (const repo of space.agentCopyRepos(root)) {
    const entry = { name: repo.name, root: repo.root };
    try {
      const base = defaultMainlineBase(repo.root);
      if (!base.startsWith('origin/')) {
        report.repos.push({ ...entry, skipped: 'no origin main branch to compare against' });
        continue;
      }
      // A real removal scans again per repo and right before each copy goes;
      // the shared scan only serves previews and tests.
      const shared = Array.isArray(activeCwds) || !apply ? scan : undefined;
      const result = cleanupWorktrees({ root: repo.root, base, apply, activeCwds: shared, by, onlyUnder: scope, idleMs, cleanupBudget });
      report.repos.push({
        ...entry,
        base: result.base,
        removed: result.removed,
        candidates: result.candidates,
        cachePruned: result.cachePruned,
        cacheCandidates: result.cacheCandidates,
        kept: result.kept.filter((item) => !SWEEP_HIDDEN_KEPT.has(item.reason)),
        // Shared installs may be in use or contain local changes. Leave them
        // for explicit review rather than pruning by age.
        installsPruned: [],
      });
    } catch (error) {
      report.repos.push({ ...entry, error: String((error && error.message) || error) });
    }
  }
  report.after = freeSpace(root);
  return report;
}

const SWEEP_KEPT_LABELS = {
  active_process: 'in use',
  process_scan_failed: 'in use (could not check)',
  dirty: 'with changes',
  unmerged: 'not merged',
  detached_unmerged: 'not merged',
  ignored_data: 'holding files git ignores (kept for review)',
  ignored_scan_failed: 'unreadable',
  fresh_worktree_grace: 'new',
  recent_activity: 'used recently',
  locked: 'locked',
  protected_branch: 'on a main branch',
  missing_or_unreadable: 'unreadable',
  missing_head: 'without a commit',
  remove_failed: 'failed to remove',
  base_refresh_failed: 'main branch unreachable',
  base_unverified: 'main branch moved during the check',
  path_not_canonical: 'behind a link',
  size_unknown_or_cleanup_limit: 'over the per-run limit',
  changed_or_active_during_verification: 'changed during the check',
};

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// The folder that holds .agent-worktrees: this folder if it has one, else
// the one above the repo's main checkout.
function defaultSweepWorkspace(cwd = process.cwd()) {
  if (fs.existsSync(path.join(cwd, space.AGENT_COPIES_DIR))) return cwd;
  try {
    return path.dirname(findPrimaryRoot(repoRoot(cwd)));
  } catch {
    return cwd;
  }
}

function sweepSchedulePlan({ workspace, everyHours = SWEEP_EVERY_HOURS, homeDir = os.homedir(), platform = process.platform, atrisBin = ATRIS_BIN, envPath = process.env.PATH || '' }) {
  return planKeep({
    root: workspace,
    home: path.join(homeDir, '.atris', 'worktree-sweep'),
    platform,
    homeDir,
    atrisBin,
    envPath,
    job: {
      name: 'worktree-sweep',
      args: ['worktree', 'sweep', '--apply', '--workspace', workspace],
      every_seconds: Math.round(everyHours * 3600),
      marker: 'ATRIS_WORKTREE_SWEEP',
    },
  });
}

function sweepSchedule(args, workspace) {
  const everyHours = Number(readFlag(args, '--every', String(SWEEP_EVERY_HOURS)));
  if (!Number.isFinite(everyHours) || everyHours <= 0) {
    console.error('Usage: atris worktree sweep --install [--every <hours>] [--workspace <dir>]');
    return 2;
  }
  const plan = sweepSchedulePlan({ workspace, everyHours });
  if (hasFlag(args, '--uninstall')) {
    const removed = removeKeep(plan);
    if (!removed.ok) {
      console.error(`refusing: ${removed.error}`);
      return 1;
    }
    console.log(`sweep timer: ${removed.removed === false ? 'was not on' : 'off'} for ${workspace}`);
    return 0;
  }
  // The timer runs this atris file every few hours; a copy or temp folder vanishes.
  if (space.isAgentCopyPath(ATRIS_BIN) || space.isScratchPath(ATRIS_BIN)) {
    console.error(`refusing: this atris runs from ${path.dirname(path.dirname(ATRIS_BIN))}, a folder that gets removed; install the timer from a lasting atris install`);
    return 2;
  }
  const installed = installKeep(plan);
  if (!installed.ok) {
    console.error(`refusing: ${installed.error}`);
    return 1;
  }
  console.log(`sweep timer: on for ${workspace}, every ${everyHours} ${everyHours === 1 ? 'hour' : 'hours'}`);
  console.log(`log: ${plan.log_path}`);
  return 0;
}

function sweep(args) {
  const workspace = path.resolve(readFlag(args, '--workspace') || defaultSweepWorkspace());
  if (hasFlag(args, '--install') || hasFlag(args, '--uninstall')) return sweepSchedule(args, workspace);
  const idleHours = Number(readFlag(args, '--idle-hours', String(SWEEP_IDLE_MS / 3600000)));
  if (!Number.isFinite(idleHours) || idleHours < 0) {
    console.error('Usage: atris worktree sweep [--apply] [--json] [--workspace <dir>] [--idle-hours <n>]');
    return 2;
  }
  const apply = hasFlag(args, '--apply');
  const report = sweepWorkspace({ workspace, apply, idleMs: idleHours * 3600000 });
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({ ok: !report.error, ...report }, null, 2));
    return report.error ? 1 : 0;
  }
  console.log(`sweep: ${apply ? 'applied' : 'dry run'} in ${workspace}, ${space.formatGb(report.before)} free`);
  if (report.error) {
    console.error(`refusing: ${report.error}`);
    return 1;
  }
  let removedTotal = 0;
  let clearedTotal = 0;
  let reviewTotal = 0;
  for (const repo of report.repos) {
    if (repo.error || repo.skipped) {
      console.log(`${repo.name}: skipped (${repo.error || repo.skipped})`);
      continue;
    }
    const gone = apply ? repo.removed : repo.candidates;
    const cleared = apply ? repo.cachePruned : repo.cacheCandidates.filter((item) => item.reason === 'generated_webpack_cache');
    removedTotal += gone.length;
    clearedTotal += cleared.length;
    reviewTotal += repo.cacheCandidates.filter((item) => item.reason === 'manual_review_required').length;
    const counts = {};
    for (const item of repo.kept) {
      const label = SWEEP_KEPT_LABELS[item.reason] || item.reason;
      counts[label] = (counts[label] || 0) + 1;
    }
    const keptText = Object.entries(counts).map(([label, count]) => `${count} ${label}`).join(', ');
    console.log(`${repo.name}: ${apply ? 'removed' : 'would remove'} ${plural(gone.length, 'finished copy', 'finished copies')}, ${apply ? 'cleared' : 'would clear'} ${plural(cleared.length, 'webpack cache', 'webpack caches')}; kept ${repo.kept.length}${keptText ? ` (${keptText})` : ''}`);
    for (const item of gone) console.log(`  ${apply ? 'removed' : 'remove'}: ${item.path}`);
    for (const item of cleared) console.log(`  ${apply ? 'cleared' : 'clear'}: ${item.path}`);
  }
  if (reviewTotal) console.log(`review: ${plural(reviewTotal, 'other build folder waits', 'other build folders wait')} for a person; \`atris worktree cleanup\` in each repo lists them`);
  if (apply) {
    console.log(`free: ${space.formatGb(report.before)} before, ${space.formatGb(report.after)} after`);
  } else if (removedTotal || clearedTotal) {
    console.log('next: atris worktree sweep --apply');
  }
  return 0;
}

function cleanup(args) {
  const asJson = hasFlag(args, '--json');
  const result = cleanupWorktrees({
    root: repoRoot(),
    base: readFlag(args, '--base'),
    apply: hasFlag(args, '--apply'),
  });
  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return 0;
  }
  const action = result.apply ? 'removed' : 'candidate';
  console.log(`cleanup: ${result.apply ? 'applied' : 'dry-run'} base=${result.base}`);
  console.log(`${action}s: ${result.apply ? result.removed.length : result.candidates.length}`);
  for (const item of result.apply ? result.removed : result.candidates) {
    console.log(`${action}: ${item.path} branch=${item.branch} reason=${item.reason}`);
  }
  const review = result.cacheCandidates.filter((item) => item.reason === 'manual_review_required');
  const safe = result.apply ? result.cachePruned : result.cacheCandidates.filter((item) => item.reason === 'generated_webpack_cache');
  console.log(`cache ${result.apply ? 'removed' : 'candidate'}s: ${safe.length}`);
  for (const item of safe) console.log(`cache: ${item.path} size_kib=${item.kib}`);
  console.log(`cache review needed: ${review.length}`);
  for (const item of review) {
    console.log(`review: ${item.path} reason=${item.reason}`);
  }
  console.log(`kept: ${result.kept.length}`);
  if (!result.apply && result.candidates.length) console.log('next: atris worktree cleanup --apply');
  return 0;
}

function guide() {
  console.log('Atris worktree agent recipe');
  console.log('');
  console.log('Default: stay in the current checkout for small, clean, single-agent fixes.');
  console.log('Use a worktree for dirty launchers, parallel agents, risky edits, releases, or long proof runs.');
  console.log('');
  console.log('1. Start isolated work when needed:');
  console.log('   atris worktree start --member <member> --task "<task>" --claim');
  console.log('   atris worktree start --agent <agent> --task "<task>"');
  console.log('');
  console.log('2. Move into the printed path:');
  console.log('   cd <printed path>');
  console.log('   atris worktree guard');
  console.log('');
  console.log('3. Tie work to mission/member state when relevant:');
  console.log('   atris mission start "<objective>" --owner <member> --verify "<cmd>"');
  console.log('   atris member goal-from-mission <member>');
  console.log('   atris member tick <member>');
  console.log('   atris mission tick <id> --verify --complete-on-pass');
  console.log('');
  console.log('4. Ship only from the isolated worktree:');
  console.log('   atris worktree ship --message "<commit>" --verify "<cmd>" --merge [--target <ref>]');
  console.log('   --target <ref> overrides the default landing target (default: branch atris-base, else origin default branch)');
  console.log('   recommended verify: npm run test:fast && node --test <focused files>');
  console.log('');
  console.log('5. Cleanup is part of creation, shipping, and the sweep; run it directly any time:');
  console.log('   atris worktree cleanup');
  console.log('   atris worktree cleanup --apply');
  console.log('   atris worktree sweep --apply              every repo in the workspace');
  console.log('   atris worktree sweep --install            run the sweep every 3 hours');
  console.log('');
  console.log('Notes: start uses the current upstream/default remote base, not dirty local HEAD.');
  console.log('Start reaps completed checkouts first. Cleanup preserves branches, source changes, and files git ignores, skips live work, and prunes only verified webpack caches.');
  console.log('Start clones node_modules from a matching install when package-lock.json matches; skip npm ci when it prints "deps: cloned".');
  console.log('Below 25 GB free, start reaps finished copies in every repo; below 10 GB it refuses (ATRIS_WORKTREE_REAP_BELOW_GB, ATRIS_WORKTREE_MIN_FREE_GB).');
  console.log('A copy shipped with --merge is removed once nothing has run in it for 10 minutes (ATRIS_WORKTREE_KEEP_AFTER_SHIP=1 keeps it).');
  console.log('Use `atris worktree status` to see all worktrees and dirty counts.');
  return 0;
}

function help() {
  console.log('Usage: atris worktree <guide|start|ship|status|guard|prune|cleanup|sweep>');
  console.log('');
  console.log('  atris worktree guide');
  console.log('  atris worktree start --member <member>|--agent <name> --task "<task>" [--former-task "<older name>"] [--claim] [--force] [--no-deps]');
  console.log('    --force         start even when another recent flight shares a task word');
  console.log('    --former-task   the task\'s older name; a branch left unfinished under it is named, never resumed');
  console.log('    --no-deps       do not clone node_modules from a matching install');
  console.log('  atris worktree ship --message "<commit>" --verify "<cmd>" [--merge] [--target <ref>] [--local]');
  console.log('    --target <ref>  override the default landing target (default: branch atris-base, else origin default branch)');
  console.log('    --local         merge into the local primary checkout instead of pushing and opening a PR');
  console.log('    --no-map-refresh  skip the automatic refresh of moved map line references');
  console.log('    recommended verify: npm run test:fast && node --test <focused files>');
  console.log('  atris worktree status');
  console.log('  atris worktree guard [--allow-primary] [--allow-dirty]');
  console.log('  atris worktree prune [--apply]');
  console.log('  atris worktree cleanup [--apply] [--json] [--base origin/master]  reap completed checkouts and verified webpack caches');
  console.log('  atris worktree sweep [--apply] [--json] [--workspace <dir>] [--idle-hours 2]  reap merged, idle copies in every repo');
  console.log('  atris worktree sweep --install [--every 3] | --uninstall  run the sweep on a timer');
}

function worktreeCommand(args = []) {
  const sub = args[0] || 'status';
  const rest = args.slice(1);
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    help();
    return 0;
  }
  if (sub === 'guide' || sub === 'recipe') return guide();
  if (sub === 'start') return startWorktree(rest);
  if (sub === 'ship') return shipWorktree(rest);
  if (sub === 'status') {
    printStatus();
    return 0;
  }
  if (sub === 'guard') return guard(rest);
  if (sub === 'prune') return prune(rest);
  if (sub === 'cleanup' || sub === 'clean') return cleanup(rest);
  if (sub === 'sweep') return sweep(rest);
  if (sub === 'reap-shipped') return reapShipped();
  help();
  return 2;
}

module.exports = {
  branchName,
  collidingFlights,
  mergePrWithRetry,
  createAgentWorktree,
  lowDiskRefusal,
  deniedLaneForShip,
  protectedPushRefusal,
  createOrFindPr,
  cleanupWorktrees,
  reapShippedCopy,
  scheduleShippedCopyRemoval,
  shippedCopyRemovalPlan,
  sweepSchedulePlan,
  sweepWorkspace,
  defaultMainlineBase,
  defaultStartBase,
  gitFailureDetail,
  gitNetworkEnvironment,
  describeFlightAge,
  flightStampMs,
  listActiveProcessPaths,
  listWorktrees,
  parseAgentFlightName,
  parseProcessArgPaths,
  parseWorktrees,
  normalizeTargetRef,
  recordWorktreeRemoval,
  refreshMovedMapRefs,
  slugify,
  taskTokens,
  statusCounts,
  swarloClaim,
  runShipHealthCheck,
  worktreeCommand,
  worktreeHasActiveProcess,
};
