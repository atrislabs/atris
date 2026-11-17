'use strict';

// atris check: did a code file change only in comments and whitespace?
//
// Both versions are reduced to their code: comments taken out (outside
// strings), each line trimmed, runs of spaces made one, blank lines dropped.
// Line breaks stay, because they can change what code means (JS semicolon
// rules), and so does Python indentation. If the two reductions are the same,
// the change is comments or whitespace only.
//
// A second guard reads the changed lines themselves: each one must be blank,
// start like a comment, or differ from a line on the other side only in
// spaces. A trailing comment edited after code counts as a code change.
//
// When unsure it says no: a file over 1 MB, a language it does not know, or
// text it cannot read all count as a code change. A wrong "no" only costs a wider check; a wrong "yes" would skip
// one, so every doubt goes to "no".

const path = require('path');

const MAX_BYTES = 1024 * 1024;
const HASH_LANGS = ['.py', '.sh', '.bash', '.zsh', '.rb', '.pl', '.yml', '.yaml', '.toml'];
const SLASH_LANGS = ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.go', '.rs', '.swift', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.scala', '.dart', '.css', '.scss'];
// Before one of these, a `/` starts a regular expression, not a division.
const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_WORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function language(file) {
  const ext = path.posix.extname(file).toLowerCase();
  if (HASH_LANGS.includes(ext)) return 'hash';
  if (SLASH_LANGS.includes(ext)) return 'slash';
  return null;
}

function squash(line, keepIndent) {
  const indent = keepIndent ? (line.match(/^[ \t]*/) || [''])[0] : '';
  return indent + line.trim().replace(/[ \t]+/g, ' ');
}

// Python, shell, YAML: `#` to the end of the line, outside quotes.
function stripHash(text, file) {
  const python = file.endsWith('.py');
  const lines = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += text[i + 1] || ''; i += 1; continue; }
      if (quote.length === 3 ? text.startsWith(quote, i) : ch === quote) {
        if (quote.length === 3) { current += quote.slice(1); i += 2; }
        quote = '';
      } else if (ch === '\n' && quote.length === 1 && python) {
        return null; // an unterminated string: not ours to judge
      }
      continue;
    }
    if (python && (text.startsWith('"""', i) || text.startsWith("'''", i))) { quote = text.slice(i, i + 3); current += quote; i += 2; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i += 1; i -= 1; continue; }
    if (ch === '\n') { lines.push(current); current = ''; continue; }
    current += ch;
  }
  if (quote) return null;
  lines.push(current);
  return lines.map((line) => squash(line, python)).filter((line) => line.trim());
}

function skipQuoted(text, i) {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) { if (text[j] === '\\') j += 1; if (text[j] === '\n') return -1; j += 1; }
  return j < text.length ? j : -1;
}

// Index of the closing backtick of the template string that opens at i, or -1.
function skipTemplate(text, i) {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j;
    if (c === '$' && text[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < text.length && depth) {
        const d = text[j];
        if (d === '"' || d === "'") { j = skipQuoted(text, j); if (j === -1) return -1; } else if (d === '`') { j = skipTemplate(text, j); if (j === -1) return -1; } else if (d === '{') depth += 1;
        else if (d === '}') depth -= 1;
        j += 1;
      }
      if (depth) return -1;
      continue;
    }
    j += 1;
  }
  return -1;
}

function lastSignificant(text) {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed;
}

// JS, TS and other `//` and `/* */` languages, outside strings, templates and
// regular expressions.
function stripSlash(text) {
  const lines = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) { if (text[j] === '\\') j += 1; if (text[j] === '\n') return null; j += 1; }
      if (j >= text.length) return null;
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '`') {
      // A template string, with its ${} parts, is kept exactly as written.
      const end = skipTemplate(text, i);
      if (end === -1) return null;
      const chunk = text.slice(i, end + 1).split('\n');
      current += chunk[0];
      for (const part of chunk.slice(1)) { lines.push(current); current = part; }
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; i -= 1; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return null;
      // Keep the line breaks a block comment spanned, so line structure stays.
      const breaks = text.slice(i, end).split('\n').length - 1;
      for (let k = 0; k < breaks; k += 1) { lines.push(current); current = ''; }
      current += ' ';
      i = end + 1;
      continue;
    }
    if (ch === '/') {
      const before = lastSignificant(current);
      const prev = before.slice(-1);
      if (REGEX_BEFORE.has(prev) || REGEX_WORDS.test(before)) {
        let j = i + 1;
        let inClass = false;
        while (j < text.length) {
          const c = text[j];
          if (c === '\n') return null;
          if (c === '\\') { j += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          j += 1;
        }
        if (j >= text.length) return null;
        current += text.slice(i, j + 1);
        i = j;
        continue;
      }
    }
    if (ch === '\n') { lines.push(current); current = ''; continue; }
    current += ch;
  }
  lines.push(current);
  return lines.map((line) => squash(line, false)).filter((line) => line);
}

function codeOf(text, file) {
  const lang = language(file);
  if (!lang) return null;
  if (lang === 'hash') return stripHash(text, file);
  return stripSlash(text);
}

// Lines on one side and not the other, as a multiset.
function changedLines(oldText, newText) {
  const count = new Map();
  for (const line of oldText.split('\n')) count.set(line, (count.get(line) || 0) + 1);
  const added = [];
  for (const line of newText.split('\n')) {
    if (count.get(line)) count.set(line, count.get(line) - 1);
    else added.push(line);
  }
  const removed = [];
  for (const [line, n] of count) for (let k = 0; k < n; k += 1) removed.push(line);
  return { added, removed };
}

const COMMENT_START = { hash: /^(?:#|$)/, slash: /^(?:\/\/|\/\*|\*|$)/ };

function linesLookLikeComments(file, oldText, newText) {
  const pattern = COMMENT_START[language(file)];
  const { added, removed } = changedLines(oldText, newText);
  const bare = (line) => line.replace(/\s+/g, '');
  const otherSide = (list) => new Set(list.map(bare));
  const addedBare = otherSide(added);
  const removedBare = otherSide(removed);
  const ok = (line, other) => pattern.test(line.trim()) || other.has(bare(line));
  return added.every((line) => ok(line, removedBare)) && removed.every((line) => ok(line, addedBare));
}

// true only when both versions exist, are readable, and reduce to the same code.
function commentsOnly(file, oldText, newText) {
  if (typeof oldText !== 'string' || typeof newText !== 'string') return false;
  // The same text (a mode change, or a file named by hand that did not
  // change): nothing to judge, so it is not called comments only.
  if (oldText === newText) return false;
  if (Buffer.byteLength(oldText) > MAX_BYTES || Buffer.byteLength(newText) > MAX_BYTES) return false;
  if (oldText.includes('\0') || newText.includes('\0')) return false;
  const before = codeOf(oldText, file);
  const after = codeOf(newText, file);
  if (!before || !after) return false;
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) return false;
  return linesLookLikeComments(file, oldText, newText);
}

module.exports = { commentsOnly, language };
