'use strict';

const fs = require('fs');
const path = require('path');

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

function listFiles(dir, { strict = false, missingRootOkay = false } = {}) {
  const out = [];
  function visit(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (strict && !(missingRootOkay && current === dir && error.code === 'ENOENT')) {
        throw new Error(`cannot safely scan run references: ${error.message}`, { cause: error });
      }
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (strict && entry.isSymbolicLink()) {
        throw new Error('cannot safely scan run references: symbolic link in state');
      }
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
  const stateParent = path.join(root, '.atris');
  const stateDir = path.join(stateParent, 'state');
  for (const dir of [stateParent, stateDir]) {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) {
        throw new Error('symbolic link in state');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`cannot safely scan run references: ${error.message}`, { cause: error });
      }
    }
  }
  const refs = new Set();
  const pattern = /atris\/runs\/[A-Za-z0-9._~:/@%+=,-]+(?:\/[A-Za-z0-9._~:@%+=,-]+)*/g;
  const scan = (filePath) => {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new Error(`cannot safely scan run references: ${error.message}`, { cause: error });
    }
    for (const match of text.matchAll(pattern)) {
      refs.add(match[0].replace(/[)"'`.,;]+$/g, ''));
    }
  };
  for (const filePath of listFiles(stateDir, { strict: true, missingRootOkay: true })) scan(filePath);
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
  const totalBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  const decisions = files.map((entry) => {
    const reasons = [];
    if (entry.referenced) reasons.push('referenced');
    if (newest.has(entry.path)) reasons.push('newest');
    if (entry.mtime_ms >= cutoffMs) reasons.push('recent');
    const prune = reasons.length === 0;
    return { ...entry, prune, keep_reasons: reasons };
  });
  const candidates = decisions.filter((entry) => entry.prune);
  if (apply) {
    throw new Error('receipt deletion is unavailable while reference writers are not coordinated; preview remains available');
  }
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
    reference_scan_complete: false,
    deletion_available: false,
    safe_to_delete: false,
    policy: { keep_newest: keepNewest, keep_days: keepDays, archive },
    total_files: files.length,
    total_bytes: totalBytes,
    referenced_files: decisions.filter((entry) => entry.keep_reasons.includes('referenced')).length,
    recent_files: decisions.filter((entry) => entry.keep_reasons.includes('recent')).length,
    newest_files: decisions.filter((entry) => entry.keep_reasons.includes('newest')).length,
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
    `  Changed: Found ${result.prune_count} potential candidate file(s); nothing was deleted.`,
    `  How I checked: Scanned ${result.total_files} files in ${result.runs_dir}; the reference scan is incomplete and can miss live references.`,
    `  Proof: Potential candidates total ${formatBytes(result.prune_bytes)}; this is not a safe deletion list.`,
    '  Next: Receipt deletion is unavailable until reference writers coordinate.',
  ];
}

module.exports = {
  pruneRuns,
  runsPruneLines,
  formatBytes,
};
