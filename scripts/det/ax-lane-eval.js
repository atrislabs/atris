#!/usr/bin/env node
'use strict';

// Grade the ax auto lane picker against the labeled gold set.
// Usage: node scripts/det/ax-lane-eval.js [--json] [--min-accuracy <0..1>]
// Cost-weighted error: routing up-lane work down (quality miss) counts 3x
// routing down-lane work up (cost miss), because a wrong cheap answer is
// worse than an overpriced right one.

const fs = require('node:fs');
const path = require('node:path');
const { pickLane } = require('../../lib/ax-auto-lane');

const LANES = ['fast', 'pro', 'max', 'code-fast'];
// Depth order for miss direction; code-fast sits beside pro in cost.
const DEPTH = { fast: 0, 'code-fast': 1, pro: 1, max: 2 };
const QUALITY_MISS_WEIGHT = 3;
const COST_MISS_WEIGHT = 1;

function loadGold() {
  const dataIndex = process.argv.indexOf('--data');
  const file = dataIndex >= 0
    ? path.resolve(process.argv[dataIndex + 1])
    : path.join(__dirname, 'data', 'ax-lane-gold.jsonl');
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function evaluate() {
  const gold = loadGold();
  const confusion = {};
  for (const a of LANES) {
    confusion[a] = {};
    for (const b of LANES) confusion[a][b] = 0;
  }
  const misses = [];
  let correct = 0;
  let weightedError = 0;
  let worstWeight = 0;
  for (const row of gold) {
    const picked = pickLane(row.message).lane;
    confusion[row.lane][picked] += 1;
    if (picked === row.lane) {
      correct += 1;
      continue;
    }
    const qualityMiss = DEPTH[picked] < DEPTH[row.lane];
    const weight = qualityMiss ? QUALITY_MISS_WEIGHT : COST_MISS_WEIGHT;
    weightedError += weight;
    worstWeight += QUALITY_MISS_WEIGHT;
    misses.push({
      message: row.message.slice(0, 70),
      gold: row.lane,
      picked,
      kind: qualityMiss ? 'quality-miss' : 'cost-miss',
      why: row.why,
    });
  }
  const perLane = LANES.map((lane) => {
    const truePos = confusion[lane][lane];
    const goldCount = LANES.reduce((sum, other) => sum + confusion[lane][other], 0);
    const pickedCount = LANES.reduce((sum, other) => sum + confusion[other][lane], 0);
    return {
      lane,
      gold: goldCount,
      recall: goldCount ? truePos / goldCount : null,
      precision: pickedCount ? truePos / pickedCount : null,
    };
  });
  const total = gold.length;
  return {
    total,
    correct,
    accuracy: correct / total,
    quality_misses: misses.filter((m) => m.kind === 'quality-miss').length,
    cost_misses: misses.filter((m) => m.kind === 'cost-miss').length,
    weighted_error_rate: worstWeight ? weightedError / (total * QUALITY_MISS_WEIGHT) : 0,
    per_lane: perLane,
    confusion,
    misses,
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const minIndex = args.indexOf('--min-accuracy');
  const minAccuracy = minIndex >= 0 ? Number(args[minIndex + 1]) : null;
  const report = evaluate();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const pct = (value) => (value === null ? '  n/a' : `${(value * 100).toFixed(0)}%`.padStart(5));
    console.log(`\nax auto lane eval: ${report.correct}/${report.total} correct (${pct(report.accuracy)})`);
    console.log(`quality misses: ${report.quality_misses}  cost misses: ${report.cost_misses}  weighted error: ${(report.weighted_error_rate * 100).toFixed(1)}%\n`);
    console.log('lane        gold  recall  precision');
    for (const row of report.per_lane) {
      console.log(`${row.lane.padEnd(11)} ${String(row.gold).padStart(4)}  ${pct(row.recall)}   ${pct(row.precision)}`);
    }
    if (report.misses.length) {
      console.log('\nmisses:');
      for (const miss of report.misses) {
        console.log(`  [${miss.kind}] gold=${miss.gold} picked=${miss.picked}  "${miss.message}"`);
      }
    }
    console.log('');
  }
  if (minAccuracy !== null && report.accuracy < minAccuracy) {
    console.error(`accuracy ${(report.accuracy * 100).toFixed(1)}% is below the ${(minAccuracy * 100).toFixed(0)}% floor`);
    process.exit(1);
  }
}

main();
