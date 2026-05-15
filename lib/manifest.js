const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { computeContentHash } = require('./journal');

/**
 * Get the manifest file path for a business slug.
 * Stored at ~/.atris/businesses/{slug}/manifest.json
 */
function getManifestPath(slug) {
  return path.join(os.homedir(), '.atris', 'businesses', slug, 'manifest.json');
}

/**
 * Load the manifest for a business, or null if no previous sync.
 */
function loadManifest(slug) {
  const p = getManifestPath(slug);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save a manifest after a successful sync.
 */
function saveManifest(slug, manifest) {
  const p = getManifestPath(slug);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
}

/**
 * Compute SHA-256 hash of normalized content.
 * Delegates to journal.js computeContentHash.
 */
function computeFileHash(content) {
  return computeContentHash(content);
}

/**
 * Build a manifest object from a set of files.
 * files: { [path]: { hash, size } }
 */
function buildManifest(files, commitHash, metadata = {}) {
  return {
    last_sync: new Date().toISOString(),
    last_commit: commitHash || null,
    workspace_root: metadata.workspaceRoot || null,
    files: filterSyncFiles(files),
  };
}

/**
 * Walk a local directory and compute hashes for all text files.
 * Returns: { "/path": { hash, size } }
 */
const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', 'venv', '.venv',
  'lost+found', '.cache', '.atris', '.claude', '.cursor', '.next',
  '.vscode', 'dist', 'build', 'coverage', 'tmp', 'temp',
  // Defense-in-depth: macOS/system dirs that should never be scanned as
  // part of any atris workspace, even if outputDir is accidentally wide.
  'Library', 'Applications', 'System',
]);
const SYNC_ALLOWED_DOT_DIRS = new Set(['.github']);

function isIgnoredSyncPath(filePath) {
  const parts = String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some((part, index) => {
    if (SKIP_DIRS.has(part)) return true;
    return index < parts.length - 1 && part.startsWith('.') && !SYNC_ALLOWED_DOT_DIRS.has(part);
  });
}

function filterSyncFiles(files = {}) {
  return Object.fromEntries(
    Object.entries(files || {}).filter(([filePath]) => !isIgnoredSyncPath(filePath))
  );
}

function isSyncTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.includes(0)) return false;
  return Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);
}

function computeLocalHashes(localDir) {
  const files = {};

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relFromRoot = path.relative(localDir, fullPath);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && !SYNC_ALLOWED_DOT_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue;
        const relPath = '/' + path.relative(localDir, fullPath);
        try {
          // Hash raw bytes to match warm runner's _hash_bytes(data)
          const rawBytes = fs.readFileSync(fullPath);
          if (!isSyncTextBuffer(rawBytes)) continue;
          const hash = crypto.createHash('sha256').update(rawBytes).digest('hex');
          files[relPath] = { hash, size: rawBytes.length };
        } catch {
          // skip binary or unreadable
        }
      }
    }
  }

  walk(localDir);
  return files;
}

/**
 * Three-way comparison between local files, remote files, and the last-synced manifest.
 *
 * localFiles:  { "/path": { hash, size } }
 * remoteFiles: { "/path": { hash, size } }
 * manifest:    { files: { "/path": { hash, size } } } or null (first sync)
 *
 * Returns: { toPull, toPush, conflicts, unchanged, deletedLocal, deletedRemote, newLocal, newRemote }
 * Each array contains file path strings.
 */
function threeWayCompare(localFiles, remoteFiles, manifest) {
  localFiles = filterSyncFiles(localFiles);
  remoteFiles = filterSyncFiles(remoteFiles);

  const result = {
    toPull: [],
    toPush: [],
    conflicts: [],
    unchanged: [],
    deletedLocal: [],
    deletedRemote: [],
    newLocal: [],
    newRemote: [],
  };

  // First sync — no manifest
  if (!manifest || !manifest.files) {
    // Everything remote is "new from remote"
    for (const p of Object.keys(remoteFiles)) {
      if (localFiles[p] && localFiles[p].hash === remoteFiles[p].hash) {
        result.unchanged.push(p);
      } else if (localFiles[p]) {
        // Both exist with different hashes, no baseline — treat as conflict
        result.conflicts.push(p);
      } else {
        result.newRemote.push(p);
      }
    }
    // Local files not in remote are new local
    for (const p of Object.keys(localFiles)) {
      if (!remoteFiles[p]) {
        result.newLocal.push(p);
      }
    }
    return result;
  }

  const base = filterSyncFiles(manifest.files);
  const allPaths = new Set([
    ...Object.keys(localFiles),
    ...Object.keys(remoteFiles),
    ...Object.keys(base),
  ]);

  for (const p of allPaths) {
    const inLocal = p in localFiles;
    const inRemote = p in remoteFiles;
    const inBase = p in base;

    const localHash = inLocal ? localFiles[p].hash : null;
    const remoteHash = inRemote ? remoteFiles[p].hash : null;
    const baseHash = inBase ? base[p].hash : null;

    if (inLocal && inRemote && inBase) {
      // All three exist — standard three-way
      const localChanged = localHash !== baseHash;
      const remoteChanged = remoteHash !== baseHash;

      if (!localChanged && !remoteChanged) {
        result.unchanged.push(p);
      } else if (!localChanged && remoteChanged) {
        result.toPull.push(p);
      } else if (localChanged && !remoteChanged) {
        result.toPush.push(p);
      } else {
        // Both changed
        if (localHash === remoteHash) {
          // Both changed to the same thing
          result.unchanged.push(p);
        } else {
          result.conflicts.push(p);
        }
      }
    } else if (inRemote && !inBase && !inLocal) {
      // New on remote
      result.newRemote.push(p);
    } else if (inLocal && !inBase && !inRemote) {
      // New locally
      result.newLocal.push(p);
    } else if (inBase && !inRemote && inLocal) {
      // Was in base, deleted on remote, still local
      result.deletedRemote.push(p);
    } else if (inBase && !inLocal && inRemote) {
      // Was in base, deleted locally, still remote
      result.deletedLocal.push(p);
    } else if (inBase && !inLocal && !inRemote) {
      // Deleted on both sides — nothing to do
      // (don't add to any list)
    } else if (inLocal && inRemote && !inBase) {
      // Both sides have it but no base — new on both
      if (localHash === remoteHash) {
        result.unchanged.push(p);
      } else {
        result.conflicts.push(p);
      }
    } else if (inRemote && inBase && !inLocal) {
      // Deleted locally but remote still has it (and maybe changed)
      result.deletedLocal.push(p);
    } else if (inLocal && inBase && !inRemote) {
      // Deleted on remote but local still has it (and maybe changed)
      result.deletedRemote.push(p);
    }
  }

  return result;
}

module.exports = {
  loadManifest,
  saveManifest,
  computeFileHash,
  buildManifest,
  computeLocalHashes,
  threeWayCompare,
  getManifestPath,
  SKIP_DIRS,
  isIgnoredSyncPath,
  filterSyncFiles,
  isSyncTextBuffer,
};
