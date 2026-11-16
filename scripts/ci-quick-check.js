'use strict';

// The pull request check: the quick list in test/fast-tests.txt plus every
// test file the pull request adds or edits. The merge queue still runs the
// whole set through scripts/ci-test-shard.js before anything reaches master.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discover } = require('./ci-test-shard');

function changedFiles(root, base) {
  // Without rename pairing a moved file reads as deleted plus added, and
  // deleted files are filtered out, so nothing gone is ever run.
  const run = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', base, 'HEAD', '--'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.error || run.status !== 0) {
    throw new Error(`could not compare with ${base}: ${(run.stderr || run.error?.message || '').trim()}`);
  }
  return run.stdout.split('\0').filter(Boolean);
}

function pick(root, base) {
  const quick = fs.readFileSync(path.join(root, 'test', 'fast-tests.txt'), 'utf8')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  // Only names the full run would also treat as tests, and only ones on disk.
  const tests = new Set(discover(root));
  const changed = changedFiles(root, base)
    .filter((file) => tests.has(file) && fs.existsSync(path.join(root, file)));
  return { quick, changed, files: [...new Set([...quick, ...changed])] };
}

function main(args, root = path.resolve(__dirname, '..')) {
  if (args.length !== 1 || !args[0]) {
    console.error('name the revision to compare with, such as HEAD^1.');
    return 1;
  }
  let picked;
  try {
    picked = pick(root, args[0]);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const missing = picked.quick.filter((file) => !fs.existsSync(path.join(root, file)));
  if (missing.length) {
    console.error(`test/fast-tests.txt names files that are gone: ${missing.join(', ')}`);
    return 1;
  }
  // Calling node --test with no files would rediscover and run everything.
  if (!picked.files.length) {
    console.error('nothing to run: the quick list is empty and no test file changed.');
    return 1;
  }
  console.log(`quick list: ${picked.quick.length} files. changed by this pull request: ${picked.changed.length}.`);
  for (const file of picked.changed) console.log(`  ${file}`);
  // Same environment as npm run test:fast: no shard split, so a big file
  // runs whole instead of only its first part.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.ATRIS_TEST_SPLIT;
  const run = spawnSync(process.execPath, ['--test', ...picked.files], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (run.error) console.error(run.error.message);
  return run.status ?? 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { pick, main };
