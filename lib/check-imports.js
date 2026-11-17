'use strict';

// atris check: the import graph. A changed helper also selects the checks of
// the files that import it, and the tests that import it directly or one hop
// away. Plain parsing, no build tool:
//   JS/TS: import ... from 'x', import('x'), require('x'), export ... from 'x',
//          relative specifiers resolved to a tracked file (with or without
//          extension, or an index file), and aliases from tsconfig.json or
//          jsconfig.json "paths" (with "baseUrl");
//   Python: import a.b and from a.b import c (also in parentheses over several
//          lines), resolved against the importing file's folder and each folder
//          above it (so backend/ as a source root works), plus relative
//          from .x imports. `from pkg import mod` counts as importing pkg/mod.py.
// Parsed imports are cached by git blob id under .atris/cache, so a second run
// reads only files that changed. A changed code file in a language this cannot
// read is reported, so the caller can widen (treat it as unmapped).
//
// The graph can be built for the working copy (the index plus uncommitted
// files) or for any commit (atris check replay), reading blobs straight from
// git. Building it never changes the checkout.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const JS_EXT = ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
const PY_EXT = ['.py'];
// Code this cannot follow imports for. Data, docs and styles have no imports to follow.
const OTHER_CODE_EXT = ['.go', '.rs', '.swift', '.rb', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm', '.cs', '.php', '.scala', '.dart', '.lua', '.ex', '.exs'];
const CACHE_FILE = path.join('.atris', 'cache', 'check-imports.json');
const CACHE_VERSION = 3;
// One cache file per repo, at most 5 MB. A bigger one is thrown away and rebuilt.
const CACHE_MAX_BYTES = 5 * 1024 * 1024;
// A feature part a split module loads by a string (see pySpecifiers).
const PART = 'part:';

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
  // Node built-ins and web addresses never resolve to a file in the repo.
  return [...found].filter((spec) => !spec.startsWith('node:') && !/^[a-z]+:\/\//i.test(spec));
}

function pySpecifiers(source) {
  const found = new Set();
  // `from x import (a,\n b)` and backslash-continued lines read as one line.
  const text = String(source)
    .replace(/\\\r?\n/g, ' ')
    .replace(/(\bimport\s*\()([^)]*)\)/g, (_, open, body) => `${open}${body.replace(/#[^\n]*/g, '').replace(/\s*\n\s*/g, ' ')})`);
  for (const line of text.split('\n')) {
    const from = line.match(/^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)/);
    if (from) {
      const names = from[2].replace(/#.*$/, '').replace(/[()]/g, '').split(',').map((name) => name.trim().split(/\s+/)[0]).filter(Boolean);
      found.add(from[1]);
      // `from pkg import mod` may name a module, not only a symbol.
      for (const name of names) if (name !== '*') found.add(from[1].endsWith('.') ? `${from[1]}${name}` : `${from[1]}.${name}`);
      continue;
    }
    const plain = line.match(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/);
    if (plain) for (const name of plain[1].split(',')) found.add(name.trim().split(/\s+/)[0]);
  }
  // A split module loads its feature parts by a string, not an import:
  // utils.feature_parts.run(globals(), "<stem>_features/x/x.py"). That part
  // runs inside this module, so it counts as imported by it.
  if (/feature_parts/.test(text)) {
    for (const match of text.matchAll(/\brun\(\s*globals\(\)\s*,\s*["']([\w./-]+\.py)["']\s*\)/g)) found.add(`${PART}${match[1]}`);
  }
  return [...found];
}

// Where a feature part a module loads lives: relative to the module, and only
// inside the module's own <stem>_features folder (utils/feature_parts.py run).
function resolvePart(importer, relpath, tracked) {
  const dir = path.posix.dirname(importer);
  const base = path.posix.join(dir, `${path.posix.basename(importer, '.py')}_features`);
  const file = path.posix.normalize(path.posix.join(dir, relpath));
  return file.startsWith(`${base}/`) && tracked.has(file) ? file : null;
}

function specifiersOf(file, source) {
  if (JS_EXT.includes(ext(file))) return jsSpecifiers(source);
  if (PY_EXT.includes(ext(file))) return pySpecifiers(source);
  return [];
}

// JSON with comments and trailing commas, as tsconfig allows.
function parseJsonc(text) {
  let out = '';
  let quote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] || ''; i += 1; } else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') { quote = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 1; continue; }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// Import aliases from the root tsconfig.json or jsconfig.json "paths".
function aliasesFrom(readText) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const text = readText(name);
    if (!text) continue;
    let config;
    try { config = parseJsonc(text); } catch { continue; }
    const options = (config && config.compilerOptions) || {};
    const baseUrl = path.posix.normalize(String(options.baseUrl || '.').replace(/^\.\/?/, '') || '.');
    const aliases = [];
    for (const [key, targets] of Object.entries(options.paths || {})) {
      const list = (Array.isArray(targets) ? targets : [targets]).map(String);
      const star = key.indexOf('*');
      aliases.push({
        prefix: star === -1 ? key : key.slice(0, star),
        suffix: star === -1 ? '' : key.slice(star + 1),
        exact: star === -1,
        targets: list.map((target) => path.posix.normalize(path.posix.join(baseUrl, target))),
      });
    }
    return { aliases, baseUrl: options.baseUrl ? baseUrl : null };
  }
  return { aliases: [], baseUrl: null };
}

function tryJsFile(base, tracked) {
  const tries = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
  // An import of x.js may point at x.ts in a TypeScript project.
  if (JS_EXT.includes(ext(base))) {
    const stem = base.slice(0, -ext(base).length);
    tries.push(...JS_EXT.map((e) => stem + e));
  }
  return tries.find((candidate) => tracked.has(candidate)) || null;
}

function resolveJs(importer, spec, tracked, config = { aliases: [], baseUrl: null }) {
  if (spec.startsWith('.')) return tryJsFile(path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec)), tracked);
  for (const alias of config.aliases) {
    let rest = null;
    if (alias.exact) { if (spec === alias.prefix) rest = ''; } else if (spec.startsWith(alias.prefix) && spec.endsWith(alias.suffix) && spec.length >= alias.prefix.length + alias.suffix.length) {
      rest = spec.slice(alias.prefix.length, spec.length - alias.suffix.length);
    }
    if (rest === null) continue;
    for (const target of alias.targets) {
      const hit = tryJsFile(path.posix.normalize(target.replace('*', rest)), tracked);
      if (hit) return hit;
    }
  }
  if (config.baseUrl) return tryJsFile(path.posix.normalize(path.posix.join(config.baseUrl, spec)), tracked);
  return null;
}

function resolvePy(importer, spec, tracked) {
  if (spec.startsWith(PART)) return resolvePart(importer, spec.slice(PART.length), tracked);
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

function resolve(importer, spec, tracked, config) {
  if (JS_EXT.includes(ext(importer))) return resolveJs(importer, spec, tracked, config);
  return resolvePy(importer, spec, tracked);
}

function parseBlobRows(text, pattern) {
  const blobs = new Map();
  for (const row of String(text || '').split('\0').filter(Boolean)) {
    const match = row.match(pattern);
    if (match) blobs.set(match[2], match[1]);
  }
  return blobs;
}

function indexBlobs(root) {
  const result = spawnSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return parseBlobRows(result.stdout, /^\d+ ([0-9a-f]+) \d+\t(.+)$/);
}

// Every file in a commit, with its blob id.
function treeBlobs(root, rev) {
  const result = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', rev], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return parseBlobRows(result.stdout, /^\d+ blob ([0-9a-f]+)\t(.+)$/);
}

// Read many blobs in one git call. Returns blob id -> text.
function readBlobs(root, ids) {
  const out = new Map();
  const wanted = [...new Set(ids)].filter(Boolean);
  for (let start = 0; start < wanted.length; start += 2000) {
    const slice = wanted.slice(start, start + 2000);
    const result = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: `${slice.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024 });
    const buf = result.stdout || Buffer.alloc(0);
    let at = 0;
    while (at < buf.length) {
      const nl = buf.indexOf(10, at);
      if (nl === -1) break;
      const header = buf.slice(at, nl).toString('utf8').split(' ');
      at = nl + 1;
      if (header[1] === 'missing' || header.length < 3) continue;
      const size = Number(header[2]);
      out.set(header[0], buf.slice(at, at + size).toString('utf8'));
      at += size + 1;
    }
  }
  return out;
}

// Read files at a revision in one git call: names like "<rev>:<path>".
// Returns texts in the same order, null for a file that is not there.
function readAt(root, names) {
  const out = new Array(names.length).fill(null);
  if (!names.length) return out;
  const result = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: `${names.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024 });
  const buf = result.stdout || Buffer.alloc(0);
  let at = 0;
  for (let i = 0; i < names.length && at < buf.length; i += 1) {
    const nl = buf.indexOf(10, at);
    if (nl === -1) break;
    const header = buf.slice(at, nl).toString('utf8');
    at = nl + 1;
    const match = header.match(/ (blob|tree|commit|tag) (\d+)$/);
    if (!match) continue; // "<name> missing" or ambiguous
    const size = Number(match[2]);
    if (match[1] === 'blob') out[i] = buf.slice(at, at + size).toString('utf8');
    at += size + 1;
  }
  return out;
}

// Files whose text holds any of the needles, by git grep (fast, in C).
// rev: search that commit; otherwise the working copy. null when grep failed.
function grepFiles(root, needles, roots, rev) {
  if (!needles.length) return new Set();
  const specs = (roots && roots.length ? roots : ['.']).map((root2) => {
    const text = String(root2).replace(/^\.\//, '').replace(/\/+$/, '') || '.';
    return /[*?{]/.test(text) ? `:(glob)${text.replace(/\{([^}]*)\}/g, '*')}` : text;
  });
  const args = ['grep', '-l', '-z', '-F', '-I', '--no-color'];
  for (const needle of needles) args.push('-e', needle);
  if (rev) args.push(rev);
  args.push('--', ...specs);
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status === 1) return new Set();
  if (result.status !== 0) return null;
  const prefix = rev ? `${rev}:` : '';
  return new Set(String(result.stdout || '').split('\0').filter(Boolean).map((name) => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name)));
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

// The import graph, asked backwards: importersOf(file) -> the files that import it.
// options.rev builds it for a commit (read from git); otherwise for the working
// copy (the index, with dirtyFiles read from disk). options.memo is an object
// kept between calls (replay) so a blob is parsed once. options.writeCache
// false leaves .atris/cache untouched.
function buildGraph(root, options = {}) {
  const memo = options.memo || {};
  memo.specs = memo.specs || readCache(root);
  memo.text = memo.text || new Map();
  const blobs = options.rev ? treeBlobs(root, options.rev) : indexBlobs(root);
  const tracked = new Set(blobs.keys());
  const dirty = new Set(options.rev ? [] : (options.dirtyFiles || []));
  const fresh = {};
  const specsOf = new Map();
  const missing = [];
  for (const [file, blob] of blobs) {
    if (!canRead(file)) continue;
    if (dirty.has(file)) {
      let source = '';
      try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
      const key = `w${crypto.createHash('sha1').update(source).digest('hex')}`;
      const specs = memo.specs[key] || specifiersOf(file, source);
      fresh[key] = specs;
      specsOf.set(file, specs);
    } else if (memo.specs[blob]) {
      fresh[blob] = memo.specs[blob];
      specsOf.set(file, memo.specs[blob]);
    } else {
      missing.push([file, blob]);
    }
  }
  if (missing.length) {
    let texts;
    if (options.rev) {
      texts = readBlobs(root, missing.map(([, blob]) => blob));
    } else {
      texts = new Map();
      for (const [file, blob] of missing) {
        try { texts.set(blob, fs.readFileSync(path.join(root, file), 'utf8')); } catch {}
      }
    }
    for (const [file, blob] of missing) {
      if (!texts.has(blob)) continue;
      const specs = specifiersOf(file, texts.get(blob));
      memo.specs[blob] = specs;
      fresh[blob] = specs;
      specsOf.set(file, specs);
    }
  }
  const readText = (file) => {
    if (!tracked.has(file)) return '';
    if (!options.rev) { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; } }
    const blob = blobs.get(file);
    if (!memo.text.has(blob)) for (const [id, text] of readBlobs(root, [blob])) memo.text.set(id, text);
    return memo.text.get(blob) || '';
  };
  const config = aliasesFrom(readText);
  // Resolving every import of every file is slow in a big repo. Instead each
  // import is filed under the last word of its path (services.cost_pulse
  // under cost_pulse, ./lib/util.js under util), and a file's importers are
  // found by resolving only the imports filed under its own name.
  const byName = new Map();
  const file = (name, entry) => { if (!byName.has(name)) byName.set(name, []); byName.get(name).push(entry); };
  for (const [importer, specs] of specsOf) {
    const js = JS_EXT.includes(ext(importer));
    for (const spec of specs) {
      if (js) {
        if (spec.startsWith('.')) {
          const last = path.posix.basename(spec);
          file(last.replace(/\.[A-Za-z0-9]+$/, ''), [importer, spec]);
        } else if (config.baseUrl || config.aliases.some((alias) => (alias.exact ? spec === alias.prefix : spec.startsWith(alias.prefix)))) {
          file('', [importer, spec]);
        }
      } else if (spec.startsWith(PART)) {
        file(path.posix.basename(spec, '.py'), [importer, spec]);
      } else {
        const parts = spec.split('.');
        file(parts[parts.length - 1], [importer, spec]);
      }
    }
  }
  const reverseMemo = new Map();
  const importersOf = (target) => {
    if (reverseMemo.has(target)) return reverseMemo.get(target);
    const stem = path.posix.basename(target).replace(/\.[A-Za-z0-9]+$/, '');
    const names = new Set([stem, '']);
    if (stem === '__init__' || stem === 'index') names.add(path.posix.basename(path.posix.dirname(target)));
    const found = new Set();
    for (const name of names) {
      for (const [importer, spec] of byName.get(name) || []) {
        if (importer !== target && resolve(importer, spec, tracked, config) === target) found.add(importer);
      }
    }
    const list = [...found].sort();
    reverseMemo.set(target, list);
    return list;
  };
  // Does importer load target as one of its feature parts?
  const loadsPart = (importer, target) => (specsOf.get(importer) || []).some((spec) => spec.startsWith(PART) && resolvePart(importer, spec.slice(PART.length), tracked) === target);
  if (options.writeCache !== false) {
    // Keep what this run used, plus earlier entries while there is room.
    writeCache(root, options.rev ? { ...fresh, ...memo.specs } : fresh);
  }
  return { tracked, blobs, importersOf, loadsPart };
}

module.exports = {
  buildGraph,
  readAt,
  grepFiles,
  pySpecifiers,
  unreadableCode,
  CACHE_FILE,
};
