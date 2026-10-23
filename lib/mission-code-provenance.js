'use strict';

const fs = require('fs');
const { devNull } = require('os');
const { spawnSync } = require('child_process');

const BASELINE_SCHEMA = 'atris.mission_code_baseline.v1';
const PROVENANCE_SCHEMA = 'atris.mission_code_provenance.v1';
const BOOKKEEPING = ['.atris/', 'atris/runs/', 'atris/status/'];

function fail(reason) {
  throw new Error(reason);
}

function git(root, args, reason = 'git_command_failed') {
  // Disabling replacements alone still permits info/grafts and inherited graft
  // files to rewrite ancestry. Evidence needs the actual commit relationships.
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull };
  // Evidence belongs to this on-disk repository, even when the caller was
  // launched by a Git hook with another index or repository in its environment.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE']) delete env[key];
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env, timeout: 15000, maxBuffer: Infinity,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) fail(reason);
  const text = result.stdout.toString('utf8');
  // A lossy filename decode cannot stand in for a complete path list.
  if (!Buffer.from(text, 'utf8').equals(result.stdout)) fail('git_output_unreadable');
  return text;
}

function repositoryRoot(root) {
  const physical = fs.realpathSync(root);
  const top = git(physical, ['rev-parse', '--show-toplevel'], 'not_git_repository').replace(/\n$/, '');
  if (fs.realpathSync(top) !== physical) fail('root_not_git_top_level');
  return physical;
}

function nulEntries(text) {
  if (!text) return [];
  if (!text.endsWith('\0')) fail('git_output_incomplete');
  return text.slice(0, -1).split('\0');
}

function knownCommit(root, commit) {
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) fail('commit_unavailable');
  if (git(root, ['cat-file', '-t', commit], 'commit_unavailable').trim() !== 'commit') fail('commit_unavailable');
  return commit;
}

function cleanHead(root) {
  const head = knownCommit(root, git(root, ['rev-parse', '--verify', 'HEAD'], 'head_unavailable').trim());
  // Disabling rename detection exposes both paths, including a product file
  // moved into a bookkeeping directory. Every untracked file is inspected.
  const entries = nulEntries(git(root, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none',
  ], 'git_status_unavailable'));
  for (const entry of entries) {
    if (entry.length < 4 || entry[2] !== ' ') fail('git_status_unreadable');
    if (!BOOKKEEPING.some((prefix) => entry.slice(3).startsWith(prefix))) fail('product_dirty');
  }
  if (git(root, ['rev-parse', '--verify', 'HEAD'], 'head_unavailable').trim() !== head) fail('head_changed_during_capture');
  return head;
}

function committedFiles(root, base, head) {
  knownCommit(root, base);
  knownCommit(root, head);
  git(root, ['merge-base', '--is-ancestor', base, head], 'base_not_ancestor');
  // No sample, path filter, or rename folding: deleted and renamed source
  // paths matter as much as additions, including committed bookkeeping.
  return nulEntries(git(root, [
    'diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', base, head, '--',
  ], 'git_diff_unavailable'));
}

function unavailable(schema, error) {
  return { schema, status: 'unavailable', reason: error?.message || 'git_evidence_unavailable' };
}

function captureCodeBaseline(root) {
  try {
    const repo_root = repositoryRoot(root);
    return { schema: BASELINE_SCHEMA, status: 'complete', repo_root, base_commit: cleanHead(repo_root) };
  } catch (error) {
    return unavailable(BASELINE_SCHEMA, error);
  }
}

function collectCodeProvenance(root, baseline) {
  try {
    if (baseline?.schema !== BASELINE_SCHEMA || baseline.status !== 'complete') fail('baseline_unavailable');
    const repo_root = repositoryRoot(root);
    if (baseline.repo_root !== repo_root) fail('baseline_repository_mismatch');
    const head_commit = cleanHead(repo_root);
    const base_commit = baseline.base_commit;
    const files = committedFiles(repo_root, base_commit, head_commit);
    return { schema: PROVENANCE_SCHEMA, status: 'complete', repo_root, base_commit, head_commit, files };
  } catch (error) {
    return unavailable(PROVENANCE_SCHEMA, error);
  }
}

function verifyCodeProvenance(root, provenance) {
  try {
    if (provenance?.schema !== PROVENANCE_SCHEMA || provenance.status !== 'complete' || !Array.isArray(provenance.files)) fail('provenance_unavailable');
    const repo_root = repositoryRoot(root);
    if (provenance.repo_root !== repo_root) fail('provenance_repository_mismatch');
    // Historical evidence stays valid when the current checkout moves on.
    const actual = committedFiles(repo_root, provenance.base_commit, provenance.head_commit);
    if (actual.length !== provenance.files.length || actual.some((file, index) => file !== provenance.files[index])) fail('provenance_files_mismatch');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || 'git_evidence_unavailable' };
  }
}

module.exports = { captureCodeBaseline, collectCodeProvenance, verifyCodeProvenance };
