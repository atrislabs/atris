'use strict';

// Plain aligned tables for terminal views: a header row, two spaces between
// columns, no borders or pipes. A cell may hold several lines; the extra
// lines sit under the first, in the same column. When the table is wider
// than the terminal, columns marked `clip` or `wrap` shrink (rightmost
// first): a clip column ends in "…", a wrap column carries on underneath.
// Every other column keeps its full width.
//
// renderBorderedTable draws the same rows as a divided box, the look of the
// orb's team table. A box wider than the terminal narrows its `wrap`
// columns, the widest first, and their words carry on underneath; when it
// still does not fit it returns null and the caller prints its plain view.
//
// Every width here is terminal columns, not string length (displayWidth):
// a wide or fullwidth character takes 2, a joiner, variation selector, or
// combining mark takes 0, and a joined emoji is one 2-column cluster. Cuts
// and wraps fall between clusters, never inside one.

const GAP = '  ';
const ELLIPSIS = '…';
const FALLBACK_WIDTH = 100;

function terminalWidth(width) {
  const value = Number(width || process.stdout.columns);
  return Number.isFinite(value) && value >= 20 ? value : FALLBACK_WIDTH;
}

// East Asian wide and fullwidth code points, as [first, last] ranges.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1aff0, 0x1b2ff], [0x1f200, 0x1f2ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
// takes no column: combining marks, joiners and other format characters,
// variation selectors, and the Hangul vowel and final jamo that join a syllable
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\u1160-\u11ff\ud7b0-\ud7ff]$/u;
// drawn as a 2-column emoji: emoji presentation, or an emoji asked for one
// with the U+FE0F selector or a keycap
const EMOJI = /\p{Emoji_Presentation}|\p{Emoji}\ufe0f|\u20e3/u;
const SEGMENTER = typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function isWide(code) {
  for (const [first, last] of WIDE) {
    if (code < first) return false;
    if (code <= last) return true;
  }
  return false;
}

// The text as grapheme clusters: what a reader sees as one character.
// Without Intl.Segmenter a zero-width code point joins the cluster before it.
function graphemes(text) {
  const value = String(text);
  if (SEGMENTER) return Array.from(SEGMENTER.segment(value), (part) => part.segment);
  const out = [];
  let joined = false;
  for (const ch of value) {
    if (out.length && (joined || ZERO.test(ch))) out[out.length - 1] += ch;
    else out.push(ch);
    joined = ch === '\u200d';
  }
  return out;
}

// Terminal columns for one cluster: 0, 1, or 2.
function clusterWidth(cluster) {
  const code = cluster.codePointAt(0);
  if (cluster.length === 1 && code >= 0x20 && code < 0x7f) return 1;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (EMOJI.test(cluster)) return 2;
  for (const ch of cluster) {
    if (!ZERO.test(ch)) return isWide(ch.codePointAt(0)) ? 2 : 1;
  }
  return 0;
}

// Terminal columns the text takes.
function displayWidth(text) {
  const value = String(text);
  // printable ascii is one column a character
  if (/^[\x20-\x7e]*$/.test(value)) return value.length;
  let total = 0;
  for (const cluster of graphemes(value)) total += clusterWidth(cluster);
  return total;
}

// The longest start of the text that fits in that many columns, whole
// clusters only.
function sliceColumns(text, columns) {
  let out = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    const w = clusterWidth(cluster);
    if (used + w > columns) break;
    out += cluster;
    used += w;
  }
  return out;
}

// Pads with spaces to that many columns.
function padColumns(text, columns) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, columns - displayWidth(value)));
}

function clipText(text, width) {
  const value = String(text);
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return ELLIPSIS.slice(0, Math.max(0, width));
  return `${sliceColumns(value, width - 1).trimEnd()}${ELLIPSIS}`;
}

// Word-wrap one line to a width in columns; a word wider than the width is
// split between clusters (a lone cluster wider than the width stands alone).
function wrapText(text, width) {
  const out = [];
  let line = '';
  for (let word of String(text).split(' ')) {
    while (displayWidth(word) > width) {
      if (line) { out.push(line); line = ''; }
      const head = sliceColumns(word, width) || graphemes(word)[0];
      out.push(head);
      word = word.slice(head.length);
    }
    const next = line ? `${line} ${word}` : word;
    if (displayWidth(next) > width && line) { out.push(line); line = word; } else line = next;
  }
  out.push(line);
  return out;
}

function cellLines(value) {
  if (Array.isArray(value)) {
    const lines = value.filter((line) => line !== null && line !== undefined).map(String);
    return lines.length ? lines : [''];
  }
  return [value === null || value === undefined ? '' : String(value)];
}

// columns: [{ header, clip?, min? }]; rows: arrays of cells, one per column.
// Returns the table as one string, each line trimmed at the end.
function renderTable(columns, rows, { width } = {}) {
  const max = terminalWidth(width);
  const cells = rows.map((row) => columns.map((_, index) => cellLines(row[index])));
  const widths = columns.map((column, index) => Math.max(
    displayWidth(column.header),
    ...cells.map((row) => Math.max(...row[index].map(displayWidth))),
  ));
  let over = widths.reduce((sum, value) => sum + value, 0) + GAP.length * (columns.length - 1) - max;
  for (let index = columns.length - 1; index >= 0 && over > 0; index -= 1) {
    if (!columns[index].clip && !columns[index].wrap) continue;
    const floor = Math.max(displayWidth(columns[index].header), columns[index].min || 8);
    const cut = Math.min(over, Math.max(0, widths[index] - floor));
    widths[index] -= cut;
    over -= cut;
  }
  const line = (parts) => parts
    .map((text, index) => padColumns(clipText(text, widths[index]), index === parts.length - 1 ? 0 : widths[index]))
    .join(GAP)
    .trimEnd();
  const out = [line(columns.map((column) => column.header))];
  for (const raw of cells) {
    const row = raw.map((lines, index) => (columns[index].wrap ? lines.flatMap((text) => wrapText(text, widths[index])) : lines));
    const height = Math.max(...row.map((lines) => lines.length));
    for (let at = 0; at < height; at += 1) out.push(line(row.map((lines) => lines[at] || '')));
  }
  return out.join('\n');
}

// columns: [{ header, wrap?, min? }]; rows: arrays of cells. A divided box,
// or null when it cannot fit the terminal.
function renderBorderedTable(columns, rows, { width } = {}) {
  const cells = rows.map((row) => columns.map((_, index) => cellLines(row[index])));
  const widths = columns.map((column, index) => Math.max(
    displayWidth(column.header),
    ...cells.map((row) => Math.max(...row[index].map(displayWidth))),
  ));
  const floor = (index) => Math.max(displayWidth(columns[index].header), columns[index].min || 8);
  let over = widths.reduce((sum, value) => sum + value + 3, 1) - terminalWidth(width);
  while (over > 0) {
    let widest = -1;
    columns.forEach((column, index) => {
      if (column.wrap && widths[index] > floor(index) && (widest < 0 || widths[index] > widths[widest])) widest = index;
    });
    if (widest < 0) return null;
    widths[widest] -= 1;
    over -= 1;
  }
  const rule = (left, mid, right) => `${left}${widths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`;
  const line = (parts) => `│ ${parts.map((text, index) => padColumns(text, widths[index])).join(' │ ')} │`;
  const out = [rule('┌', '┬', '┐'), line(columns.map((column) => column.header)), rule('├', '┼', '┤')];
  for (const raw of cells) {
    const row = raw.map((lines, index) => (columns[index].wrap ? lines.flatMap((text) => wrapText(text, widths[index])) : lines));
    const height = Math.max(...row.map((lines) => lines.length));
    for (let at = 0; at < height; at += 1) out.push(line(row.map((lines) => lines[at] || '')));
  }
  out.push(rule('└', '┴', '┘'));
  return out.join('\n');
}

module.exports = { FALLBACK_WIDTH, clipText, displayWidth, renderBorderedTable, renderTable, sliceColumns, terminalWidth, wrapText };
