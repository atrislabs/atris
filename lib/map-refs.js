'use strict';

// Checks the `path:N` line refs in a map document against the code they point at.
// A ref may carry a symbol: an identifier written right after it (`path:N` `name`,
// `path:N` (`name`), or a bare camelCase name) or right before it (`name` (`path:N`)).
// A name elsewhere in the sentence never binds: map sentences often name a helper
// the ref does not point at, and binding it would move the ref to the wrong place.

const fs = require('fs');
const path = require('path');

const WINDOW = 3;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const REF = /^(?:\.\/)?([^\s:`<>*|]+):(\d+)(?:-(\d+))?((?:,\d+(?:-\d+)?)*)(?:#\S*)?$/;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function definitionPatterns(symbol) {
  const s = escape(symbol);
  return [
    new RegExp(`\\bfunction\\s*\\*?\\s*${s}\\s*\\(`),
    new RegExp(`\\b(?:const|let|var)\\s+${s}\\b`),
    new RegExp(`\\bclass\\s+${s}\\b`),
    new RegExp(`\\bdef\\s+${s}\\b`),
    new RegExp(`^\\s*(?:async\\s+)?(?:static\\s+)?(?:get\\s+|set\\s+)?\\*?${s}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`^\\s*['"]?${s}['"]?\\s*:(?!:)`),
    new RegExp(`\\bcase\\s+['"\`]?${s}['"\`]?\\s*:`),
    new RegExp(`\\bexports\\.${s}\\s*=`),
  ];
}

function tokenPattern(symbol, flags = '') {
  return new RegExp(`(?<![\\w$])${escape(symbol)}(?![\\w$])`, flags);
}

function isPathLike(file) {
  return !file.includes('://') && (file.includes('/') || /\.[a-z0-9]+$/i.test(file));
}

// Find every ref in the map, with its map line, column, and optional symbol.
// Code fences are scanned too: the map keeps prose notes inside its search block.
function parseRefs(mapText) {
  const refs = [];
  mapText.split(/\r?\n/).forEach((line, index) => {
    const spans = [...line.matchAll(/`([^`\r\n]+)`/g)].map(match => ({
      text: match[1], start: match.index, end: match.index + match[0].length,
    }));
    spans.forEach((span, i) => {
      const match = span.text.trim().match(REF);
      if (!match || !isPathLike(match[1])) return;
      const ref = {
        map_line: index + 1, column: span.start, raw: span.text, path: match[1],
        start: Number(match[2]), end: match[3] ? Number(match[3]) : null,
        extra: match[4] ? match[4].slice(1).split(',').map(part => part.split('-').map(Number)) : [],
        symbols: [],
      };
      if (!ref.extra.length) ref.symbols = symbolsFor(line, spans, i);
      ref.symbol = ref.symbols[0] || null;
      refs.push(ref);
    });
  });
  return refs;
}

// Symbols bind only when written right next to the ref, so a backticked word
// later in the sentence never passes for the thing the ref points at.
function symbolsFor(line, spans, i) {
  const clean = text => text.trim().replace(/\(\)$/, '');
  const found = [];
  const after = spans[i + 1];
  if (after && /^\s*\(?\s*$/.test(line.slice(spans[i].end, after.start)) && IDENT.test(clean(after.text))) {
    found.push(clean(after.text));
  }
  // An unquoted name counts only when it is shaped like code (camelCase or snake_case).
  const bare = line.slice(spans[i].end).match(/^ ([A-Za-z_$][\w$]*)(?:\(\))?(?=[\s),;:.]|$)/);
  if (bare && /[a-z][A-Z]|_/.test(bare[1])) found.push(bare[1]);
  const before = spans[i - 1];
  if (before && /^\s*\(\s*$/.test(line.slice(before.end, spans[i].start)) && IDENT.test(clean(before.text))) {
    found.push(clean(before.text));
  }
  return [...new Set(found)];
}

// Line numbers (1-based) of every line holding the symbol, found in one pass over the text.
function lineNumbersOf(file, symbol) {
  const found = [];
  for (const match of file.text.matchAll(tokenPattern(symbol, 'g'))) {
    let low = 0;
    let high = file.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (file.starts[mid] <= match.index) low = mid; else high = mid - 1;
    }
    if (found[found.length - 1] !== low + 1) found.push(low + 1);
  }
  return found;
}

function classify(ref, file) {
  const { lines } = file;
  const last = ref.end || ref.start;
  const numbers = [ref.start, last, ...ref.extra.flat()];
  const inBounds = numbers.every(n => n >= 1 && n <= lines.length);
  if (!ref.symbol) return inBounds ? { status: 'ok' } : { status: 'missing', reason: 'line out of range' };
  const low = Math.max(1, ref.start - WINDOW);
  const high = Math.min(lines.length, last + WINDOW);
  // A range that runs past the end of the file is wrong even when its start is right.
  if (inBounds) for (const symbol of ref.symbols) {
    const near = tokenPattern(symbol);
    for (let n = low; n <= high; n++) if (near.test(lines[n - 1])) return { status: 'ok', symbol };
  }
  const uses = lineNumbersOf(file, ref.symbol);
  const patterns = definitionPatterns(ref.symbol);
  const defs = uses.filter(n => patterns.some(pattern => pattern.test(lines[n - 1])));
  const candidates = defs.length ? defs : uses;
  if (!candidates.length) return { status: 'missing', reason: `${ref.symbol} is not in the file` };
  if (candidates.length > 1) return { status: 'ambiguous', lines: candidates.slice(0, 5) };
  const line = candidates[0];
  // Keep the range width but never write an end past the last line.
  return { status: 'moved', line, ...(ref.end ? { end_line: Math.min(lines.length, line + ref.end - ref.start) } : {}) };
}

function checkMapRefs(root, mapText) {
  const cache = new Map();
  const linesOf = file => {
    if (!cache.has(file)) {
      const full = path.resolve(root, file);
      let text = null;
      try {
        if (fs.statSync(full).isFile()) text = fs.readFileSync(full, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
      if (text === null) cache.set(file, null);
      else {
        const raw = text.split('\n');
        const starts = [0];
        for (let i = 0; i < raw.length - 1; i++) starts.push(starts[i] + raw[i].length + 1);
        const lines = raw.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
        cache.set(file, { text, lines, starts });
      }
    }
    return cache.get(file);
  };
  const refs = parseRefs(mapText).map(ref => {
    const file = linesOf(ref.path);
    return { ...ref, ...(file ? classify(ref, file) : { status: 'missing-file' }) };
  });
  return summarize(refs);
}

function summarize(refs) {
  const count = status => refs.filter(ref => ref.status === status).length;
  const summary = {
    total: refs.length, ok: count('ok'), moved: count('moved'), ambiguous: count('ambiguous'),
    missing: count('missing'), missing_file: count('missing-file'),
  };
  return { ...summary, score: refs.length ? summary.ok / refs.length : 1, refs };
}

function newRefText(ref) {
  const lineText = ref.end ? `${ref.line}-${ref.end_line}` : `${ref.line}`;
  return ref.raw.replace(`:${ref.start}${ref.end ? `-${ref.end}` : ''}`, `:${lineText}`);
}

// Rewrite only refs whose symbol sits unambiguously on another line.
function fixMapRefs(root, mapFile = 'atris/MAP.md') {
  const file = path.resolve(root, mapFile);
  const text = fs.readFileSync(file, 'utf8');
  const result = checkMapRefs(root, text);
  const moved = result.refs.filter(ref => ref.status === 'moved');
  const lines = text.split('\n');
  const changes = [];
  for (const ref of [...moved].sort((a, b) => b.map_line - a.map_line || b.column - a.column)) {
    const replacement = newRefText(ref);
    const line = lines[ref.map_line - 1];
    lines[ref.map_line - 1] = line.slice(0, ref.column + 1) + replacement + line.slice(ref.column + 1 + ref.raw.length);
    changes.unshift({ map_line: ref.map_line, from: ref.raw, to: replacement, symbol: ref.symbol });
  }
  if (changes.length) fs.writeFileSync(file, lines.join('\n'));
  const left = result.refs.filter(ref => ref.status !== 'ok' && ref.status !== 'moved');
  return { changes, left };
}

// The short routing map loads at boot; exact line refs live in the notes file.
// Both are checked and fixed, so moving a ref out of the boot map never hides it.
const MAP_REF_DOCS = ['atris/MAP.md', 'atris/refs/MAP-NOTES.md'];

function existingDocs(root) {
  return MAP_REF_DOCS.filter(doc => {
    try { return fs.statSync(path.resolve(root, doc)).isFile(); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  });
}

// mapText is the already-read atris/MAP.md, so boot does not read it twice.
function checkMapDocs(root, mapText) {
  const refs = existingDocs(root).flatMap(doc => {
    const text = doc === MAP_REF_DOCS[0] && typeof mapText === 'string'
      ? mapText : fs.readFileSync(path.resolve(root, doc), 'utf8');
    return checkMapRefs(root, text).refs.map(ref => ({ doc, ...ref }));
  });
  return summarize(refs);
}

function fixMapDocs(root) {
  const changes = [];
  const left = [];
  for (const doc of existingDocs(root)) {
    const result = fixMapRefs(root, doc);
    changes.push(...result.changes.map(change => ({ doc, ...change })));
    left.push(...result.left.map(ref => ({ doc, ...ref })));
  }
  return { changes, left };
}

module.exports = { MAP_REF_DOCS, checkMapRefs, checkMapDocs, fixMapRefs, fixMapDocs };
