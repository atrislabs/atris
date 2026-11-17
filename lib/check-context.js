'use strict';

// atris check: what the planner needs to see of a repo, for the working copy
// (atris check) or for one commit (atris check replay). Read only: building
// it never changes the checkout. The import cache under .atris/cache is the
// only thing written, and replay does not write it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const imports = require('./check-imports');
const { commentsOnly, language } = require('./check-comments');
const { fileTier, globsMatch } = require('./check-plan');
const { GENERIC } = require('./check-select');

const KEYWORDS = new Set(['function', 'return', 'const', 'let', 'var', 'class', 'async', 'await', 'export', 'import', 'default', 'require', 'module', 'exports', 'typeof', 'instanceof', 'switch', 'string', 'number', 'boolean', 'object', 'undefined', 'null', 'true', 'false', 'self', 'None', 'True', 'False', 'lambda', 'console', 'process', 'window', 'document', 'Promise', 'Object', 'Array', 'String', 'JSON', 'Error', 'length', 'push', 'filter', 'includes']);

const xdistSeen = new Map();

function mainCheckout(root) {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  const dir = String(common.stdout || '').trim();
  return dir && path.basename(dir) === '.git' ? path.dirname(dir) : null;
}

// The python a selector runs with: the map's "python" (like venv/bin/python)
// in this copy, else in the main checkout this copy came from, else python3.
function pythonResolver(root) {
  const memo = new Map();
  return (check) => {
    if (!check.python) return 'python3';
    if (memo.has(check.python)) return memo.get(check.python);
    let found = 'python3';
    for (const base of [root, mainCheckout(root)].filter(Boolean)) {
      const candidate = path.join(base, check.python);
      if (fs.existsSync(candidate)) { found = candidate; break; }
    }
    memo.set(check.python, found);
    return found;
  };
}

function hasXdist(python, cwd) {
  const key = `${python}\0${cwd}`;
  if (!xdistSeen.has(key)) {
    const result = spawnSync(python, ['-c', 'import xdist'], { cwd, stdio: 'ignore', timeout: 15000 });
    xdistSeen.set(key, result.status === 0);
  }
  return xdistSeen.get(key);
}

// pytest -n when pytest-xdist is installed and enough tests were picked to
// be worth the workers. Node tests run in atris check's own pool instead.
function parallelResolver(root, map, pythonOf, { probe = true } = {}) {
  return (check, count) => {
    if (check.select !== 'pytest' || count < check.parallelMin) return '';
    const python = pythonOf(check);
    if (!probe || !hasXdist(python, path.join(root, check.cwd || ''))) return '';
    const workers = Math.max(2, Math.min(map.parallel, Math.ceil(count / 2)));
    const env = { ...process.env, ...(check.env || {}) };
    return `${env.PYTEST_DISABLE_PLUGIN_AUTOLOAD ? '-p xdist ' : ''}-n ${workers}`;
  };
}

// Changed code files whose diff is only comments and whitespace. High risk
// files are never asked: their tier stays high whatever the diff.
function commentOnlyFiles(root, map, files, { oldRev, newRev = null }) {
  const asked = files.filter((file) => language(file) && fileTier(map, file).tier !== 'high');
  const out = new Set();
  if (!asked.length || !oldRev) return out;
  const before = imports.readAt(root, asked.map((file) => `${oldRev}:${file}`));
  const after = newRev ? imports.readAt(root, asked.map((file) => `${newRev}:${file}`)) : asked.map((file) => {
    try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return null; }
  });
  asked.forEach((file, i) => { if (commentsOnly(file, before[i], after[i])) out.add(file); });
  return out;
}

// The names a change touches in a broad file: the function each changed hunk
// sits in (git's own hunk header) and the names declared on changed lines.
function changedNamesOf(diffText) {
  const names = new Set();
  const take = (name) => { if (name && name.length >= 6 && !KEYWORDS.has(name) && !GENERIC.has(name.toLowerCase())) names.add(name); };
  const declared = [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\bdef\s+([A-Za-z_]\w*)/g,
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
  ];
  for (const row of String(diffText || '').split('\n')) {
    const hunk = row.match(/^@@ [^@]+ @@ ?(.*)$/);
    const text = hunk ? hunk[1] : (/^[+-](?![+-]{2} )/.test(row) ? row.slice(1) : null);
    if (text === null) continue;
    for (const pattern of declared) for (const match of text.matchAll(pattern)) take(match[1]);
    // IPC channel names in the desktop app's main and preload files.
    if (/ipc(?:Main|Renderer)\.|contextBridge|invoke\(/.test(text)) for (const match of text.matchAll(/['"]([\w:.-]{6,})['"]/g)) take(match[1]);
  }
  return [...names].slice(0, 30);
}

function changedNames(root, map, files, { oldRev, newRev = null }) {
  const out = new Map();
  if (!oldRev || !map.broad || !map.broad.length) return out;
  for (const file of files.filter((name) => globsMatch(map.broad, name))) {
    const args = ['diff', '-U0', '--no-color', '--no-renames', oldRev];
    if (newRev) args.push(newRev);
    args.push('--', file);
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    out.set(file, changedNamesOf(result.stdout));
  }
  return out;
}

// Options for planChecks. rev: plan as of that commit (replay); otherwise the
// working copy. base: the code before the change, for the comments-only diff.
function planOptions(root, map, changed, { rev = null, base = null, dirtyFiles = [], memo = null, writeCache = true, gate = null, probe = true } = {}) {
  const graph = gate ? null : imports.buildGraph(root, { rev, dirtyFiles, memo: memo || undefined, writeCache });
  const python = pythonResolver(root);
  const listed = graph ? [...graph.tracked] : [];
  const existing = rev ? [] : changed.filter((file) => { try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; } });
  const allFiles = [...new Set([...listed, ...existing])];
  const textMemo = (memo && memo.fileText) || new Map();
  const readFile = (file) => {
    const key = rev ? `${rev}:${file}` : file;
    if (textMemo.has(key)) return textMemo.get(key);
    let text = '';
    if (rev) {
      const blob = graph && graph.blobs.get(file);
      const cached = blob && memo && memo.text && memo.text.get(blob);
      text = cached !== undefined && cached !== null ? cached : (imports.readAt(root, [key])[0] || '');
      if (blob && memo && memo.text) memo.text.set(blob, text);
    } else {
      try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch {}
    }
    if (!rev) textMemo.set(key, text);
    return text;
  };
  // A changed file's text on the base, so a marker removed in the same change
  // still counts (lib/check-plan.js whereOf). Unchanged files read the same.
  const changedSet = new Set(changed);
  const baseText = new Map();
  const readBaseFile = (file) => {
    if (!base || !changedSet.has(file)) return readFile(file);
    if (!baseText.has(file)) baseText.set(file, imports.readAt(root, [`${base}:${file}`])[0] || '');
    return baseText.get(file);
  };
  return {
    gate,
    readBaseFile,
    importers: graph ? new Map(changed.map((file) => [file, graph.importersOf(file)])) : new Map(),
    importersOf: graph ? graph.importersOf : () => [],
    loadsPart: graph ? graph.loadsPart : () => false,
    unreadable: changed.filter(imports.unreadableCode),
    commentOnly: gate ? new Set() : commentOnlyFiles(root, map, changed, { oldRev: base, newRev: rev }),
    changedNames: (() => { const names = gate ? new Map() : changedNames(root, map, changed, { oldRev: base, newRev: rev }); return (file) => names.get(file) || []; })(),
    listFiles: () => allFiles,
    readFile,
    grep: (needles, roots) => imports.grepFiles(root, needles, roots, rev),
    python,
    parallelArgs: parallelResolver(root, map, python, { probe }),
  };
}

module.exports = { changedNamesOf, planOptions, commentOnlyFiles, pythonResolver, parallelResolver, mainCheckout };
