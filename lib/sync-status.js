const fs = require('fs');
const path = require('path');
const { loadManifest, computeLocalHashes, filterSyncFiles } = require('./manifest');

/**
 * Count files whose local hash differs from the last-synced manifest.
 * A path present on only one side (new local, deleted since sync) counts as
 * drifted. Pure function so it is unit-testable without touching disk.
 */
function driftCount(localFiles = {}, manifest = null) {
  const local = filterSyncFiles(localFiles);
  const base = filterSyncFiles(manifest && manifest.files ? manifest.files : {});
  const paths = new Set([...Object.keys(local), ...Object.keys(base)]);
  let drifted = 0;
  for (const p of paths) {
    const l = local[p] ? local[p].hash : null;
    const b = base[p] ? base[p].hash : null;
    if (l !== b) drifted += 1;
  }
  return drifted;
}

/**
 * Resolve the configured cloud business slug for a workspace, or null.
 */
function readBusinessSlug(root) {
  const bizFile = path.join(root, '.atris', 'business.json');
  if (!fs.existsSync(bizFile)) return null;
  try {
    const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
    return biz.slug || biz.name || null;
  } catch {
    return null;
  }
}

/**
 * One-line cloud sync status for the boot surface. Local-only, never blocks:
 *   - "offline"        no cloud business configured or never synced
 *   - "in sync"        every synced file matches the manifest
 *   - "N files drifted" N local files differ from the last sync
 */
function syncStatus(root = process.cwd()) {
  const slug = readBusinessSlug(root);
  if (!slug) return 'offline';
  const manifest = loadManifest(slug);
  if (!manifest) return 'offline';
  let localFiles;
  try {
    localFiles = computeLocalHashes(root);
  } catch {
    return 'offline';
  }
  const n = driftCount(localFiles, manifest);
  if (n === 0) return 'in sync';
  return `${n} file${n === 1 ? '' : 's'} drifted`;
}

module.exports = { driftCount, readBusinessSlug, syncStatus };
