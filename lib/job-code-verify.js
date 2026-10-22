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

// The job's own code: the commit its builder recorded when it differs from
// where the job started, else the commit autoland queued for it. null when
// the job has no commit of its own that this repo holds.
function jobCode(task, root) {
  const top = repoTop(task, root);
  if (!top || !task) return null;
  const metadata = task.metadata || {};
  const has = (sha) => SHA.test(sha) && git(['cat-file', '-e', `${sha}^{commit}`], top).ok;
  const work = String(metadata.work_commit || '').trim();
  const start = String(metadata.start_commit || '').trim();
  if (work && work !== start && has(work)) return { sha: work, source: 'work_commit', top };
  const queued = queuedCommit(task.id, top);
  if (queued && has(queued)) return { sha: queued, source: 'queued_branch', top };
  return null;
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

function runInScratch(verify, code, runVerify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-job-check-'));
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
    return runVerify(verify, dir);
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
  const key = `job:${code.sha}\u0000${String(verify || '').trim()}`;
  if (cache instanceof Map && cache.has(key)) return { ...cache.get(key), reused: true };
  const result = { ...runInScratch(verify, code, runVerifyCommand), code_sha: code.sha, code_source: code.source };
  if (cache instanceof Map) cache.set(key, result);
  return { ...result, reused: false };
}

module.exports = {
  checkedCodeSha,
  runVerifyAtJobCode,
};
