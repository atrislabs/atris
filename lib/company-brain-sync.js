const fs = require('fs');
const path = require('path');

function changedRange(baseLines, changedLines) {
  let start = 0;
  while (start < baseLines.length && start < changedLines.length && baseLines[start] === changedLines[start]) {
    start += 1;
  }

  let baseEnd = baseLines.length;
  let changedEnd = changedLines.length;
  while (
    baseEnd > start
    && changedEnd > start
    && baseLines[baseEnd - 1] === changedLines[changedEnd - 1]
  ) {
    baseEnd -= 1;
    changedEnd -= 1;
  }

  return {
    start,
    end: baseEnd,
    replacement: changedLines.slice(start, changedEnd),
  };
}

function safeLineMerge(baseContent, localContent, remoteContent) {
  if (localContent === remoteContent) return { ok: true, content: localContent };
  if (localContent === baseContent) return { ok: true, content: remoteContent };
  if (remoteContent === baseContent) return { ok: true, content: localContent };

  // Complete appended lines can be combined independently of which writer arrives first.
  if ((!baseContent || baseContent.endsWith('\n')) &&
      localContent.startsWith(baseContent) && remoteContent.startsWith(baseContent) &&
      localContent.endsWith('\n') && remoteContent.endsWith('\n')) {
    const tails = [localContent.slice(baseContent.length), remoteContent.slice(baseContent.length)];
    const localLines = new Set(tails[0].slice(0, -1).split('\n'));
    if (tails[1].slice(0, -1).split('\n').some(line => localLines.has(line))) {
      return { ok: false, reason: 'appended lines overlap' };
    }
    return { ok: true, content: baseContent + tails.sort().join('') };
  }

  const baseLines = baseContent.split('\n');
  const localRange = changedRange(baseLines, localContent.split('\n'));
  const remoteRange = changedRange(baseLines, remoteContent.split('\n'));
  const sameRange = localRange.start === remoteRange.start && localRange.end === remoteRange.end;
  const sameReplacement = localRange.replacement.length === remoteRange.replacement.length
    && localRange.replacement.every((line, index) => line === remoteRange.replacement[index]);
  if (sameRange && sameReplacement) return { ok: true, content: localContent };

  const overlaps = localRange.start < remoteRange.end && remoteRange.start < localRange.end;
  const sameInsertionPoint = localRange.start === localRange.end
    && remoteRange.start === remoteRange.end
    && localRange.start === remoteRange.start;
  if (overlaps || sameInsertionPoint) {
    return { ok: false, reason: 'local and cloud edits overlap' };
  }

  const merged = baseLines.slice();
  for (const range of [localRange, remoteRange].sort((a, b) => b.start - a.start || b.end - a.end)) {
    merged.splice(range.start, range.end - range.start, ...range.replacement);
  }
  return { ok: true, content: merged.join('\n') };
}

function scopedSyncPath(rootDir, prefix, cloudPath) {
  const rel = String(cloudPath || '').replace(/^\/+/, '');
  const target = path.resolve(rootDir, prefix, rel);
  const base = path.resolve(rootDir, prefix);
  if (!target.startsWith(`${base}${path.sep}`) && target !== base) {
    throw new Error(`Refusing to write outside ${prefix}: ${cloudPath}`);
  }
  return target;
}

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

function buildConflictReviewPacket({ plan, baseContents = {}, localContents = {}, remoteContents = {}, timestamp = 'sync-review' } = {}) {
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
    const basePath = `${packetBase}.base`;
    const localPath = `${packetBase}.local`;
    const remotePath = `${packetBase}.remote`;
    if (Object.prototype.hasOwnProperty.call(baseContents, change.path)) {
      files[basePath] = baseContents[change.path] || '';
    }
    files[localPath] = localContents[change.path] || '';
    files[remotePath] = remoteContents[change.path] || '';
    summary.push(`- ${rel} (${change.status})`);
    if (Object.prototype.hasOwnProperty.call(baseContents, change.path)) {
      summary.push(`  - base: ${basePath}`);
    }
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

function readBaseContent(rootDir, cloudPath) {
  try {
    return fs.readFileSync(scopedSyncPath(rootDir, path.join('.atris', 'sync', 'base'), cloudPath), 'utf8');
  } catch {
    return null;
  }
}

function writeBaseContents(rootDir, contents = {}) {
  const written = [];
  for (const [cloudPath, content] of Object.entries(contents)) {
    if (typeof content !== 'string') continue;
    const fullPath = scopedSyncPath(rootDir, path.join('.atris', 'sync', 'base'), cloudPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    written.push(fullPath);
  }
  return written;
}

function removeBaseContents(rootDir, cloudPaths = []) {
  for (const cloudPath of cloudPaths) {
    fs.rmSync(scopedSyncPath(rootDir, path.join('.atris', 'sync', 'base'), cloudPath), { force: true });
  }
}

module.exports = {
  buildConflictReviewPacket,
  classifyBrainSync,
  classifyPath,
  changedRange,
  safeLineMerge,
  readBaseContent,
  renderSyncSummary,
  removeBaseContents,
  writeBaseContents,
  writeConflictReviewPacket,
};
