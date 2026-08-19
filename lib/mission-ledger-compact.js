'use strict';

// Mission ledger compaction. Every mission save appends a full snapshot to
// .atris/state/missions.jsonl, so a mission saved N times costs N rows and
// every reader pays for the whole history (2,417 rows for 302 missions when
// this shipped). Worse, old snapshots keep referencing old run receipts, so
// the daily runs-prune can never reclaim them. Compacting to one row per
// mission keeps exactly what every reader reconstructs anyway.
//
// Readers' contract (loadMissionMap in commands/mission.js): the surviving
// row per id must carry the LATEST state but the FIRST display number ever
// assigned, and first-appearance order must hold so numbering stays stable.

const fs = require('fs');
const path = require('path');
const { displayNumber } = require('./short-name');

const DEFAULT_MIN_ROWS = 64;
const DEFAULT_RATIO = 4;

function parseLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
}

// Latest snapshot per id, first-seen order, first assigned display number.
function compactRows(rows) {
  const order = [];
  const latest = new Map();
  const firstNumber = new Map();
  for (const row of rows) {
    if (!row || !row.id) continue;
    if (!latest.has(row.id)) order.push(row.id);
    if (!firstNumber.has(row.id) && displayNumber(row.n)) firstNumber.set(row.id, displayNumber(row.n));
    latest.set(row.id, row);
  }
  return order.map((id) => {
    const row = { ...latest.get(id) };
    if (firstNumber.has(id)) row.n = firstNumber.get(id);
    else delete row.n;
    return row;
  });
}

// Compact when history outweighs live records by `ratio`, and never bother
// below `minRows`. Returns a receipt either way; writes atomically so a
// concurrent reader sees the old file or the new one, never a torn one.
function compactMissionLedger(file, options = {}) {
  const minRows = Number.isFinite(options.minRows) ? options.minRows : DEFAULT_MIN_ROWS;
  const ratio = Number.isFinite(options.ratio) ? options.ratio : DEFAULT_RATIO;
  // Cheap stat gate so the every-save hook does not re-read a small healthy
  // ledger: below this size compaction cannot be worth a full read.
  const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : 262144;
  if (options.force !== true) {
    try {
      if (fs.statSync(file).size < minBytes) {
        return { compacted: false, reason: 'below_threshold', rows_before: 0, rows_after: 0 };
      }
    } catch {
      return { compacted: false, reason: 'missing', rows_before: 0, rows_after: 0 };
    }
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { compacted: false, reason: 'missing', rows_before: 0, rows_after: 0 };
  }
  const rows = parseLines(text);
  const valid = rows.filter((row) => row && row.id);
  const uniqueIds = new Set(valid.map((row) => row.id)).size;
  const receipt = {
    rows_before: rows.length,
    unique_missions: uniqueIds,
    bytes_before: Buffer.byteLength(text),
  };
  const force = options.force === true;
  if (!force && (rows.length < minRows || rows.length < uniqueIds * ratio)) {
    return { ...receipt, compacted: false, reason: 'below_threshold', rows_after: rows.length };
  }
  const compacted = compactRows(valid);
  const nextText = compacted.length
    ? `${compacted.map((row) => JSON.stringify(row)).join('\n')}\n`
    : '';
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, nextText, 'utf8');
  fs.renameSync(tmp, file);
  return {
    ...receipt,
    compacted: true,
    rows_after: compacted.length,
    bytes_after: Buffer.byteLength(nextText),
  };
}

module.exports = { compactMissionLedger, compactRows };
