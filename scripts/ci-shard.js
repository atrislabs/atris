#!/usr/bin/env node
// Runs one CI test shard, split by measured time instead of file order.
// node --test --test-shard deals files round-robin, so on 2026-10-15 the
// eight shards took 42s to 128s and every merge waited on the slowest one
// twice (the pull request, then the merge queue). This hands the slowest
// files out first, each to the shard with the least time so far.
//
//   node scripts/ci-shard.js 3/8          run shard 3 of 8
//   node scripts/ci-shard.js 3/8 --list   print its files instead
//
// Times live in test/shard-weights.json (milliseconds per file). A file with
// no recorded time counts as the median, so new tests never fall out of a
// shard. Refresh the times after big test changes:
//   ATRIS_TEST_SPLIT=1 node --test --test-reporter=./scripts/shard-weights-reporter.js > test/shard-weights.json
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEIGHTS = path.join(ROOT, 'test', 'shard-weights.json');
// The same files bare `node --test` finds (Node 24 default pattern).
const DEFAULT_PATTERN = '**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}';

function listTestFiles(root = ROOT) {
  const skip = (entry) => String(entry && entry.name !== undefined ? entry.name : entry)
    .split(/[\\/]/).includes('node_modules');
  return fs.globSync(DEFAULT_PATTERN, { cwd: root, exclude: skip })
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

function readWeights(file = WEIGHTS) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function median(values) {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// Longest file first onto the lightest shard. Ties break on name and shard
// number, so every machine computes the same split. Node sorts the files it
// is given by name, so the order inside a shard does not matter.
function assignShards(files, weights, total) {
  const known = files.map((file) => weights[file]).filter((ms) => Number.isFinite(ms) && ms >= 0);
  const fallback = median(known);
  const weightOf = (file) => (Number.isFinite(weights[file]) && weights[file] >= 0 ? weights[file] : fallback);
  const order = [...files].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));
  const shards = Array.from({ length: total }, () => ({ ms: 0, files: [] }));
  for (const file of order) {
    let lightest = 0;
    for (let i = 1; i < total; i += 1) if (shards[i].ms < shards[lightest].ms) lightest = i;
    shards[lightest].ms += weightOf(file);
    shards[lightest].files.push(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

function parseShard(value) {
  const match = String(value || '').match(/^(\d+)\/(\d+)$/);
  const index = match ? Number(match[1]) : 0;
  const total = match ? Number(match[2]) : 0;
  if (!total || index < 1 || index > total) return null;
  return { index, total };
}

function main(argv) {
  const shard = parseShard(argv[0]);
  if (!shard) {
    console.error('usage: node scripts/ci-shard.js <index>/<total> [--list]');
    return 2;
  }
  const { files } = assignShards(listTestFiles(), readWeights(), shard.total)[shard.index - 1];
  if (argv.includes('--list')) {
    process.stdout.write(files.join('\n') + (files.length ? '\n' : ''));
    return 0;
  }
  if (!files.length) return 0;
  const run = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
  return run.status === null ? 1 : run.status;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { assignShards, listTestFiles, parseShard, readWeights };
