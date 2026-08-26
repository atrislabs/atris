'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Generic scratch roots. A workspace may live here (dogfood happens), but a
// child folder is its own room and must not inherit that parent.
// first-minute folderName already treats these as "this folder".
const NAMED_SCRATCH_ROOTS = ['/tmp', '/private/tmp', '/var/tmp'];

function pathKey(dir) {
  return path.resolve(dir || '.').replace(/\\/g, '/');
}

function genericScratchRoots() {
  const keys = new Set(NAMED_SCRATCH_ROOTS.map(pathKey));
  try {
    keys.add(pathKey(os.tmpdir()));
  } catch {
    // os.tmpdir can throw in locked-down hosts.
  }
  const resolved = new Set(keys);
  for (const key of keys) {
    try {
      resolved.add(pathKey(fs.realpathSync(key)));
    } catch {
      // Missing or unreadable roots stay as the unresolved key.
    }
  }
  return resolved;
}

function isGenericScratchRoot(dir) {
  if (!dir) return false;
  const roots = genericScratchRoots();
  const key = pathKey(dir);
  if (roots.has(key)) return true;
  try {
    return roots.has(pathKey(fs.realpathSync(dir)));
  } catch {
    return false;
  }
}

function keyUnderScratchRoot(key, roots) {
  for (const root of roots) {
    if (key === root || key.startsWith(`${root}/`)) return true;
  }
  return false;
}

function isUnderGenericScratchRoot(dir) {
  if (!dir) return false;
  const roots = genericScratchRoots();
  const key = pathKey(dir);
  if (keyUnderScratchRoot(key, roots)) return true;
  try {
    return keyUnderScratchRoot(pathKey(fs.realpathSync(dir)), roots);
  } catch {
    return false;
  }
}

function hasWorkspaceRoom(dir) {
  const root = path.resolve(dir || '.');
  return fs.existsSync(path.join(root, 'atris'))
    || fs.existsSync(path.join(root, '.atris', 'business.json'));
}

// An empty child under /tmp (or another generic scratch root) is not a room.
// --yes is consent to start, not a workspace unlock. A workspace that already
// lives here (dogfood) still has atris/ or a business binding.
function isUnboundScratchFolder(dir) {
  if (!isUnderGenericScratchRoot(dir)) return false;
  return !hasWorkspaceRoom(dir);
}

const UNBOUND_SCRATCH_MESSAGE = 'this folder is not a room';

function refuseUnboundScratch(write = console.error) {
  write(UNBOUND_SCRATCH_MESSAGE);
  return 2;
}

module.exports = {
  UNBOUND_SCRATCH_MESSAGE,
  isGenericScratchRoot,
  isUnboundScratchFolder,
  isUnderGenericScratchRoot,
  refuseUnboundScratch,
};
