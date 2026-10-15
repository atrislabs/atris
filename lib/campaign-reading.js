// Graded judge readings: a number from 0 to 1 pulled from a judge's output,
// so a campaign learns "3 of 5 tests pass" instead of only "failed". Pure, no
// I/O. The reading rides on judge_ran as data.reading (lib/campaign-schema.js
// already allows it); traces use it as the reward signal
// (atris/features/campaign/traces.md).
//
// Formats, first match wins:
//   reading: 0.6                       a judge that states its own reading
//   3 of 5 live  /  3/5 ok             the judge's final line
//   node --test   ℹ pass 3 / ℹ fail 2  (also TAP "# pass 3", and "pass 3, fail 2")
//   jest/vitest   Tests: 1 failed, 4 passed, 5 total  /  Tests  1 failed | 4 passed (5)
//   pytest        1 failed, 4 passed in 0.12s
//   mocha         4 passing / 1 failing
// Output with no counts gives null: a reading is never invented.

'use strict';

function round(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
}

function ratio(good, total) {
  return total > 0 ? round(good / total) : null;
}

function count(line, word) {
  const match = line.match(new RegExp(`(\\d+)\\s+${word}\\b`, 'i'));
  return match ? Number(match[1]) : 0;
}

function stated(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^reading\s*[:=]\s*(\d*\.?\d+)\s*$/i);
    if (match) return round(Number(match[1]));
  }
  return null;
}

function finalOf(lines) {
  const last = lines[lines.length - 1] || '';
  const match = last.match(/^(\d+)\s*(?:of|\/)\s*(\d+)\b/i);
  if (!match || Number(match[1]) > Number(match[2])) return null;
  return ratio(Number(match[1]), Number(match[2]));
}

// node --test prints one summary block per run; a judge that chains runs
// (a && b) gets the sum of every block.
function nodeCounts(text) {
  const tokens = /(?:^|,)[ \t]*(?:ℹ|#)?[ \t]*(pass|fail|cancelled)[ \t]+(\d+)[ \t]*(?=,|$)/gim;
  const sums = { pass: 0, fail: 0, cancelled: 0 };
  let seen = false;
  for (const match of text.matchAll(tokens)) {
    sums[match[1].toLowerCase()] += Number(match[2]);
    seen = true;
  }
  return seen ? ratio(sums.pass, sums.pass + sums.fail + sums.cancelled) : null;
}

function lastLine(lines, pattern) {
  for (let i = lines.length - 1; i >= 0; i--) if (pattern.test(lines[i])) return lines[i];
  return null;
}

function jestCounts(lines) {
  const line = lastLine(lines, /^Tests:?\s+.*\d+\s+(passed|failed)/i);
  if (!line) return null;
  return ratio(count(line, 'passed'), count(line, 'passed') + count(line, 'failed'));
}

function pytestCounts(lines) {
  const line = lastLine(lines, /\d+\s+(passed|failed)\b/i);
  if (!line) return null;
  const errors = count(line, 'errors') || count(line, 'error');
  return ratio(count(line, 'passed'), count(line, 'passed') + count(line, 'failed') + errors);
}

function mochaCounts(lines) {
  const passing = lastLine(lines, /^\d+\s+passing\b/i);
  if (!passing) return null;
  const failing = lastLine(lines, /^\d+\s+failing\b/i);
  const good = count(passing, 'passing');
  return ratio(good, good + (failing ? count(failing, 'failing') : 0));
}

// The reading in [0, 1], or null when the output has no counts.
function judgeReading(output) {
  const text = String(output || '').replace(/\r/g, '');
  // Strip color codes so a colored reporter reads the same as a piped one.
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = plain.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  for (const read of [stated, finalOf]) {
    const value = read(lines);
    if (value !== null) return value;
  }
  const node = nodeCounts(lines.join('\n'));
  if (node !== null) return node;
  for (const read of [jestCounts, pytestCounts, mochaCounts]) {
    const value = read(lines);
    if (value !== null) return value;
  }
  return null;
}

const TAIL_LINES = 40;
const TAIL_BYTES = 4096;

// The end of the judge's output, so the planner sees more than one line:
// the last 40 lines, at most 4 KB, color codes removed.
function outputTail(output) {
  const lines = String(output || '').replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let tail = lines.slice(-TAIL_LINES).join('\n');
  const bytes = Buffer.from(tail, 'utf8');
  if (bytes.length > TAIL_BYTES) {
    // Cut on a character boundary: drop continuation bytes at the cut.
    let start = bytes.length - TAIL_BYTES;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    tail = bytes.subarray(start).toString('utf8');
  }
  return tail;
}

// The data a judge_ran event carries for one run of the judge command.
function judgeRanData(result) {
  const data = { passed: result.passed, summary: result.summary || `exit ${result.exit}`, seconds: result.seconds };
  if (typeof result.reading === 'number' && Number.isFinite(result.reading)) data.reading = result.reading;
  if (typeof result.output_tail === 'string' && result.output_tail) data.output_tail = result.output_tail;
  return data;
}

// The output_tail of the latest judge run in fold order, or null.
function latestJudgeOutput(events) {
  const { compareEvents } = require('./campaign-core');
  const runs = (events || []).filter((e) => e.type === 'judge_ran').sort(compareEvents);
  const last = runs[runs.length - 1];
  return last && typeof last.data.output_tail === 'string' && last.data.output_tail ? last.data.output_tail : null;
}

// A drafted explanation belongs to the judge saved at the campaign's start.
// Keep display text separate from numeric readings and stored summaries.
function judgeMessage(result, events, judge) {
  const start = (events || []).find((event) => event.type === 'campaign_started');
  const explain = start && start.data.judge === judge && start.data.explain;
  if (typeof explain === 'string' && explain.trim()) return explain.trim();
  const output = typeof result.output_tail === 'string' ? result.output_tail : result.summary;
  const lines = String(output || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : `exit ${result.exit}`;
}

module.exports = { judgeReading, judgeRanData, judgeMessage, latestJudgeOutput, outputTail };
