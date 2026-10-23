'use strict';

// The second check and the landing re-check run against the job's own code.
//
// They used to run in the main folder, so a job whose test exists only on its
// own branch failed every hour (the test file was simply not there), and a
// job that broke nothing on its branch was judged by whatever the main folder
// held. Same pattern as lib/land-green.js: a scratch copy at the job's commit,
// the check runs there, the copy is removed after. A job with no commit of its
// own (or one that cannot be found) keeps the old behavior and runs where the
// job lives.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SHA = /^[0-9a-f]{40,64}$/;

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  return { ok: res.status === 0, out: String(res.stdout || '').trim(), err: String(res.stderr || '').trim() };
}

function isDir(dir) {
  try {
    return Boolean(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function repoTop(task, root) {
  for (const dir of [task && task.workspace_root, root, process.cwd()]) {
    if (!isDir(dir)) continue;
    const top = git(['rev-parse', '--show-toplevel'], dir);
    if (top.ok && top.out) return top.out;
  }
  return null;
}

// The commit autoland queued for this job, when it is on the autoland list.
function queuedCommit(taskId, top) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], top);
  if (!common.ok) return null;
  try {
    const file = path.join(path.dirname(common.out), '.atris', 'state', 'autoland-queue.json');
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries || {};
    for (const entry of Object.values(entries)) {
      if (entry && Array.isArray(entry.task_ids) && entry.task_ids.includes(taskId) && SHA.test(String(entry.pushed || ''))) return entry.pushed;
    }
  } catch {}
  return null;
}

// The job's own code: the commit autoland queued for it (what is actually on
// GitHub, catch-ups included), else the commit its builder recorded when it
// differs from where the job started. null when the job has no commit of its
// own. A recorded commit this repo does not hold comes back as missing, so
// the job is never judged by the main folder instead.
function jobCode(task, root) {
  const top = repoTop(task, root);
  if (!top || !task) return null;
  const metadata = task.metadata || {};
  const has = (sha) => SHA.test(sha) && git(['cat-file', '-e', `${sha}^{commit}`], top).ok;
  const queued = queuedCommit(task.id, top);
  if (queued && has(queued)) return { sha: queued, source: 'queued_branch', top };
  const work = String(metadata.work_commit || '').trim();
  const start = String(metadata.start_commit || '').trim();
  if (SHA.test(work) && work !== start) return has(work) ? { sha: work, source: 'work_commit', top } : { sha: work, source: 'work_commit', top, missing: true };
  if (queued) return { sha: queued, source: 'queued_branch', top, missing: true };
  return null;
}

// Where in the scratch copy the job's check runs: the same place inside the
// repo as the folder the job lives in.
function scratchCwd(dir, task, top) {
  let workspace = task && task.workspace_root;
  try { workspace = fs.realpathSync(workspace); } catch { return dir; }
  const rel = path.relative(top, workspace);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return dir;
  const inside = path.join(dir, rel);
  return isDir(inside) ? inside : dir;
}

const SCRATCH_PREFIX = 'atris-job-check-';
const STALE_SCRATCH_MS = 2 * 60 * 60 * 1000;

// A pass killed mid-check (a timeout kill skips cleanup) leaves its scratch
// copy behind. Remove copies older than two hours, then drop their records.
function sweepStaleScratch(top) {
  let removed = 0;
  for (const name of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(SCRATCH_PREFIX))) {
    const dir = path.join(os.tmpdir(), name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < STALE_SCRATCH_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  if (removed) git(['worktree', 'prune'], top);
}

function checkoutHead(dir) {
  const head = git(['rev-parse', 'HEAD'], dir || process.cwd());
  return head.ok ? head.out : null;
}

// The code a check of this job runs against right now.
function checkedCodeSha(task, root) {
  const code = jobCode(task, root);
  return code ? code.sha : checkoutHead((task && task.workspace_root) || root);
}

function runInScratch(verify, code, task, runVerify) {
  try { sweepStaleScratch(code.top); } catch {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  const added = git(['worktree', 'add', '--detach', dir, code.sha], code.top);
  if (!added.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    return {
      ok: false, reason: 'verify_unrunnable', unrunnable_cause: 'job_code_checkout_failed', alarm: true,
      detail: (added.err || added.out).split('\n')[0],
    };
  }
  try {
    // Zero-dependency projects need nothing; others reuse the main folder's
    // installed packages instead of installing per check.
    const modules = path.join(code.top, 'node_modules');
    if (isDir(modules) && !fs.existsSync(path.join(dir, 'node_modules'))) {
      try { fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir'); } catch {}
    }
    return runVerify(verify, scratchCwd(dir, task, code.top));
  } finally {
    git(['worktree', 'remove', '--force', dir], code.top);
    fs.rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'prune'], code.top);
  }
}

// Run `verify` for this job against its own code. The result carries the
// commit it ran on (code_sha) and where that commit came from (code_source:
// work_commit, queued_branch, or checkout for the old main-folder run).
function runVerifyAtJobCode(verify, task, { root, cache = null } = {}) {
  const { runVerifyCommand, runVerifyCommandCached } = require('./auto-accept-certified');
  const workspace = (task && task.workspace_root) || root || process.cwd();
  const code = jobCode(task, root);
  if (!code) {
    const result = runVerifyCommandCached(verify, workspace, cache);
    return { ...result, code_sha: checkoutHead(workspace), code_source: 'checkout' };
  }
  if (code.missing) {
    return {
      ok: false, reason: 'verify_unrunnable', unrunnable_cause: 'job_code_missing', alarm: true,
      detail: `the job's commit ${code.sha.slice(0, 10)} is not in this repo; fetch it or record the job's commit again`,
      code_sha: code.sha, code_source: code.source,
    };
  }
  const key = `job:${code.sha}\u0000${(task && task.workspace_root) || ''}\u0000${String(verify || '').trim()}`;
  if (cache instanceof Map && cache.has(key)) return { ...cache.get(key), reused: true };
  const result = { ...runInScratch(verify, code, task, runVerifyCommand), code_sha: code.sha, code_source: code.source };
  if (cache instanceof Map) cache.set(key, result);
  return { ...result, reused: false };
}

// The remote's main line: what origin/HEAD names, else master, then main.
function mainBranchCandidates(top) {
  const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], top);
  const named = head.ok && head.out.startsWith('origin/') ? [head.out.slice('origin/'.length)] : [];
  return [...new Set([...named, 'master', 'main'])];
}

// The main line, fetched fresh into a private ref (refs/atris/verify-
// <branch>), so neither a narrow fetch setting nor an old cached
// origin/<branch> can stand in for it. null when nothing could be fetched.
function fetchFreshMain(top) {
  for (const branch of mainBranchCandidates(top)) {
    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) continue;
    const ref = `refs/atris/verify-${branch.replace(/\//g, '-')}`;
    if (!git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${ref}`], top).ok) continue;
    const tip = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], top);
    return tip.ok && SHA.test(tip.out) ? { branch, ref, tip: tip.out } : null;
  }
  return null;
}

function inMain(top, sha, tip) {
  if (!/^[0-9a-f]{7,64}$/.test(String(sha || ''))) return false;
  return git(['merge-base', '--is-ancestor', sha, tip], top).ok;
}

// What GitHub says about a PR: { state, merge_sha } or null.
function defaultPrState(pr, top) {
  const res = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'state,mergeCommit'], { cwd: top, encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) return null;
  try {
    const data = JSON.parse(res.stdout);
    return { state: String(data.state || ''), merge_sha: data.mergeCommit && data.mergeCommit.oid ? String(data.mergeCommit.oid) : null };
  } catch {
    return null;
  }
}

// The first landing (newest first) proven in the fresh main line: a commit
// that is in it, or a merged PR whose merge commit is in it.
function provenLanding(top, landings, tip, prState) {
  for (const landing of landings) {
    if (landing.sha && inMain(top, landing.sha, tip)) return { pr: landing.pr || null, sha: landing.sha, proof: 'sha_in_main' };
    if (Number.isInteger(landing.pr)) {
      const state = prState(landing.pr, top);
      if (state && state.state === 'MERGED' && state.merge_sha && inMain(top, state.merge_sha, tip)) {
        return { pr: landing.pr, sha: state.merge_sha, proof: 'pr_merged' };
      }
    }
  }
  return null;
}

// Run `verify` in a throwaway copy of the freshly fetched main line, only
// when one of the mission's recorded landings is proven to be in it. null
// otherwise (no remote, a failed fetch, no proof, or the folder already is
// that commit), and the caller keeps its local result.
function runVerifyAtProvenLanding(verify, { root, landings = [], runVerify, prState = defaultPrState } = {}) {
  const top = repoTop(null, root);
  if (!top || typeof runVerify !== 'function' || !landings.length) return null;
  if (!git(['remote', 'get-url', 'origin'], top).ok) return null;
  const main = fetchFreshMain(top);
  if (!main) return null;
  const proof = provenLanding(top, landings, main.tip, prState);
  if (!proof) return null;
  if (checkoutHead(root) === main.tip) return null;
  const result = runInScratch(verify, { sha: main.tip, top }, { workspace_root: root }, runVerify);
  return { ...result, code_sha: main.tip, code_source: `origin/${main.branch}`, landing_proof: proof };
}

module.exports = {
  checkedCodeSha,
  runVerifyAtJobCode,
  runVerifyAtProvenLanding,
};
