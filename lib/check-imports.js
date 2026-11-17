'use strict';

// atris check: one hop of reverse imports. A changed helper also selects the
// checks of the files that import it. Plain parsing, no build tool:
//   JS/TS: import ... from 'x', import('x'), require('x'), export ... from 'x',
//          relative specifiers resolved to a tracked file (with or without
//          extension, or an index file);
//   Python: import a.b and from a.b import c, resolved against the importing
//          file's folder and each folder above it (so backend/ as a source root
//          works), plus relative from .x imports.
// Parsed imports are cached by git blob id under .atris/cache, so a second run
// reads only files that changed. A changed code file in a language this cannot
// read is reported, so the caller can widen (treat it as unmapped).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const JS_EXT = ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
const PY_EXT = ['.py'];
// Code this cannot follow imports for. Data, docs and styles have no imports to follow.
const OTHER_CODE_EXT = ['.go', '.rs', '.swift', '.rb', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm', '.cs', '.php', '.scala', '.dart', '.lua', '.ex', '.exs'];
const CACHE_FILE = path.join('.atris', 'cache', 'check-imports.json');
const CACHE_VERSION = 1;
// One cache file per repo, at most 5 MB. A bigger one is thrown away and rebuilt.
const CACHE_MAX_BYTES = 5 * 1024 * 1024;

function ext(file) {
  return path.posix.extname(file).toLowerCase();
}

function canRead(file) {
  return JS_EXT.includes(ext(file)) || PY_EXT.includes(ext(file));
}

function unreadableCode(file) {
  return OTHER_CODE_EXT.includes(ext(file));
}

function jsSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found].filter((spec) => spec.startsWith('.'));
}

function pySpecifiers(source) {
  const found = new Set();
  for (const line of source.split('\n')) {
    const from = line.match(/^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)/);
    if (from) {
      const names = from[2].replace(/[()]/g, '').split(',').map((name) => name.trim().split(/\s+/)[0]).filter(Boolean);
      found.add(from[1]);
      // `from pkg import mod` may name a module, not only a symbol.
      for (const name of names) if (name !== '*') found.add(from[1].endsWith('.') ? `${from[1]}${name}` : `${from[1]}.${name}`);
      continue;
    }
    const plain = line.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/);
    if (plain) for (const name of plain[1].split(',')) found.add(name.trim());
  }
  return [...found];
}

function specifiersOf(file, source) {
  if (JS_EXT.includes(ext(file))) return jsSpecifiers(source);
  if (PY_EXT.includes(ext(file))) return pySpecifiers(source);
  return [];
}

function resolveJs(importer, spec, tracked) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec));
  const tries = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
  // An import of x.js may point at x.ts in a TypeScript project.
  if (JS_EXT.includes(ext(base))) {
    const stem = base.slice(0, -ext(base).length);
    tries.push(...JS_EXT.map((e) => stem + e));
  }
  return tries.find((candidate) => tracked.has(candidate)) || null;
}

function resolvePy(importer, spec, tracked) {
  const dots = (spec.match(/^\.*/) || [''])[0].length;
  const rest = spec.slice(dots).split('.').filter(Boolean).join('/');
  const roots = [];
  if (dots) {
    let dir = path.posix.dirname(importer);
    for (let i = 1; i < dots; i += 1) dir = path.posix.dirname(dir);
    roots.push(dir);
  } else {
    let dir = path.posix.dirname(importer);
    while (true) {
      roots.push(dir);
      if (dir === '.' || dir === '') break;
      dir = path.posix.dirname(dir);
    }
  }
  for (const root of roots) {
    const stem = root === '.' || root === '' ? rest : (rest ? `${root}/${rest}` : root);
    if (!stem) continue;
    for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) if (tracked.has(candidate)) return candidate;
  }
  return null;
}

function resolve(importer, spec, tracked) {
  if (JS_EXT.includes(ext(importer))) return resolveJs(importer, spec, tracked);
  return resolvePy(importer, spec, tracked);
}

function indexBlobs(root) {
  const result = spawnSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const blobs = new Map();
  for (const row of String(result.stdout || '').split('\0').filter(Boolean)) {
    const match = row.match(/^\d+ ([0-9a-f]+) \d+\t(.+)$/);
    if (match) blobs.set(match[2], match[1]);
  }
  return blobs;
}

function readCache(root) {
  try {
    if (fs.statSync(path.join(root, CACHE_FILE)).size > CACHE_MAX_BYTES) return {};
    const data = JSON.parse(fs.readFileSync(path.join(root, CACHE_FILE), 'utf8'));
    return data && data.version === CACHE_VERSION && data.specs ? data.specs : {};
  } catch {
    return {};
  }
}

function writeCache(root, specs) {
  try {
    const dir = path.join(root, path.dirname(CACHE_FILE));
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
    const text = JSON.stringify({ version: CACHE_VERSION, specs });
    // Over the cap: leave no cache rather than a huge one; the next run reads files again.
    if (Buffer.byteLength(text) > CACHE_MAX_BYTES) { fs.rmSync(path.join(root, CACHE_FILE), { force: true }); return; }
    fs.writeFileSync(path.join(root, CACHE_FILE), text);
  } catch {}
}

// For each changed file, the tracked files that import it directly.
// dirtyFiles are read from disk (their index blob is out of date).
function reverseImporters(root, changedFiles, { dirtyFiles = [] } = {}) {
  const blobs = indexBlobs(root);
  const tracked = new Set(blobs.keys());
  const dirty = new Set(dirtyFiles);
  const cache = readCache(root);
  const fresh = {};
  const wanted = new Set(changedFiles);
  const importers = new Map(changedFiles.map((file) => [file, new Set()]));
  for (const [file, blob] of blobs) {
    if (!canRead(file)) continue;
    let key = blob;
    let specs = null;
    if (dirty.has(file)) {
      let source = '';
      try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
      key = `w${crypto.createHash('sha1').update(source).digest('hex')}`;
      specs = cache[key] || specifiersOf(file, source);
    } else {
      specs = cache[key];
      if (!specs) {
        let source = '';
        try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
        specs = specifiersOf(file, source);
      }
    }
    fresh[key] = specs;
    for (const spec of specs) {
      const target = resolve(file, spec, tracked);
      if (target && target !== file && wanted.has(target)) importers.get(target).add(file);
    }
  }
  writeCache(root, fresh);
  const unreadable = changedFiles.filter(unreadableCode);
  return {
    importers: new Map([...importers].map(([file, set]) => [file, [...set].sort()])),
    unreadable,
  };
}

module.exports = { reverseImporters, jsSpecifiers, pySpecifiers, CACHE_FILE };
