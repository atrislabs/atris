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

module.exports = {
  NAMED_SCRATCH_ROOTS,
  genericScratchRoots,
  isGenericScratchRoot,
};
