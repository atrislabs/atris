'use strict';

// Plain aligned tables for terminal views: a header row, two spaces between
// columns, no borders or pipes. A cell may hold several lines; the extra
// lines sit under the first, in the same column. When the table is wider
// than the terminal, columns marked `clip` or `wrap` shrink (rightmost
// first): a clip column ends in "…", a wrap column carries on underneath.
// Every other column keeps its full width.

const GAP = '  ';
const ELLIPSIS = '…';
const FALLBACK_WIDTH = 100;

function terminalWidth(width) {
  const value = Number(width || process.stdout.columns);
  return Number.isFinite(value) && value >= 20 ? value : FALLBACK_WIDTH;
}

function clipText(text, width) {
  const value = String(text);
  if (value.length <= width) return value;
  if (width <= 1) return ELLIPSIS.slice(0, Math.max(0, width));
  return `${value.slice(0, width - 1).trimEnd()}${ELLIPSIS}`;
}

// Word-wrap one line to a width; a word longer than the width is split.
function wrapText(text, width) {
  const out = [];
  let line = '';
  for (let word of String(text).split(' ')) {
    while (word.length > width) {
      if (line) { out.push(line); line = ''; }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) { out.push(line); line = word; } else line = next;
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
    String(column.header).length,
    ...cells.map((row) => Math.max(...row[index].map((line) => line.length))),
  ));
  let over = widths.reduce((sum, value) => sum + value, 0) + GAP.length * (columns.length - 1) - max;
  for (let index = columns.length - 1; index >= 0 && over > 0; index -= 1) {
    if (!columns[index].clip && !columns[index].wrap) continue;
    const floor = Math.max(String(columns[index].header).length, columns[index].min || 8);
    const cut = Math.min(over, Math.max(0, widths[index] - floor));
    widths[index] -= cut;
    over -= cut;
  }
  const line = (parts) => parts
    .map((text, index) => clipText(text, widths[index]).padEnd(index === parts.length - 1 ? 0 : widths[index]))
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

module.exports = { FALLBACK_WIDTH, clipText, renderTable, terminalWidth };
