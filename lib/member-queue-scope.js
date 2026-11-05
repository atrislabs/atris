'use strict';

// Explicit bridge for a supervisor in a linked copy. The queue scope is not
// the worker's filesystem root: checks and work stay in their original copies.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function gitPath(root, flag) {
  const out = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', flag], { encoding: 'utf8', timeout: 5000 });
  if (out.error || out.status !== 0) throw new Error(`cannot verify queue scope for ${root}: ${out.error?.message || String(out.stderr || `git exit ${out.status}`).trim()}`);
  return fs.realpathSync(String(out.stdout).trim());
}

function resolveMemberQueueScope(root, requested = process.env.ATRIS_MEMBER_QUEUE_ROOT || '') {
  const taskDb = require('./task-db');
  const local = taskDb.workspaceRoot(root);
  if (!requested) return { workspaceRoot: local, exactWorkspace: false };
  if (!path.isAbsolute(requested)) throw new Error('member queue root must be an absolute path');
  const scope = fs.realpathSync(requested);
  const localRoot = fs.realpathSync(local);
  const scopeRoot = fs.realpathSync(taskDb.workspaceRoot(scope));
  if (scopeRoot !== scope || gitPath(scope, '--show-toplevel') !== scope || gitPath(localRoot, '--show-toplevel') !== localRoot) {
    throw new Error('member queue root must be a repository root, not a nested workspace');
  }
  if (gitPath(scope, '--git-common-dir') !== gitPath(localRoot, '--git-common-dir')) {
    throw new Error('member queue root must belong to the same Git repository');
  }
  if (scope !== localRoot && (fs.existsSync(path.join(scope, '.atris', 'business.json')) || fs.existsSync(path.join(localRoot, '.atris', 'business.json')))) {
    throw new Error('member queue root cannot cross a business workspace boundary');
  }
  return { workspaceRoot: scope, exactWorkspace: true };
}

function resolveMemberRecordsRoot(root, requested = process.env.ATRIS_MEMBER_RECORDS_ROOT || '') {
  const local = require('./task-db').workspaceRoot(root);
  const records = requested ? resolveMemberQueueScope(local, requested).workspaceRoot : local;
  if (process.env.ATRIS_MEMBER_QUEUE_ROOT) {
    const queue = resolveMemberQueueScope(local, process.env.ATRIS_MEMBER_QUEUE_ROOT).workspaceRoot;
    if (records === queue) throw new Error('member records root must differ from the protected queue root');
  }
  return records;
}

function restoreMemberMissionScope(mission, root, env = process.env) {
  const queue = mission.member_queue_root ? resolveMemberQueueScope(root, mission.member_queue_root).workspaceRoot : '';
  const records = mission.member_records_root ? resolveMemberQueueScope(root, mission.member_records_root).workspaceRoot : '';
  if (queue && records && queue === records) throw new Error('member records root must differ from the protected queue root');
  if (queue) env.ATRIS_MEMBER_QUEUE_ROOT = queue;
  if (mission.local_member_records === true) env.ATRIS_MEMBER_LOCAL_RECORDS = '1';
  if (records) env.ATRIS_MEMBER_RECORDS_ROOT = records;
  if (mission.require_independent_review === true) env.ATRIS_MEMBER_REQUIRE_REVIEW = '1';
}

module.exports = { resolveMemberQueueScope, resolveMemberRecordsRoot, restoreMemberMissionScope };
