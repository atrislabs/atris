const fs = require('fs');
const path = require('path');

function classifyPath({ path, base, local, remote }) {
  const inBase = Boolean(base);
  const inLocal = Boolean(local);
  const inRemote = Boolean(remote);
  const baseHash = base && base.hash;
  const localHash = local && local.hash;
  const remoteHash = remote && remote.hash;

  if (inLocal && inRemote && inBase) {
    const localChanged = localHash !== baseHash;
    const remoteChanged = remoteHash !== baseHash;
    if (!localChanged && !remoteChanged) return { path, status: 'unchanged', action: 'none' };
    if (localChanged && !remoteChanged) return { path, status: 'local_updated', action: 'push' };
    if (!localChanged && remoteChanged) return { path, status: 'remote_updated', action: 'pull' };
    if (localHash === remoteHash) return { path, status: 'converged', action: 'record' };
    return { path, status: 'conflict_updated', action: 'review' };
  }

  if (!inBase && inLocal && !inRemote) return { path, status: 'local_created', action: 'push' };
  if (!inBase && !inLocal && inRemote) return { path, status: 'remote_created', action: 'pull' };
  if (!inBase && inLocal && inRemote) {
    if (localHash === remoteHash) return { path, status: 'converged', action: 'record' };
    return { path, status: 'conflict_created', action: 'review' };
  }

  if (inBase && !inLocal && inRemote) {
    if (remoteHash === baseHash) return { path, status: 'local_deleted', action: 'hold_delete' };
    return { path, status: 'conflict_local_deleted_remote_updated', action: 'review' };
  }

  if (inBase && inLocal && !inRemote) {
    if (localHash === baseHash) return { path, status: 'remote_deleted', action: 'pull_delete' };
    return { path, status: 'conflict_remote_deleted_local_updated', action: 'review' };
  }

  if (inBase && !inLocal && !inRemote) return { path, status: 'deleted_both', action: 'record' };

  return { path, status: 'unknown', action: 'review' };
}

function classifyBrainSync({ baseFiles = {}, localFiles = {}, remoteFiles = {}, scopePrefixes = ['/atris/'] } = {}) {
  const inScope = (p) => !scopePrefixes || scopePrefixes.length === 0 || scopePrefixes.some((prefix) => p.startsWith(prefix));
  const paths = new Set([
    ...Object.keys(baseFiles),
    ...Object.keys(localFiles),
    ...Object.keys(remoteFiles),
  ].filter(inScope));

  const changes = [...paths].sort().map((p) => classifyPath({
    path: p,
    base: baseFiles[p],
    local: localFiles[p],
    remote: remoteFiles[p],
  }));

  const summary = {
    push: changes.filter((c) => c.action === 'push').length,
    pull: changes.filter((c) => c.action === 'pull' || c.action === 'pull_delete').length,
    review: changes.filter((c) => c.action === 'review').length,
    holdDelete: changes.filter((c) => c.action === 'hold_delete').length,
    unchanged: changes.filter((c) => c.action === 'none' || c.action === 'record').length,
  };

  return { changes, summary };
}

function renderSyncSummary(plan) {
  const lines = [];
  lines.push('Company brain sync');
  lines.push(`  push: ${plan.summary.push}`);
  lines.push(`  pull: ${plan.summary.pull}`);
  lines.push(`  review: ${plan.summary.review}`);
  lines.push(`  held deletes: ${plan.summary.holdDelete}`);
  if (plan.summary.review > 0) {
    lines.push('');
    lines.push('Needs review:');
    for (const change of plan.changes.filter((c) => c.action === 'review')) {
      lines.push(`  - ${change.path.replace(/^\//, '')} (${change.status})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildConflictReviewPacket({ plan, localContents = {}, remoteContents = {}, timestamp = 'sync-review' } = {}) {
  const conflicts = (plan && plan.changes ? plan.changes : []).filter((change) => change.action === 'review');
  const files = {};
  const summary = [];

  summary.push('# Company Brain Sync Review');
  summary.push('');
  summary.push(`Created: ${timestamp}`);
  summary.push('');
  summary.push(`${conflicts.length} file${conflicts.length === 1 ? '' : 's'} need review before publishing.`);
  summary.push('');

  for (const change of conflicts) {
    const rel = change.path.replace(/^\/+/, '');
    const packetBase = `.atris/sync/conflicts/${timestamp}/${rel}`;
    const localPath = `${packetBase}.local`;
    const remotePath = `${packetBase}.remote`;
    files[localPath] = localContents[change.path] || '';
    files[remotePath] = remoteContents[change.path] || '';
    summary.push(`- ${rel} (${change.status})`);
    summary.push(`  - local: ${localPath}`);
    summary.push(`  - remote: ${remotePath}`);
  }

  files[`.atris/sync/conflicts/${timestamp}/summary.md`] = `${summary.join('\n')}\n`;
  return { files, conflicts };
}

function writeConflictReviewPacket(rootDir, packet) {
  const written = [];
  for (const [relPath, content] of Object.entries((packet && packet.files) || {})) {
    const fullPath = path.join(rootDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    written.push(fullPath);
  }
  return written;
}

module.exports = {
  buildConflictReviewPacket,
  classifyBrainSync,
  classifyPath,
  renderSyncSummary,
  writeConflictReviewPacket,
};
