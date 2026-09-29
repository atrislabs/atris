'use strict';

// Speed caches that must never be committed. They live in .atris/cache, a
// folder that carries its own .gitignore of `*`, so a project with no ignore
// rule for .atris still never stages them with `git add -A`. Caches are only
// kept in folders that already have .atris; elsewhere nothing is written.

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join('.atris', 'cache');

function cacheEnabled(root) {
  try {
    return fs.statSync(path.join(root, '.atris')).isDirectory();
  } catch {
    return false;
  }
}

function cachePath(root, name) {
  return path.join(root, CACHE_DIR, name);
}

// The parsed cache file, or null when it is missing or unreadable.
function readCacheJson(root, name) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(root, name), 'utf8'));
  } catch {
    return null;
  }
}

// Returns false when the write failed; a cache is only a speedup.
function writeCacheJson(root, name, value) {
  const dir = path.join(root, CACHE_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const file = cachePath(root, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { CACHE_DIR, cacheEnabled, cachePath, readCacheJson, writeCacheJson };
