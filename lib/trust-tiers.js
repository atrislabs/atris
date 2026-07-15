'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_FILES = [
  path.join('.atris', 'state', 'career_xp_receipts.jsonl'),
  path.join('.atris', 'state', 'scorecards.jsonl'),
];

const PASS_OUTCOMES = new Set(['accepted', 'approved', 'done', 'pass', 'passed', 'success', 'succeeded']);
const FAIL_OUTCOMES = new Set(['bounced', 'fail', 'failed', 'rejected', 'revised', 'rework_requested']);

function normalizedActor(value) {
  return String(value || '').trim().toLowerCase();
}

function rowActor(row) {
  return normalizedActor(row?.claimed_by || row?.metadata?.executed_by);
}

function rowPassed(row) {
  for (const value of [row?.passed, row?.verify_passed, row?.metadata?.verify_passed]) {
    if (typeof value === 'boolean') return value;
  }
  const outcome = String(row?.outcome || row?.status || '').trim().toLowerCase();
  if (PASS_OUTCOMES.has(outcome)) return true;
  if (FAIL_OUTCOMES.has(outcome)) return false;
  return null;
}

function rowTime(row) {
  for (const value of [row?.accepted_at, row?.ts, row?.recorded_at, row?.created_at, row?.updated_at]) {
    const parsed = Date.parse(value || '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readHistory(root) {
  const rows = [];
  let sequence = 0;
  for (const relative of HISTORY_FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, relative), 'utf8');
    } catch {
      return null;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return null;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      rows.push({ row, sequence: sequence++, time: rowTime(row) });
    }
  }
  return rows;
}

function computeTrustTier(actor, root = process.cwd()) {
  const target = normalizedActor(actor);
  if (!target) return 'probation';
  const history = readHistory(root);
  if (!history) return 'probation';

  const outcomes = history
    .filter(({ row }) => rowActor(row) === target)
    .map((entry) => ({ ...entry, passed: rowPassed(entry.row) }))
    .filter(({ passed }) => passed !== null)
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) return a.time - b.time;
      if (a.time !== null && b.time === null) return 1;
      if (a.time === null && b.time !== null) return -1;
      return a.sequence - b.sequence;
    })
    .slice(-20);

  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const passRate = outcomes.length ? passed / outcomes.length : 0;
  if (outcomes.length >= 10 && passRate >= 0.9) return 'trusted';
  if (outcomes.length >= 5 && passRate >= 0.7) return 'standard';
  return 'probation';
}

module.exports = { computeTrustTier };
