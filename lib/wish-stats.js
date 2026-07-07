'use strict';

const fs = require('fs');
const path = require('path');
const { readWishEvents, readWishes } = require('./wish-store');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function countInWindow(items, now, startOffset, endOffset, timeFn) {
  const start = now - endOffset;
  const end = now - startOffset;
  return items.filter((item) => {
    const time = timeFn(item);
    return time !== null && time >= start && time < end;
  }).length;
}

function wishCreatedTime(wish) {
  return parseTime(wish && (wish.first_ts || wish.ts));
}

function reviewTime(review) {
  return parseTime(review && review.ts);
}

function isShippedWish(wish) {
  const status = String(wish && wish.status || '').trim();
  const verifyStatus = String(wish && wish.verify_status || '').trim();
  return status === 'complete'
    || status === 'completed'
    || ['verified', 'passed', 'success'].includes(verifyStatus);
}

function formatRatio(top, bottom) {
  if (!bottom) return '0.00';
  return (top / bottom).toFixed(2);
}

function formatAverage(scores) {
  if (!scores.length) return 'n/a';
  const value = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function scoresInWindow(reviews, now, startOffset, endOffset) {
  const start = now - endOffset;
  const end = now - startOffset;
  return reviews
    .filter((review) => {
      const time = reviewTime(review);
      return time !== null && time >= start && time < end;
    })
    .map((review) => review.review_score)
    .filter((score) => score !== undefined && score !== null && String(score).trim() !== '')
    .map((score) => Number(score))
    .filter((score) => Number.isFinite(score));
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function missionReceiptFiles(root = process.cwd()) {
  const runsDir = path.join(root, 'atris', 'runs');
  try {
    return fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^mission-.*\.json$/.test(entry.name))
      .map((entry) => path.join(runsDir, entry.name));
  } catch {
    return [];
  }
}

function verifierPassed(receipt) {
  const bools = [
    receipt && receipt.verifier_result && receipt.verifier_result.passed,
    receipt && receipt.result && receipt.result.verifier_result && receipt.result.verifier_result.passed,
    receipt && receipt.result && receipt.result.tick && receipt.result.tick.verifier_passed,
    receipt && receipt.result && receipt.result.passed,
  ];
  for (const value of bools) {
    if (typeof value === 'boolean') return value;
  }
  const statuses = [
    receipt && receipt.verifier_result && receipt.verifier_result.status,
    receipt && receipt.result && receipt.result.verifier_result && receipt.result.verifier_result.status,
  ];
  for (const value of statuses) {
    const status = Number(value);
    if (Number.isInteger(status)) return status === 0;
  }
  return false;
}

function haikuRates(root = process.cwd()) {
  const rates = {
    haiku: { passed: 0, total: 0 },
    other: { passed: 0, total: 0 },
  };
  for (const file of missionReceiptFiles(root)) {
    const receipt = readJsonFile(file);
    if (!receipt || (receipt.schema && receipt.schema !== 'atris.mission_receipt.v1')) continue;
    const runner = String(receipt.result && receipt.result.frozen && receipt.result.frozen.runner || '').trim().toLowerCase();
    if (!runner) continue;
    const bucket = runner === 'haiku' ? rates.haiku : rates.other;
    bucket.total += 1;
    if (verifierPassed(receipt)) bucket.passed += 1;
  }
  return rates;
}

function buildWishStats(root = process.cwd(), options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const wishes = readWishes(root);
  const reviews = readWishEvents(root).filter((event) => event && event.kind === 'review');
  const shipped = wishes.filter(isShippedWish);
  const thisWeekWishes = countInWindow(wishes, now, 0, WEEK_MS, wishCreatedTime);
  const priorWeekWishes = countInWindow(wishes, now, WEEK_MS, WEEK_MS * 2, wishCreatedTime);
  const thisWeekScores = scoresInWindow(reviews, now, 0, WEEK_MS);
  const priorWeekScores = scoresInWindow(reviews, now, WEEK_MS, WEEK_MS * 2);
  const rates = haikuRates(root);
  const lines = [
    `wishes this week: ${thisWeekWishes}, prior week ${priorWeekWishes}`,
    `reviews per shipped wish: ${formatRatio(reviews.length, shipped.length)}`,
    `average score trend: ${formatAverage(thisWeekScores)} this week, ${formatAverage(priorWeekScores)} prior week`,
    `haiku pass rate: ${rates.haiku.passed}/${rates.haiku.total}, all other runners ${rates.other.passed}/${rates.other.total}`,
  ];
  return {
    lines,
    wishes_this_week: thisWeekWishes,
    wishes_prior_week: priorWeekWishes,
    reviews_per_shipped_wish: formatRatio(reviews.length, shipped.length),
    average_score_this_week: formatAverage(thisWeekScores),
    average_score_prior_week: formatAverage(priorWeekScores),
    haiku: rates.haiku,
    other: rates.other,
  };
}

function localDateName(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function wishStatsLogPath(root = process.cwd(), date = new Date()) {
  return path.join(root, 'atris', 'logs', String(date.getFullYear()), `${localDateName(date)}.md`);
}

function writeWishStats(root = process.cwd(), lines = [], options = {}) {
  const date = options.date instanceof Date ? options.date : new Date();
  const file = wishStatsLogPath(root, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const prefix = existing.trim() ? '\n\n' : '';
  fs.appendFileSync(file, `${prefix}## Wish stats\n${lines.join('\n')}\n`, 'utf8');
  return file;
}

function printWishStats(root = process.cwd(), options = {}) {
  const stats = buildWishStats(root, options);
  if (options.write) writeWishStats(root, stats.lines, options);
  console.log(stats.lines.join('\n'));
  return 0;
}

module.exports = {
  buildWishStats,
  haikuRates,
  missionReceiptFiles,
  printWishStats,
  verifierPassed,
  wishStatsLogPath,
  writeWishStats,
};
