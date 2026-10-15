'use strict';

// Match Node 24's default test discovery, including helper files and tests
// outside test/. New files get a conservative estimate and always run.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Baseline: GitHub Actions run 38693452528, summed top-level test times
// per file (commands parts retain their own measured cost). Refresh from
// complete unit-job logs when the suite changes substantially. Stale weights
// only affect balance, never which tests are discovered.
const durations = require('../test/ci-file-durations.json');
const pattern = '**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}';

function discover(root) {
  return [...fs.globSync(pattern, {
    cwd: root,
    exclude: (name) => name === 'node_modules',
  })].sort();
}

function assign(files, count, weights = durations) {
  const shards = Array.from({ length: count }, () => ({ files: [], milliseconds: 0 }));
  const cost = (file) => Number.isFinite(weights[file]) && weights[file] > 0 ? weights[file] : 1000;
  const ordered = [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b, 'en'));
  for (const file of ordered) {
    const lightest = shards.reduce((a, b) => b.milliseconds < a.milliseconds ? b : a);
    lightest.files.push(file);
    lightest.milliseconds += cost(file);
  }
  return shards;
}

function main(args, root = path.resolve(__dirname, '..')) {
  const match = /^(\d+)\/(\d+)$/.exec(args[0] || '');
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (args.length !== 1 || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count || count > 1024) {
    console.error('choose a test group such as 1/8.');
    return 1;
  }
  const shard = assign(discover(root), count)[index - 1];
  // Calling node --test with no files would rediscover and run everything.
  if (!shard.files.length) return 0;
  const env = { ...process.env, ATRIS_TEST_SPLIT: '1' };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', ...shard.files], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (run.error) console.error(run.error.message);
  return run.status ?? 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { discover, assign, main };
