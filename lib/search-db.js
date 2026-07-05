// SQLite-backed full-text search for atris/**/*.md. node:sqlite (built-in, v22+).
// Path: ~/.atris/search.db (gitignored, never blobbed).

'use strict';

// node:sqlite emits an ExperimentalWarning. Suppress only that exact class by
// monkey-patching process.emit at this narrow filter — other warnings (and
// any pre-existing listeners installed by host code) are untouched.
{
  const originalEmit = process.emit;
  process.emit = function patchedEmit(name, data, ...args) {
    if (name === 'warning' && data && data.name === 'ExperimentalWarning'
        && /SQLite/i.test(data.message || '')) {
      return false;
    }
    return originalEmit.apply(process, [name, data, ...args]);
  };
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.atris', 'search.db');
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  root  TEXT NOT NULL,
  path  TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  PRIMARY KEY(root, path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS sections USING fts5(
  heading,
  body,
  path UNINDEXED,
  root UNINDEXED,
  line UNINDEXED
);
`;

let _cachedDb = null;
let _cachedPath = null;

function getDbPath() {
  return process.env.ATRIS_SEARCH_DB || DEFAULT_DB_PATH;
}

function open(dbPath) {
  const target = dbPath || getDbPath();
  if (_cachedDb && _cachedPath === target) return _cachedDb;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(target);
  withBusyRetry(() => db.exec('PRAGMA journal_mode = WAL'));
  withBusyRetry(() => db.exec('PRAGMA busy_timeout = 30000'));
  withBusyRetry(() => db.exec(SCHEMA));
  withBusyRetry(() => db.exec('PRAGMA user_version = 1'));
  _cachedDb = db;
  _cachedPath = target;
  return db;
}

function close() {
  if (_cachedDb) {
    try { _cachedDb.close(); } catch (_) {}
    _cachedDb = null;
    _cachedPath = null;
  }
}

function normalizeRoot(root) {
  return path.resolve(root || process.cwd());
}

function relPath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function walkMarkdownFiles(root) {
  const atrisDir = path.join(root, 'atris');
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(full);
      }
    }
  }

  if (fs.existsSync(atrisDir)) walk(atrisDir);
  return files.sort();
}

function splitMarkdownSections(relativePath, text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let current = {
    heading: path.basename(relativePath),
    line: 1,
    bodyLines: [],
    prelude: true,
  };

  function finish() {
    if (!current) return;
    const body = current.bodyLines.join('\n').trim();
    if (!(current.prelude && !body)) {
      sections.push({
        heading: current.heading || path.basename(relativePath),
        body,
        path: relativePath,
        line: current.line,
      });
    }
  }

  lines.forEach((line, index) => {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      finish();
      current = {
        heading: heading[2].trim() || path.basename(relativePath),
        line: index + 1,
        bodyLines: [],
        prelude: false,
      };
    } else {
      current.bodyLines.push(line);
    }
  });

  finish();
  return sections;
}

function runTransaction(db, fn) {
  withBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
  try {
    const result = fn();
    withBusyRetry(() => db.exec('COMMIT'));
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

function reindexFile(db, root, filePath, relativePath, mtime) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sections = splitMarkdownSections(relativePath, text);
  const deleteSections = db.prepare('DELETE FROM sections WHERE root = ? AND path = ?');
  const upsertFile = db.prepare(`
    INSERT INTO files(root, path, mtime)
    VALUES (?, ?, ?)
    ON CONFLICT(root, path) DO UPDATE SET mtime = excluded.mtime
  `);
  const insertSection = db.prepare(`
    INSERT INTO sections(heading, body, path, root, line)
    VALUES (?, ?, ?, ?, ?)
  `);

  runTransaction(db, () => {
    deleteSections.run(root, relativePath);
    for (const section of sections) {
      insertSection.run(section.heading, section.body, section.path, root, section.line);
    }
    upsertFile.run(root, relativePath, mtime);
  });

  return sections.length;
}

function removeFile(db, root, relativePath) {
  const deleteSections = db.prepare('DELETE FROM sections WHERE root = ? AND path = ?');
  const deleteFile = db.prepare('DELETE FROM files WHERE root = ? AND path = ?');
  runTransaction(db, () => {
    deleteSections.run(root, relativePath);
    deleteFile.run(root, relativePath);
  });
}

function countStats(db, root) {
  const files = db.prepare('SELECT COUNT(*) AS count FROM files WHERE root = ?').get(root).count;
  const sections = db.prepare('SELECT COUNT(*) AS count FROM sections WHERE root = ?').get(root).count;
  return { files, sections };
}

function ensureIndex(root, options = {}) {
  const workspaceRoot = normalizeRoot(root);
  const db = open();
  const force = options.force === true;
  const files = walkMarkdownFiles(workspaceRoot);
  const current = new Map();

  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    current.set(relPath(workspaceRoot, filePath), {
      filePath,
      mtime: Math.floor(stat.mtimeMs),
    });
  }

  if (force) {
    runTransaction(db, () => {
      db.prepare('DELETE FROM sections WHERE root = ?').run(workspaceRoot);
      db.prepare('DELETE FROM files WHERE root = ?').run(workspaceRoot);
    });
  } else {
    const known = db.prepare('SELECT path FROM files WHERE root = ?').all(workspaceRoot);
    for (const row of known) {
      if (!current.has(row.path)) removeFile(db, workspaceRoot, row.path);
    }
  }

  const knownMtimes = new Map(
    db.prepare('SELECT path, mtime FROM files WHERE root = ?').all(workspaceRoot)
      .map(row => [row.path, Number(row.mtime)])
  );
  let changedFiles = 0;
  let changedSections = 0;

  for (const [relativePath, info] of current) {
    if (!force && knownMtimes.get(relativePath) === info.mtime) continue;
    changedFiles += 1;
    changedSections += reindexFile(db, workspaceRoot, info.filePath, relativePath, info.mtime);
  }

  return {
    ...countStats(db, workspaceRoot),
    changed_files: changedFiles,
    changed_sections: changedSections,
  };
}

function buildMatchQuery(query) {
  return String(query || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

function compactSnippet(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function search(root, query, limit = 10) {
  const workspaceRoot = normalizeRoot(root);
  const match = buildMatchQuery(query);
  if (!match) return [];
  const db = open();
  const rows = db.prepare(`
    SELECT
      path,
      line,
      heading,
      snippet(sections, 1, '', '', '...', 18) AS snippet,
      bm25(sections) AS rank
    FROM sections
    WHERE root = ? AND sections MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(workspaceRoot, match, Math.max(1, Number(limit) || 10));

  return rows.map(row => ({
    path: row.path,
    line: Number(row.line) || 1,
    heading: compactSnippet(row.heading),
    snippet: compactSnippet(row.snippet || row.heading),
  }));
}

// Wrap SQLite writes so SQLITE_BUSY retries with exponential backoff.
function withBusyRetry(fn, attempts = 8) {
  let delay = 5;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return fn(); }
    catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '');
      const code = e && (e.code || e.errcode);
      const busy = /SQLITE_BUSY|database is locked/i.test(msg) || code === 'SQLITE_BUSY' || code === 5;
      if (!busy) throw e;
      const end = Date.now() + delay + Math.floor(Math.random() * delay);
      while (Date.now() < end) {}
      delay = Math.min(delay * 2, 500);
    }
  }
  throw lastErr;
}

module.exports = {
  close,
  ensureIndex,
  search,
};
