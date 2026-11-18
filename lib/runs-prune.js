'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function stampIso() {
  return new Date().toISOString();
}

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function listFiles(dir) {
  const out = [];
  function visit(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '_archive') continue;
        visit(fullPath);
        continue;
      }
      if (entry.isFile()) out.push(fullPath);
    }
  }
  visit(dir);
  return out;
}

function runPathReferences(root) {
  const stateDir = path.join(root, '.atris', 'state');
  const refs = new Set();
  const pattern = /atris\/runs\/[A-Za-z0-9._~:/@%+=,-]+(?:\/[A-Za-z0-9._~:@%+=,-]+)*/g;
  const scan = (filePath) => {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    for (const match of text.matchAll(pattern)) {
      refs.add(match[0].replace(/[)"'`.,;]+$/g, ''));
    }
  };
  if (fs.existsSync(stateDir)) {
    for (const filePath of listFiles(stateDir)) scan(filePath);
  }
  return refs;
}

function referencedDirs(refs) {
  const dirs = new Set();
  for (const ref of refs) {
    const dir = path.posix.dirname(ref);
    if (dir && dir !== '.' && dir !== 'atris/runs') dirs.add(dir);
  }
  return dirs;
}

function runEntry(root, filePath, refs, refDirs, nowMs) {
  const rel = toPosixPath(path.relative(root, filePath));
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const dir = path.posix.dirname(rel);
  const referenced = refs.has(rel) || refDirs.has(dir);
  return {
    path: rel,
    absolute_path: filePath,
    bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    age_days: Math.max(0, Math.floor((nowMs - stat.mtimeMs) / 86400000)),
    referenced,
    kind: path.extname(filePath).toLowerCase().replace(/^\./, '') || 'file',
  };
}

function compactJsonReceipt(filePath) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  return {
    schema: parsed.schema || null,
    mission_id: parsed.mission_id || parsed.mission?.id || null,
    objective: parsed.objective || parsed.mission?.objective || null,
    owner: parsed.owner || parsed.mission?.owner || null,
    at: parsed.at || parsed.generated_at || parsed.created_at || null,
    verifier: parsed.verifier || parsed.result?.verifier_result?.command || null,
    passed: parsed.result?.passed === true || parsed.result?.verifier_result?.passed === true || null,
    kind: parsed.result?.kind || parsed.action || null,
    summary: parsed.result?.tick?.summary || parsed.result?.summary || parsed.landing?.happened || null,
  };
}

function removeEmptyDirs(dir, stopDir) {
  let current = dir;
  while (current && current.startsWith(stopDir) && current !== stopDir) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

// The kind of a run record: its folder plus its name with the date or
// counter cut off, so autoland-tick-2026-11-17T08-14-04-995Z.json is
// atris/runs/autoland-tick. The newest record of every kind is always kept.
function recordKind(rel) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const stem = base.replace(/[-_.]?\d.*$/, '') || base.replace(/\.[^.]+$/, '');
  return `${dir}/${stem}`;
}

// Run files git tracks, as paths from the root. null when git could not say,
// so a caller that asked for tracked files to be kept prunes nothing.
function trackedRunFiles(root, runsDir) {
  const rel = toPosixPath(path.relative(root, runsDir)) || '.';
  const listed = spawnSync('git', ['ls-files', '-z', '--', rel], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', timeout: 10000 });
    // Not a git folder at all: nothing is tracked.
    if (inside.status !== 0 && /not a git repository/i.test(String(inside.stderr || ''))) return new Set();
    return null;
  }
  return new Set(String(listed.stdout || '').split('\0').filter(Boolean).map(toPosixPath));
}

function pruneRuns(root = process.cwd(), options = {}) {
  const runsDir = options.runsDir || path.join(root, 'atris', 'runs');
  const apply = options.apply === true;
  const archive = options.archive !== false;
  const keepNewest = Number.isFinite(options.keepNewest) ? Math.max(0, Math.floor(options.keepNewest)) : 200;
  const keepDays = Number.isFinite(options.keepDays) ? Math.max(0, Math.floor(options.keepDays)) : 14;
  const nowMs = options.nowMs || Date.now();
  const cutoffMs = nowMs - keepDays * 86400000;
  const refs = runPathReferences(root);
  const refDirs = referencedDirs(refs);
  const files = fs.existsSync(runsDir)
    ? listFiles(runsDir).map((filePath) => runEntry(root, filePath, refs, refDirs, nowMs)).filter(Boolean)
    : [];
  const newest = new Set(
    files
      .slice()
      .sort((a, b) => b.mtime_ms - a.mtime_ms || a.path.localeCompare(b.path))
      .slice(0, keepNewest)
      .map((entry) => entry.path),
  );
  const newestOfKind = new Map();
  for (const entry of files) {
    const kind = recordKind(entry.path);
    const held = newestOfKind.get(kind);
    if (!held || entry.mtime_ms > held.mtime_ms) newestOfKind.set(kind, entry);
  }
  const kindNewest = options.keepNewestOfKind ? new Set([...newestOfKind.values()].map((entry) => entry.path)) : new Set();
  const tracked = options.skipTracked ? trackedRunFiles(root, runsDir) : new Set();
  const totalBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  const decisions = files.map((entry) => {
    const reasons = [];
    if (entry.referenced) reasons.push('referenced');
    if (newest.has(entry.path)) reasons.push('newest');
    if (kindNewest.has(entry.path)) reasons.push('newest_of_kind');
    if (tracked === null || tracked.has(entry.path)) reasons.push('tracked');
    if (entry.mtime_ms >= cutoffMs) reasons.push('recent');
    const prune = reasons.length === 0;
    return { ...entry, prune, keep_reasons: reasons };
  });
  const candidates = decisions.filter((entry) => entry.prune);
  const archiveEntries = archive
    ? candidates.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      age_days: entry.age_days,
      compact: entry.kind === 'json' ? compactJsonReceipt(entry.absolute_path) : null,
    }))
    : [];
  let manifestPath = null;
  const deleted = [];
  const errors = [];
  if (apply && candidates.length) {
    const archiveDir = path.join(runsDir, '_archive');
    if (archive) {
      fs.mkdirSync(archiveDir, { recursive: true });
      manifestPath = path.join(archiveDir, `prune-${stampIso().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify({
        schema: 'atris.runs_prune_manifest.v1',
        generated_at: stampIso(),
        policy: { keep_newest: keepNewest, keep_days: keepDays },
        pruned_count: candidates.length,
        pruned_bytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0),
        entries: archiveEntries,
      }, null, 2) + '\n', 'utf8');
    }
    for (const entry of candidates) {
      try {
        fs.unlinkSync(entry.absolute_path);
        deleted.push(entry.path);
        removeEmptyDirs(path.dirname(entry.absolute_path), runsDir);
      } catch (error) {
        errors.push({ path: entry.path, error: error.message || String(error) });
      }
    }
  }
  return {
    schema: 'atris.runs_prune_preview.v1',
    action: apply ? 'runs_pruned' : 'runs_prune_preview',
    runs_dir: toPosixPath(path.relative(root, runsDir)) || 'atris/runs',
    applied: apply,
    policy: { keep_newest: keepNewest, keep_days: keepDays, archive },
    total_files: files.length,
    total_bytes: totalBytes,
    referenced_files: decisions.filter((entry) => entry.keep_reasons.includes('referenced')).length,
    recent_files: decisions.filter((entry) => entry.keep_reasons.includes('recent')).length,
    newest_files: decisions.filter((entry) => entry.keep_reasons.includes('newest')).length,
    newest_of_kind_files: decisions.filter((entry) => entry.keep_reasons.includes('newest_of_kind')).length,
    tracked_files: decisions.filter((entry) => entry.keep_reasons.includes('tracked')).length,
    prune_count: candidates.length,
    prune_bytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0),
    deleted_count: deleted.length,
    manifest_path: manifestPath ? toPosixPath(path.relative(root, manifestPath)) : null,
    candidates: candidates.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      age_days: entry.age_days,
      kind: entry.kind,
    })),
    deleted,
    errors,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function runsPruneLines(result) {
  return [
    'Landing:',
    `  Changed: ${result.applied ? `Pruned ${result.deleted_count} old run file(s).` : `Found ${result.prune_count} old run file(s) eligible for pruning.`}`,
    `  How I checked: Scanned ${result.total_files} files in ${result.runs_dir}; kept referenced, newest, and recent proof.`,
    `  Proof: ${result.applied ? (result.manifest_path ? `Manifest saved at ${result.manifest_path}.` : 'No manifest was needed.') : `Would reclaim ${formatBytes(result.prune_bytes)}.`}`,
    `  Next: ${result.applied ? 'Run this command on a heartbeat when the run folder grows again.' : 'Run again with --apply to delete the eligible old files.'}`,
  ];
}

// The hourly tick's daily prune: keep the newest 200 and the last 14 days,
// plus every record a task or state file names, the newest of each kind and
// every file git tracks. A run folder git does not ignore is left alone, since
// someone keeps those records in the repository on purpose.
function autoPruneRuns(root, { apply = false, nowMs, runsDir = path.join(root, 'atris', 'runs') } = {}) {
  if (!fs.existsSync(runsDir)) return { skipped: 'no_runs_folder' };
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (inside.status === 0) {
    const probe = path.join(toPosixPath(path.relative(root, runsDir)) || '.', 'autoland-tick-probe.json');
    const ignored = spawnSync('git', ['check-ignore', '-q', '--', probe], { cwd: root, encoding: 'utf8', timeout: 10000 });
    if (ignored.status === 1) return { skipped: 'kept_in_git' };
    if (ignored.status !== 0) return { skipped: 'git_could_not_say' };
  }
  const result = pruneRuns(root, { runsDir, apply, keepNewest: 200, keepDays: 14, skipTracked: true, keepNewestOfKind: true, nowMs });
  return {
    applied: result.applied,
    total_files: result.total_files,
    total_bytes: result.total_bytes,
    prune_count: result.prune_count,
    prune_bytes: result.prune_bytes,
    deleted_count: result.deleted_count,
    tracked_files: result.tracked_files,
    referenced_files: result.referenced_files,
    manifest_path: result.manifest_path,
    errors: result.errors.length,
  };
}

module.exports = {
  autoPruneRuns,
  recordKind,
  pruneRuns,
  runsPruneLines,
  formatBytes,
};
