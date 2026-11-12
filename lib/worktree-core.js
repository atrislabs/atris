'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { hasFlag } = require('./arg-parser');
const { planKeep } = require('./campaign-keep');
const { isConductorArtifact, isConductorUntracked } = require('./conductor-artifacts');
const { fixMapDocs } = require('./map-refs');
const { sleepSync } = require('./sleep-sync');
const space = require('./worktree-space');
const close = require('../commands/close');

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

function runGit(args, { cwd = process.cwd(), check = true, timeout } = {}) {
  const network = ['fetch', 'push', 'ls-remote'].includes(args[0]);
  // Only network calls need the SSH probe; local calls skip its extra git spawn.
  const defaultTimeout = args[0] === 'push' ? GIT_PUSH_TIMEOUT_MS : network ? 30000 : undefined;
  // Listing a large repo's index or files can pass the 1 MB default buffer.
  const options = { cwd, encoding: 'utf8', timeout: timeout ?? defaultTimeout, maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    killSignal: 'SIGKILL', env: network ? gitNetworkEnvironment(process.env, cwd) : undefined };
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

// Programmatic core shared by `atris worktree start` and `atris mission start
// --worktree`: creates the branch + isolated checkout + identity sidecar and
// returns the facts. Throws on failure; callers own messaging and next steps.
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
  const checkoutBase = normalizeTargetRef(root, mainline);
  const shipBase = checkoutBase;
  if (fs.existsSync(target)) throw new Error(`worktree path already exists: ${target}`);
  // A full disk stops every flight at once. Reap first; refuse before cutting.
  const room = checkRoomForCopy({ root, target, freeSpace, env, spaceGuard, cleanupBudget });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staleBase = refreshRemoteRef(root, checkoutBase);
  let resumedFrom = (!pathOverride && !branchOverride)
    ? lastRunBranch(root, owner, task, checkoutBase, branch)
    : null;
  let skippedResume = null;
  if (resumedFrom && conflictsWithBase(root, checkoutBase, resumedFrom)) {
    skippedResume = resumedFrom;
    resumedFrom = null;
    console.error(`note: the last run's branch ${skippedResume} no longer merges cleanly with ${checkoutBase}, so this run starts fresh; that branch keeps its commits`);
  }
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
      runGit(['worktree', 'remove', target], { cwd: root });
    }
    if (!fs.existsSync(target)) runGit(['update-ref', '-d', ref, startCommit], { cwd: root });
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const added = runGit(['worktree', 'add', '-b', branch, target, startPoint], { cwd: root, check: false });
    if (added.status === 0) break;
    if (!/already exists|already used by worktree/i.test(added.stderr || '')) discardFailedStart();
    if (!configLocked(added) || attempt === 2) {
      throw new Error(String(added.stderr || added.stdout || 'worktree start failed').trim());
    }
    sleepSync(100 * (attempt + 1));
  }
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

function checkRoomForCopy({ root, target, freeSpace, env, spaceGuard, cleanupBudget = null }) {
  return (spaceGuard ?? !space.isScratchPath(target))
    ? ensureRoomForCopy({ root, target, freeSpace, env, cleanupBudget })
    : null;
}

function lowDiskRefusal({ root = repoRoot(), member = '', agent = '', task = 'flight', now = new Date(), env = process.env, freeSpace = space.freeBytes, spaceGuard, target = '' } = {}) {
  try {
    checkRoomForCopy({ root, target: target ? path.resolve(target) : path.resolve(defaultWorktreePath(root, member || agent, task, now)), freeSpace, env, spaceGuard });
    return null;
  } catch (error) {
    if (!error || error.code !== 'ATRIS_LOW_DISK') return null;
    return { message: error.message, free: error.space.free, needs: error.space.refuseBelow };
  }
}

function createOrFindPr(root, branch, targetRef, title, dryRun) {
  const targetBranch = baseBranchName(targetRef);
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

function deniedLaneForShip(root, branch, message) {
  try {
    const { protectedLaneOfTask } = require('./fleet');
    const refs = new Set();
    for (const source of [String(branch || ''), String(message || '')]) {
      for (const m of source.toUpperCase().matchAll(/([A-Z]{2,6}-\d+)/g)) refs.add(m[1]);
      for (const m of source.toLowerCase().matchAll(/([a-z]{2,6})-(\d+)/g)) refs.add(`${m[1].toUpperCase()}-${m[2]}`);
    }
    const words = new Set(String(branch || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const projectionPath = path.join(findPrimaryRoot(root), '.atris', 'state', 'tasks.projection.json');
    if (!fs.existsSync(projectionPath)) return null;
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    for (const task of projection.tasks || []) {
      const ids = [task.display_id, task.legacy_ref].filter(Boolean).map(v => String(v).toUpperCase());
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

const OPEN_PR_LIST_LIMIT = 100;

function protectedPushRefusal(root, branch, run = spawnSync) {
  const unknown = (why) => `blocked: cannot tell whether ${branch} has a pull request with auto-merge on (${why}); nothing was pushed`;
  const listed = run('gh', [
    'pr', 'list', '--head', branch, '--state', 'open',
    '--json', 'number,url,baseRefName,autoMergeRequest',
    '--limit', String(OPEN_PR_LIST_LIMIT),
  ], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (listed.error) {
    return unknown(listed.error.code === 'ETIMEDOUT' ? 'gh took longer than a minute to answer' : `gh did not run: ${listed.error.message}`);
  }
  if (listed.status !== 0) {
    const said = `${listed.stderr || ''}\n${listed.stdout || ''}`;
    const firstLine = said.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return unknown(firstLine || `gh exited ${listed.status}`);
  }
  let open;
  try { open = JSON.parse(String(listed.stdout || '')); } catch { open = null; }
  const readable = Array.isArray(open)
    && open.every((pr) => pr && typeof pr === 'object' && !Array.isArray(pr) && Object.prototype.hasOwnProperty.call(pr, 'autoMergeRequest'));
  if (!readable) return unknown("gh's answer could not be read");
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

// The repo checks that failed CI for seven builders in three days. Ship runs
// them itself so the failure shows up before the push, not after a CI round trip.
const SHIP_NET_FILES = [
  'test/repo-hygiene.test.js',
  'test/no-hardcoded-home-paths.test.js',
  'test/map-refs-accurate.test.js',
];

function shipNets(root) {
  return SHIP_NET_FILES.filter((file) => fs.existsSync(path.join(root, file)));
}

// Runs the nets once, before the caller's --verify. A net the verify command
// already names by its exact path is dropped so it does not run twice. Returns { ok, ran, files }.
function runShipNets(root, { verify = '', skip = false, dryRun = false, env = process.env } = {}) {
  if (skip || env.ATRIS_SHIP_SKIP_NETS === '1') {
    console.log(`nets: skipped (${skip ? '--skip-nets' : 'ATRIS_SHIP_SKIP_NETS=1'})`);
    return { ok: true, ran: false, files: [] };
  }
  const present = shipNets(root);
  if (!present.length) {
    console.log('nets: none in this repo');
    return { ok: true, ran: false, files: [] };
  }
  // Whole whitespace-separated tokens only: the exact path, or the same path with ./ in front.
  const named = new Set(String(verify || '').split(/\s+/).map((token) => token.replace(/^(['"])(.*)\1$/, '$2')));
  const files = present.filter((file) => !named.has(file) && !named.has(`./${file}`));
  if (!files.length) {
    console.log('nets: covered by --verify');
    return { ok: true, ran: false, files: [] };
  }
  console.log(`nets: node --test ${files.join(' ')}`);
  if (dryRun) {
    console.log('nets: skipped (dry-run)');
    return { ok: true, ran: false, files };
  }
  // A ship started from inside a test run must still get a real runner.
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env: childEnv });
  if (result.error || result.status !== 0) {
    console.error('nets: failed, fix before shipping');
    return { ok: false, ran: true, files };
  }
  return { ok: true, ran: true, files };
}

const SHIP_SETTLE_MS = 10 * 60 * 1000;
const SHIP_REAP_POLL_MS = 60 * 1000;
const SHIP_REAP_GIVE_UP_MS = 6 * 60 * 60 * 1000;
const SHIP_REAP_UNMERGED_GRACE_MS = 15 * 60 * 1000;
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
  if (space.isInside(atrisBin, copy)) return { skip: 'this atris runs from inside the copy', announce: true };
  return { copy };
}

function scheduleShippedCopyRemoval({ root, primary, branch, base, env = process.env, spawnProcess = spawn }) {
  const plan = shippedCopyRemovalPlan({ root, primary, env });
  if (plan.skip) return plan;
  try {
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

function shipMergeRecord(state) {
  const commit = state && state.mergeCommit && typeof state.mergeCommit === 'object' ? state.mergeCommit.oid : null;
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(commit)) return null;
  const record = { merge_commit: commit };
  if (Number.isInteger(state.number) && state.number > 0) record.number = state.number;
  if (typeof state.url === 'string' && state.url) record.url = state.url;
  if (typeof state.mergedAt === 'string' && state.mergedAt) record.merged_at = state.mergedAt;
  return record;
}

const PROTECTED_BRANCHES = new Set(['main', 'master']);
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

function recordWorktreeRemoval(root, { path: removedPath, branch = '', by, reason, ...details }) {
  try {
    const common = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, check: false });
    const main = common.status === 0 ? path.dirname(common.stdout.trim()) : root;
    const file = path.join(main, '.atris', 'state', 'worktree_removals.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({
      at: new Date().toISOString(), path: removedPath, branch: branch || null, by, reason, ...details, pid: process.pid,
    })}\n`);
  } catch {}
}

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

// The guarantee: a copy is removed only when every byte in it is proven saved
// (committed and on origin) or proven throwaway. Anything unusual, or anything
// the checks cannot read, keeps the copy for a person.
//
// Throwaway ignored folders are matched by exact place, never by name alone:
// an install or cache folder right beside the package file that makes it
// (package.json for node_modules, .next, .cache, .turbo; pyproject.toml,
// setup.py or setup.cfg for the Python test caches). uploads/.cache/ and a
// .cache/ with no package.json beside it are not throwaway.
const JS_THROWAWAY_DIRS = new Set(['node_modules', '.next', '.cache', '.turbo']);
const JS_PACKAGE_FILES = ['package.json'];
const PY_THROWAWAY_DIRS = new Set(['.pytest_cache', '.mypy_cache', '.ruff_cache']);
const PY_PACKAGE_FILES = ['pyproject.toml', 'setup.py', 'setup.cfg'];
// Written by atris itself at the top of a copy: the start sidecar, prompt
// files, watchdogs, its scratch and cache folders, and command usage counts.
const ATRIS_PLUMBING_IGNORED = /^\.atris\/(?:agent-worktree\.json|fleet-prompt-[^/]+\.md|codex-watchdog\.js|codex-watchdog-[^/]+\.json|runtime-tmp\/.*|cache\/.*|state\/usage\.jsonl)$/;
const THROWAWAY_IGNORED_FILE = /^(?:(?:.*\/)?\.DS_Store|tsconfig\.tsbuildinfo|next-env\.d\.ts)$/;
const IGNORED_WALK_LIMIT = 20000;
const RESCUE_IDLE_MS = 7 * DAY_MS;

function throwawayIgnoredDir(wtPath, relative) {
  const name = path.basename(relative);
  const parent = path.dirname(relative);
  // Even at the top of the copy, a cache counts only beside the package file that makes it.
  const besidePackage = (files) => files.some((file) => {
    try { return fs.lstatSync(path.join(wtPath, parent, file)).isFile(); } catch { return false; }
  });
  if (JS_THROWAWAY_DIRS.has(name)) return besidePackage(JS_PACKAGE_FILES);
  if (PY_THROWAWAY_DIRS.has(name)) return besidePackage(PY_PACKAGE_FILES);
  // Python bytecode folders sit beside every module; one counts only when it
  // holds nothing but .pyc files.
  if (name === '__pycache__') {
    try {
      return fs.readdirSync(path.join(wtPath, relative), { withFileTypes: true })
        .every((entry) => entry.isFile() && entry.name.endsWith('.pyc'));
    } catch { return false; }
  }
  return false;
}

function throwawayIgnoredFile(relative) {
  return THROWAWAY_IGNORED_FILE.test(relative) || ATRIS_PLUMBING_IGNORED.test(relative);
}

// Ignored files in a copy that removal would lose: everything git ignores that
// is not proven throwaway. null when the copy cannot be read or holds too many
// files to check.
function ignoredFilesToKeep(wtPath) {
  const listed = runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: wtPath, check: false });
  if (listed.status !== 0 || listed.error) return null;
  const keepers = [];
  let walked = 0;
  for (const entry of String(listed.stdout || '').split('\0').filter(Boolean)) {
    const clean = entry.replace(/\/+$/, '');
    if (!entry.endsWith('/')) {
      if (!throwawayIgnoredFile(clean)) keepers.push(clean);
      continue;
    }
    if (throwawayIgnoredDir(wtPath, clean)) continue;
    const stack = [clean];
    while (stack.length) {
      const rel = stack.pop();
      let children;
      try { children = fs.readdirSync(path.join(wtPath, rel), { withFileTypes: true }); } catch { return null; }
      for (const child of children) {
        walked += 1;
        if (walked > IGNORED_WALK_LIMIT) return null;
        const childRel = `${rel}/${child.name}`;
        if (child.isDirectory()) {
          if (!throwawayIgnoredDir(wtPath, childRel)) stack.push(childRel);
        } else if (!throwawayIgnoredFile(childRel)) {
          keepers.push(childRel);
        }
      }
    }
  }
  return keepers;
}

// Why a copy holds work the snapshot cannot prove it saved, or '' when it
// holds none: index entries told to hide their edits, conflicts, sparse
// checkouts, and nested repositories other than a registered submodule that
// sits clean at a commit its own origin already has.
function unprovableReason(wtPath) {
  const flags = runGit(['ls-files', '-v', '-z'], { cwd: wtPath, check: false });
  if (flags.status !== 0) return 'could not read the index';
  const hidden = String(flags.stdout || '').split('\0').filter(Boolean)
    .filter((row) => /^[a-zS]/.test(row)).map((row) => row.slice(2));
  if (hidden.length) return `index entries hide their edits (assume-unchanged or skip-worktree): ${hidden.slice(0, 3).join(', ')}`;
  const conflicts = runGit(['ls-files', '-u'], { cwd: wtPath, check: false });
  if (conflicts.status !== 0 || String(conflicts.stdout || '').trim()) return 'unresolved merge conflicts';
  const sparse = runGit(['config', '--bool', 'core.sparseCheckout'], { cwd: wtPath, check: false });
  if (String(sparse.stdout || '').trim() === 'true') return 'sparse checkout';
  // git lists an untracked folder that is its own repository as `name/`;
  // committing it would save only a pointer, not its files or commits.
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: wtPath, check: false });
  if (untracked.status !== 0) return 'could not list untracked files';
  const nested = String(untracked.stdout || '').split('\0').filter((entry) => entry.endsWith('/'));
  if (nested.length) return `nested git repository ${nested[0].replace(/\/$/, '')} is not saved by a commit`;
  const listed = runGit(['ls-files', '-s', '-z'], { cwd: wtPath, check: false });
  if (listed.status !== 0) return 'could not read the index';
  const links = new Map();
  for (const row of String(listed.stdout || '').split('\0').filter(Boolean)) {
    const match = row.match(/^160000 ([0-9a-f]+) \d\t(.+)$/);
    if (match) links.set(match[2], match[1]);
  }
  if (!links.size) return '';
  const registered = runGit(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], { cwd: wtPath, check: false });
  const paths = new Set(String(registered.stdout || '').split('\n').map((line) => line.split(' ').slice(1).join(' ')).filter(Boolean));
  for (const [link, oid] of links) {
    if (!paths.has(link)) return `nested git repository ${link} is not a registered submodule`;
    const dir = path.join(wtPath, link);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch {}
    if (!entries.length) continue;
    const head = runGit(['rev-parse', 'HEAD'], { cwd: dir, check: false });
    const status = runGit(['status', '--porcelain', '--ignored=matching'], { cwd: dir, check: false });
    const pushed = runGit(['branch', '-r', '--contains', oid], { cwd: dir, check: false });
    if (head.status !== 0 || head.stdout.trim() !== oid || status.status !== 0 || String(status.stdout || '').trim()
        || pushed.status !== 0 || !String(pushed.stdout || '').trim()) {
      return `submodule ${link} has work not proven on its origin`;
    }
    // A clean status proves nothing if the submodule hides edits too.
    const inner = unprovableReason(dir);
    if (inner) return `submodule ${link}: ${inner}`;
  }
  return '';
}

// Settings that let git change bytes between disk and a commit. A content
// filter (clean filters, LFS and the like) or the ident attribute (where
// `$Id: any text $` hashes the same as `$Id$`) can hide local text even from
// `git status`, so either keeps every copy, clean or dirty, on every removal
// path. Line-ending and encoding conversion also keep a dirty copy, where the
// rescue snapshot must match the disk byte for byte; on a clean copy they only
// differ by reversible line endings or encoding, an accepted limit. A filter defined only in global config and named by no
// attribute changes nothing and is allowed.
const FILTER_ATTRIBUTE = /(?:^|\s)(?:filter|ident)(?:[=\s]|$)/m;
const BYTE_CHANGING_ATTRIBUTE = /(?:^|\s)(?:filter|working-tree-encoding|eol|text|crlf|ident)(?:[=\s]|$)/m;

function attributeFiles(wtPath) {
  const files = [];
  const listed = runGit(['ls-files', '--cached', '--others', '-z', '--', '.gitattributes', '*/.gitattributes'], { cwd: wtPath, check: false });
  if (listed.status !== 0) return null;
  for (const rel of String(listed.stdout || '').split('\0').filter(Boolean)) files.push(path.join(wtPath, rel));
  const info = runGit(['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'], { cwd: wtPath, check: false });
  if (info.status === 0 && info.stdout.trim()) files.push(info.stdout.trim());
  const configured = runGit(['config', '--path', 'core.attributesFile'], { cwd: wtPath, check: false });
  const fallback = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'attributes');
  files.push(configured.status === 0 && configured.stdout.trim() ? configured.stdout.trim() : fallback);
  return files;
}

function byteChangingSetting(wtPath, { filtersOnly = false } = {}) {
  const local = runGit(['config', '--local', '--get-regexp', '^filter\\.'], { cwd: wtPath, check: false });
  if (String(local.stdout || '').trim()) return 'a content filter is set in this repo';
  const worktreeScope = runGit(['config', '--worktree', '--get-regexp', '^filter\\.'], { cwd: wtPath, check: false });
  if (String(worktreeScope.stdout || '').trim()) return 'a content filter is set in this copy';
  for (const key of filtersOnly ? [] : ['core.autocrlf', 'core.eol']) {
    const value = String(runGit(['config', key], { cwd: wtPath, check: false }).stdout || '').trim().toLowerCase();
    if (value && value !== 'false' && !(key === 'core.eol' && value === 'native')) return `${key} converts line endings`;
  }
  const files = attributeFiles(wtPath);
  if (!files) return 'could not list attribute files';
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      return `could not read ${file}`;
    }
    const rows = text.split(/\r?\n/).filter((row) => !/^\s*(?:#|$)/.test(row));
    const hit = rows.find((row) => (filtersOnly ? FILTER_ATTRIBUTE : BYTE_CHANGING_ATTRIBUTE).test(row));
    if (hit) return `git attributes can change bytes on commit (${path.basename(file)}: ${hit.trim().slice(0, 60)})`;
  }
  return '';
}

function sizeKib(target) {
  const measured = spawnSync('du', ['-sk', target], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  const match = measured.status === 0 && !String(measured.stderr || '').trim() && String(measured.stdout || '').match(/^(\d+)\s/);
  return match ? Number(match[1]) : 0;
}

function formatKib(kib) {
  if (!Number.isFinite(kib) || kib <= 0) return 'an unknown amount';
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GB`;
  if (kib >= 1024) return `${Math.round(kib / 1024)} MB`;
  return `${kib} KB`;
}

function worktreeEntry(root, wtPath) {
  return listWorktrees(root).find((wt) => canonicalPath(wt.path) === canonicalPath(wtPath)) || null;
}

function remoteBranchOid(root, branch) {
  const remote = runGit(['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: root, check: false });
  if (remote.status !== 0 || remote.error) return null;
  const match = String(remote.stdout || '').match(/^([0-9a-f]{40,64})\s+refs\/heads\/(\S+)$/m);
  return match && match[2] === branch ? match[1] : '';
}

// Where the copy's last commit is safe outside the copy: merged into the
// branch it landed on, or sitting on the same branch at origin.
function shippedWorkHome(root, { head, branch, landedOn }) {
  if (landedOn) {
    if (landedOn.startsWith('origin/')) refreshRemoteRef(root, landedOn);
    if (runGit(['merge-base', '--is-ancestor', head, landedOn], { cwd: root, check: false }).status === 0) {
      return baseBranchName(landedOn);
    }
  }
  if (branch && remoteBranchOid(root, branch) === head) return `origin/${branch}`;
  return '';
}

// Remove a copy right after ship lands or pushes it. Runs from the main
// checkout, never from inside the copy. A copy with changes, files that cannot
// come back, or another program inside it is kept and the reason returned.
function removeShippedCopyNow({ root, primary, branch = '', landedOn = '', keep = false, env = process.env, atrisBin = ATRIS_BIN, activePaths = listActiveProcessPaths } = {}) {
  if (keep) return { removed: false, reason: 'kept on request (--keep-copy)' };
  if (env.ATRIS_WORKTREE_KEEP_AFTER_SHIP === '1') return { removed: false, reason: 'ATRIS_WORKTREE_KEEP_AFTER_SHIP=1' };
  const copy = canonicalPath(root);
  if (!primary || copy === canonicalPath(primary)) return { removed: false, reason: 'primary checkout', quiet: true };
  if (!space.isAgentCopyPath(copy)) return { removed: false, reason: 'not an agent build copy', quiet: true };
  if (space.isInside(atrisBin, copy)) return { removed: false, reason: 'this atris runs from inside the copy' };
  const mainRoot = canonicalPath(primary);
  const wt = worktreeEntry(mainRoot, copy);
  if (!wt) return { removed: false, reason: 'not registered' };
  if (wt.locked) return { removed: false, reason: 'locked' };
  const counts = statusCounts(copy);
  if (!counts) return { removed: false, reason: 'unreadable' };
  if (counts.staged || counts.unstaged || counts.untracked) {
    return { removed: false, reason: `it still has ${counts.staged + counts.unstaged + counts.untracked} unsaved changes` };
  }
  const keepers = ignoredFilesToKeep(copy);
  if (!keepers) return { removed: false, reason: 'could not check the files git ignores', retry: true };
  if (keepers.length) return { removed: false, reason: `it holds ignored files atris cannot rebuild: ${keepers.slice(0, 3).join(', ')}` };
  const unprovable = byteChangingSetting(copy, { filtersOnly: true }) || unprovableReason(copy);
  if (unprovable) return { removed: false, reason: unprovable };
  const head = runGit(['rev-parse', 'HEAD'], { cwd: copy, check: false });
  const headOid = head.status === 0 ? head.stdout.trim() : '';
  if (!headOid) return { removed: false, reason: 'no commit' };
  const home = shippedWorkHome(mainRoot, { head: headOid, branch, landedOn });
  if (!home) return { removed: false, reason: 'could not confirm the work reached origin', retry: true };
  // Step out first so this process is not one of the programs inside. The
  // shell that ran ship still is, so a copy someone stands in waits for the
  // delayed remover instead of vanishing under them.
  if (space.isInside(process.cwd(), copy)) {
    try { process.chdir(mainRoot); } catch { return { removed: false, reason: 'could not step out of the copy', retry: true }; }
  }
  const active = activePaths();
  if (!Array.isArray(active)) return { removed: false, reason: 'could not list running programs', retry: true };
  if (worktreeHasActiveProcess(copy, active)) return { removed: false, reason: 'a program is still working in it', retry: true };
  const kib = sizeKib(copy);
  const removed = runGit(['worktree', 'remove', copy], { cwd: mainRoot, check: false });
  if (removed.status !== 0) return { removed: false, reason: `git refused: ${gitFailureDetail(removed) || 'remove failed'}`, retry: true };
  recordWorktreeRemoval(mainRoot, { path: copy, branch, by: 'atris worktree ship', reason: 'shipped', saved_on: home, size_kib: kib });
  return { removed: true, kib, home, path: copy };
}

// After a successful ship: remove the copy now, or hand a landed copy to the
// delayed remover when something still runs inside it.
function finishShippedCopy({ root, primary, branch, landedOn = '', keep = false, log = console.log, schedule = scheduleShippedCopyRemoval }) {
  const result = removeShippedCopyNow({ root, primary, branch, landedOn, keep });
  if (result.removed) {
    log(`cleanup: removed this build copy and freed ${formatKib(result.kib)}; the work is safe on ${result.home}`);
    return result;
  }
  if (result.retry && !keep) {
    log(`cleanup: not yet (${result.reason})`);
    announceShippedCopyRemoval(schedule({ root, primary, branch, base: landedOn }));
    return result;
  }
  if (!result.quiet) log(`cleanup: kept this build copy (${result.reason})`);
  return result;
}

// The delayed remover for a copy whose branch was pushed but not merged:
// wait for quiet, then retry the same checks ship ran until the copy is free.
function reapPushedCopy({
  primary,
  target,
  branch = '',
  settleMs = SHIP_SETTLE_MS,
  pollMs = SHIP_REAP_POLL_MS,
  giveUpMs = SHIP_REAP_GIVE_UP_MS,
  sleep = sleepSync,
  clock = Date.now,
  remove = removeShippedCopyNow,
} = {}) {
  const startedAt = clock();
  sleep(settleMs);
  for (;;) {
    const result = remove({ root: target, primary, branch });
    if (result.removed) return { removed: true, reason: 'pushed' };
    if (!result.retry || clock() - startedAt >= giveUpMs) return { removed: false, reason: result.reason };
    sleep(pollMs);
  }
}

// Snapshot a copy as two git trees through a throwaway copy of its index, so
// the copy and its own index stay untouched: what is staged, and everything on
// disk including untracked files. Keeping both means a staged version that
// differs from the file on disk survives too.
function snapshotTrees(wtPath) {
  const realIndex = String(runGit(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: wtPath, check: false }).stdout || '').trim();
  const index = path.join(os.tmpdir(), `atris-rescue-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args) => spawnSync('git', args, { cwd: wtPath, encoding: 'utf8', env, maxBuffer: COMMAND_MAX_BUFFER_BYTES, timeout: 120000, killSignal: 'SIGKILL' });
  try {
    if (realIndex && fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index);
    else if (run(['read-tree', 'HEAD']).status !== 0) return null;
    const staged = run(['write-tree']);
    if (staged.status !== 0) return null;
    if (run(['add', '-A']).status !== 0) return null;
    const disk = run(['write-tree']);
    if (disk.status !== 0) return null;
    return { staged: staged.stdout.trim(), disk: disk.stdout.trim() };
  } finally {
    try { fs.rmSync(index, { force: true }); } catch {}
  }
}

function newestChangeMs(wtPath) {
  let newest = lastCopyActivityMs(wtPath);
  const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: wtPath, check: false });
  if (status.status !== 0) return newest;
  const fields = String(status.stdout || '').split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const row = fields[i];
    if (row.length < 4) continue;
    if (row[0] === 'R' || row[0] === 'C') i += 1;
    try { newest = Math.max(newest, fs.lstatSync(path.join(wtPath, row.slice(3))).mtimeMs); } catch {}
  }
  return newest;
}

function commitIdentityEnv(wtPath) {
  const email = runGit(['config', 'user.email'], { cwd: wtPath, check: false });
  const name = runGit(['config', 'user.name'], { cwd: wtPath, check: false });
  const env = { ...process.env };
  if (email.status !== 0 || !email.stdout.trim()) {
    env.GIT_AUTHOR_EMAIL = '299057014+atris-builder[bot]@users.noreply.github.com';
    env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  }
  if (name.status !== 0 || !name.stdout.trim()) {
    env.GIT_AUTHOR_NAME = 'atris worktree sweep';
    env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  }
  return env;
}

// Rescue of abandoned dirty copies. Off unless the sweep runs with --rescue;
// the timer never passes it, and the default sweep only reports these copies.
//
// Guarantee: a dirty copy is removed only when every byte in it is proven
// saved on origin or proven throwaway. The staged and on-disk versions are
// committed onto a brand-new atris-rescue/<copy>-<time> branch, created only
// if the name is free here and on origin, pushed, confirmed on origin, and
// the copy is checked again before removal. No existing branch ever moves.
// Anything unusual keeps the copy for a person, with the reason.
//
// Accepted limits, each of which keeps the copy instead of risking it:
// - ignored files other than installs and caches beside their package file,
//   or atris's own plumbing
// - nested repositories other than a submodule clean at a pushed commit
// - index flags that hide edits, conflicts, sparse checkouts
// - content filters and the ident attribute (on every removal path, clean
//   copies too), and for dirty copies line-ending or encoding conversion
// - a push the remote or its hooks refuse
// What it cannot see: a program that writes into the copy between the last
// check and the removal without holding a file open or standing in it.
//
// Returns { kept } with a reason, { candidate } on a dry run, or { removed }.
function rescueAbandonedCopy({ root, wt, wtPath, item, counts, apply, now, idleMs, rescueIdleMs, rescue = false, activeCwdsOverride, budget, by }) {
  const dirty = Boolean(counts && (counts.staged || counts.unstaged || counts.untracked));
  const baseReason = dirty ? 'dirty' : (wt.branch === 'detached' ? 'detached_unmerged' : 'unmerged');
  const keep = (reason, extra = {}) => ({ kept: { ...item, reason, ...(dirty ? { staged: counts.staged, unstaged: counts.unstaged, untracked: counts.untracked } : {}), ...extra } });
  const named = Boolean(wt.branch && wt.branch !== 'detached');
  if (runGit(['remote', 'get-url', 'origin'], { cwd: root, check: false }).status !== 0) return keep(baseReason, { rescue: 'no origin to push to' });
  const keepers = ignoredFilesToKeep(wtPath);
  if (!keepers) return keep('ignored_scan_failed');
  if (keepers.length) return keep('ignored_data', { files: keepers.slice(0, 5) });
  const unprovable = byteChangingSetting(wtPath, { filtersOnly: !dirty }) || unprovableReason(wtPath);
  if (unprovable) return keep('unprovable', { why: unprovable });
  const headOid = String(runGit(['rev-parse', 'HEAD'], { cwd: wtPath, check: false }).stdout || '').trim();
  if (!headOid) return keep('missing_head');
  const ownRemote = named ? remoteBranchOid(root, wt.branch) : '';
  if (ownRemote === null) return keep(baseReason, { rescue: 'origin unreachable' });
  const alreadySaved = !dirty && named && ownRemote === headOid;
  const idleFor = now - newestChangeMs(wtPath);
  const limit = alreadySaved ? idleMs : rescueIdleMs;
  const idleDays = Math.round((idleFor / DAY_MS) * 10) / 10;
  if (idleFor < limit) return keep(baseReason, { idle_days: idleDays });
  // Without --rescue the sweep only reports a stale copy that needs saving.
  if (!alreadySaved && !rescue) return keep(dirty ? 'stale_dirty' : 'stale_unpushed', { idle_days: idleDays, next: 'atris worktree sweep --rescue' });
  const kib = sizeKib(wtPath);
  if (!kib || budget.count >= 20 || budget.kib + kib > 10 * 1024 * 1024) return keep('size_unknown_or_cleanup_limit');
  const fileCount = dirty ? counts.staged + counts.unstaged + counts.untracked : 0;
  const rescueBranch = alreadySaved ? wt.branch
    : `atris-rescue/${slugify(path.basename(wtPath), 'copy', 60)}-${stamp(new Date(now))}-${Math.random().toString(16).slice(2, 6)}`;
  const candidate = {
    ...item,
    reason: alreadySaved ? 'pushed_branch' : 'rescued_to_branch',
    rescue_branch: rescueBranch,
    changed_files: fileCount,
    idle_days: idleDays,
    size_kib: kib,
  };
  budget.count += 1;
  budget.kib += kib;
  if (!apply) return { candidate };

  const headTree = String(runGit(['rev-parse', 'HEAD^{tree}'], { cwd: wtPath, check: false }).stdout || '').trim();
  const trees = dirty ? snapshotTrees(wtPath) : null;
  if (dirty && !trees) return keep(baseReason, { rescue: 'could not snapshot the changes' });
  let commit = headOid;
  if (dirty) {
    const trailer = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';
    const note = `The sweep found ${path.basename(wtPath)} idle for ${idleDays} days with changes nobody committed. It saved them here before removing the copy. Nothing was reviewed or merged.`;
    const identity = commitIdentityEnv(wtPath);
    const commitTree = (tree, parent, title) => {
      const made = spawnSync('git', ['commit-tree', tree, '-p', parent, '-m', [title, '', note, '', trailer].join('\n')], {
        cwd: wtPath, encoding: 'utf8', env: identity, timeout: 30000, killSignal: 'SIGKILL',
      });
      return made.status === 0 ? made.stdout.trim() : '';
    };
    // Staged work first, then what was on disk on top, so neither version is lost.
    if (trees.staged !== headTree) {
      commit = commitTree(trees.staged, commit, 'Rescue staged work from an abandoned build copy');
      if (!commit) return keep(baseReason, { rescue: 'commit of the staged work failed' });
    }
    if (trees.disk !== trees.staged) {
      commit = commitTree(trees.disk, commit, `Rescue unsaved work from an abandoned build copy (${fileCount} changed files)`);
      if (!commit) return keep(baseReason, { rescue: 'commit of the work on disk failed' });
    }
  }
  if (!alreadySaved) {
    // Fresh name only: refuse if origin or this repo already has it.
    const taken = remoteBranchOid(root, rescueBranch);
    if (taken !== '') return keep('rescue_push_failed', { rescue_branch: rescueBranch, error: taken === null ? 'origin unreachable' : 'rescue branch name already on origin' });
    const zero = '0'.repeat(commit.length);
    const created = runGit(['update-ref', `refs/heads/${rescueBranch}`, commit, zero], { cwd: root, check: false });
    if (created.status !== 0) return keep('rescue_push_failed', { rescue_branch: rescueBranch, error: `could not create the rescue branch: ${gitFailureDetail(created)}` });
    const pushed = runGit(['push', 'origin', `refs/heads/${rescueBranch}:refs/heads/${rescueBranch}`], { cwd: root, check: false });
    if (remoteBranchOid(root, rescueBranch) !== commit) {
      return keep('rescue_push_failed', { rescue_branch: rescueBranch, rescue_commit: commit, error: (gitFailureDetail(pushed) || 'origin does not show the pushed commit').slice(0, 300) });
    }
  }
  const freshActive = Array.isArray(activeCwdsOverride) ? activeCwdsOverride.map(canonicalPath) : listActiveProcessPaths();
  const fresh = worktreeEntry(root, wtPath);
  const freshHead = String(runGit(['rev-parse', 'HEAD'], { cwd: wtPath, check: false }).stdout || '').trim();
  const freshTrees = dirty ? snapshotTrees(wtPath) : null;
  const freshKeepers = ignoredFilesToKeep(wtPath);
  const freshCounts = statusCounts(wtPath);
  if (!Array.isArray(freshActive) || worktreeHasActiveProcess(wtPath, freshActive)
      || !fresh || fresh.locked || freshHead !== headOid
      || (dirty && (!freshTrees || freshTrees.staged !== trees.staged || freshTrees.disk !== trees.disk))
      || !freshKeepers || freshKeepers.length || unprovableReason(wtPath) || byteChangingSetting(wtPath, { filtersOnly: !dirty }) || !freshCounts
      || Boolean(freshCounts.staged || freshCounts.unstaged || freshCounts.untracked) !== dirty) {
    return keep('changed_or_active_during_verification', { rescue_branch: rescueBranch, rescue_commit: commit });
  }
  const removeArgs = dirty ? ['worktree', 'remove', '--force', wtPath] : ['worktree', 'remove', wtPath];
  const removed = runGit(removeArgs, { cwd: root, check: false });
  if (removed.status !== 0) {
    return keep('remove_failed', { rescue_branch: rescueBranch, rescue_commit: commit, error: gitFailureDetail(removed) });
  }
  const originUrl = String(runGit(['remote', 'get-url', 'origin'], { cwd: root, check: false }).stdout || '').trim();
  const rescueRecord = { branch: rescueBranch, commit, remote: originUrl, copy_branch: named ? wt.branch : null, changed_files: fileCount };
  recordWorktreeRemoval(root, { path: wt.path, branch: wt.branch, by, reason: candidate.reason, rescue: rescueRecord, size_kib: kib });
  return { removed: { ...candidate, rescue_commit: commit } };
}

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
  rescueIdleMs = 0,
  rescue = false,
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
  const rescued = [];
  const rescueCandidates = [];
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
    const tryRescue = (dirtyCounts) => {
      const outcome = rescueAbandonedCopy({
        root, wt, wtPath, item, counts: dirtyCounts, apply, now, idleMs, rescueIdleMs, rescue, activeCwdsOverride, budget: cacheBudget, by,
      });
      if (outcome.removed) {
        removed.push(outcome.removed);
        rescued.push(outcome.removed);
      } else if (outcome.candidate) {
        candidates.push(outcome.candidate);
        rescueCandidates.push(outcome.candidate);
      } else {
        if (outcome.kept.reason !== 'changed_or_active_during_verification') pruneCachesForKept(wtPath);
        kept.push(outcome.kept);
      }
    };
    if (counts.staged || counts.unstaged || counts.untracked) {
      if (rescueIdleMs > 0) {
        tryRescue(counts);
        continue;
      }
      pruneCachesForKept(wtPath);
      kept.push({ ...item, reason: 'dirty', staged: counts.staged, unstaged: counts.unstaged, untracked: counts.untracked });
      continue;
    }
    const keepers = ignoredFilesToKeep(wt.path);
    if (!keepers) {
      kept.push({ ...item, reason: 'ignored_scan_failed' });
      continue;
    }
    if (keepers.length) {
      pruneCachesForKept(wtPath);
      kept.push({ ...item, reason: 'ignored_data', files: keepers.slice(0, 5) });
      continue;
    }
    const unprovable = byteChangingSetting(wt.path, { filtersOnly: true }) || unprovableReason(wt.path);
    if (unprovable) {
      pruneCachesForKept(wtPath);
      kept.push({ ...item, reason: 'unprovable', why: unprovable });
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
    if (!merged && rescueIdleMs > 0) {
      tryRescue(null);
      continue;
    }
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
    const freshKeepers = ignoredFilesToKeep(wt.path);
    const freshSize = spawnSync('du', ['-sk', wtPath], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
    const freshMatch = freshSize.status === 0 && !String(freshSize.stderr || '').trim() && String(freshSize.stdout || '').match(/^(\d+)\s/);
    const gitdir = runGit(['rev-parse', '--absolute-git-dir'], { cwd: wtPath, check: false });
    const freshHead = runGit(['rev-parse', 'HEAD'], { cwd: wtPath, check: false });
    if (!Array.isArray(freshActive) || worktreeHasActiveProcess(wtPath, freshActive)
        || !freshCounts || freshCounts.staged || freshCounts.unstaged || freshCounts.untracked
        || !freshKeepers || freshKeepers.length || unprovableReason(wt.path) || byteChangingSetting(wt.path, { filtersOnly: true }) || !freshMatch || Number(freshMatch[1]) !== kib
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

  return { apply, base, candidates, removed, kept, cacheCandidates, cachePruned, rescued, rescueCandidates };
}

const SWEEP_IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_EVERY_HOURS = 3;
const SWEEP_HIDDEN_KEPT = new Set(['primary_checkout', 'current_checkout', 'out_of_scope']);

function sweepWorkspace({ workspace, apply = false, idleMs = SWEEP_IDLE_MS, rescueIdleMs = RESCUE_IDLE_MS, rescue = false, activeCwds, freeSpace = space.freeBytes, by = 'atris worktree sweep', cleanupBudget = null } = {}) {
  const root = path.resolve(workspace);
  const before = freeSpace(root);
  const report = { workspace: root, apply, rescue, idle_ms: idleMs, rescue_idle_ms: rescueIdleMs, before, after: before, repos: [] };
  const scan = Array.isArray(activeCwds) ? activeCwds.map(canonicalPath) : listActiveProcessPaths();
  if (!Array.isArray(scan)) return { ...report, error: 'could not list running programs, so every copy was kept' };
  const scope = path.join(root, space.AGENT_COPIES_DIR);
  cleanupBudget = cleanupBudget || { count: 0, kib: 0 };
  for (const repo of space.agentCopyRepos(root)) {
    const entry = { name: repo.name, root: repo.root };
    try {
      const base = defaultMainlineBase(repo.root);
      if (!base.startsWith('origin/')) {
        report.repos.push({ ...entry, skipped: 'no origin main branch to compare against' });
        continue;
      }
      const shared = Array.isArray(activeCwds) || !apply ? scan : undefined;
      const result = cleanupWorktrees({ root: repo.root, base, apply, activeCwds: shared, by, onlyUnder: scope, idleMs, rescueIdleMs, rescue, cleanupBudget });
      report.repos.push({
        ...entry,
        base: result.base,
        removed: result.removed,
        candidates: result.candidates,
        rescued: result.rescued,
        rescueCandidates: result.rescueCandidates,
        cachePruned: result.cachePruned,
        cacheCandidates: result.cacheCandidates,
        kept: result.kept.filter((item) => !SWEEP_HIDDEN_KEPT.has(item.reason)),
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
  ignored_data: 'holding ignored files that cannot be rebuilt (kept for review)',
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
  rescue_push_failed: 'push of its saved work failed',
  unprovable: 'holding work atris cannot prove it saved',
  stale_dirty: 'stale with unsaved changes (save with --rescue)',
  stale_unpushed: 'stale with commits not on origin (save with --rescue)',
};

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

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

module.exports = {
  ATRIS_BIN,
  reapPushedCopy,
  RESCUE_IDLE_MS,
  finishShippedCopy,
  formatKib,
  SWEEP_IDLE_MS,
  SWEEP_EVERY_HOURS,
  SWEEP_KEPT_LABELS,
  assertOneLapProofTree,
  baseBranchName,
  branchName,
  canonicalPath,
  changedFiles,
  cleanupWorktrees,
  collidingFlights,
  createAgentWorktree,
  createDetachedShipBranch,
  createOrFindPr,
  currentBranch,
  defaultMainlineBase,
  defaultShipTarget,
  defaultStartBase,
  defaultSweepWorkspace,
  deniedLaneForShip,
  describeFlightAge,
  detachedShipBranch,
  findPrimaryRoot,
  flightStampMs,
  gitFailureDetail,
  gitNetworkEnvironment,
  inFlightAgentFlights,
  listActiveProcessPaths,
  listWorktrees,
  lowDiskRefusal,
  mergePrWithRetry,
  newStatusRows,
  normalizeTargetRef,
  parseAgentFlightName,
  parseProcessArgPaths,
  parseWorktrees,
  plural,
  prMergeRef,
  protectedPushRefusal,
  readOneLapProofBinding,
  reapShippedCopy,
  recordWorktreeRemoval,
  refExists,
  refreshMovedMapRefs,
  refreshRemoteRef,
  remoteHead,
  repoRoot,
  restoreRegeneratedAdapterChurn,
  runCommand,
  runGit,
  runShipHealthCheck,
  runShipNets,
  scheduleShippedCopyRemoval,
  shellQuote,
  shipMergeRecord,
  shipNets,
  shippedCopyRemovalPlan,
  slugify,
  stamp,
  statusCounts,
  statusSnapshot,
  swarloClaim,
  sweepSchedulePlan,
  sweepWorkspace,
  taskTokens,
  unstageConductorArtifacts,
  worktreeHasActiveProcess,
  worktreeWithinReapGrace,
};
