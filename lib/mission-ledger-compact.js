'use strict';

// Mission ledger compaction is disabled until its writers can coordinate.
//
// Readers' contract (loadMissionMap in commands/mission.js): the surviving
// row per id must carry the LATEST state but the FIRST display number ever
// assigned, and first-appearance order must hold so numbering stays stable.

const { displayNumber } = require('./short-name');

// Latest snapshot per id, first-seen order, first assigned display number.
// Rows without an id are not mission snapshots (cloud mission receipts land
// here as {cloud: true, ...}); they pass through untouched, in order, after
// the compacted snapshots so latest-row readers still find them.
function compactRows(rows) {
  const order = [];
  const latest = new Map();
  const firstNumber = new Map();
  const passthrough = [];
  for (const row of rows) {
    if (!row) continue;
    if (!row.id) {
      passthrough.push(row);
      continue;
    }
    if (!latest.has(row.id)) order.push(row.id);
    if (!firstNumber.has(row.id) && displayNumber(row.n)) firstNumber.set(row.id, displayNumber(row.n));
    latest.set(row.id, row);
  }
  const compacted = order.map((id) => {
    const row = { ...latest.get(id) };
    if (firstNumber.has(id)) row.n = firstNumber.get(id);
    else delete row.n;
    return row;
  });
  return compacted.concat(passthrough);
}

// Rewriting this append-only ledger can erase a concurrent mission or cloud
// receipt. Until all writers coordinate, even a forced call must leave it alone.
function compactMissionLedger() {
  return { compacted: false, reason: 'concurrent_writers_unfenced' };
}

module.exports = { compactMissionLedger, compactRows };
