'use strict';

// The broad-change pull request check: the quick list in test/fast-tests.txt, every test
// file the pull request adds or edits, and the test files that cover the
// source files it changes (the tests that require them, directly or through
// other files). When the impact planner calls for this fallback, the queue runs the whole set through
// scripts/ci-test-shard.js before anything reaches master.
// An optional group such as 2/3 splits the picked files by recorded run time,
// so a few machines share the work.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discover, assign } = require('./ci-test-shard');
const durations = require('../test/ci-file-durations.json');

// How much the covering step may add. The require graph here is dense: about
// half the files in lib/ and commands/ are reached by hundreds of tests through
// a few hubs such as commands/mission.js, so following every hop would pull in
// most of the suite. Tests are taken nearest first: the tests that require the
// file itself, then the tests that reach it through one more file, and so on,
// keeping whole rings while the file stays within COVER_CAP tests. If even the
// nearest ring is over the cap, the merge queue covers that file, as it does
// today.
const COVER_CAP = 40;
// Recorded run time, in milliseconds, summed over every test the covering step
// adds to one pull request, shared by all its changed files. A few browser
// tests take minutes each, so a count alone cannot keep the check short. The
// quick job spreads the work over three machines, so this adds about a third
// of it to the time of the slowest one.
const COVER_MILLISECONDS = 120000;

const GRAPH_FILE = /\.(?:[cm]?[jt]s|json)$/;
const CODE_FILE = /\.[cm]?[jt]s$/;
const EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.ts', '.mts', '.cts'];
// require('./x'), require.resolve('./x'), import x from './x', import './x',
// import('./x'), export * from './x'. Only plain string paths: a path built
// at run time, or a command a test starts as a child process (bin/atris.js),
// cannot be followed and is left to the merge queue.
const SPECIFIER = /\brequire(?:\.resolve)?\s*\(\s*(['"`])([^'"`$\n]+)\1\s*[,)]|\bfrom\s*(['"])([^'"\n]+)\3|\bimport\s*\(?\s*(['"])([^'"\n]+)\5/g;

function changedFiles(root, base) {
  // Without rename pairing a moved file reads as deleted plus added. Deleted
  // files come back too: a test that still requires one is now broken.
  const run = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD', '--'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.error || run.status !== 0) {
    throw new Error(`could not compare with ${base}: ${(run.stderr || run.error?.message || '').trim()}`);
  }
  return run.stdout.split('\0').filter(Boolean);
}

function isFile(root, file) {
  try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; }
}

// Every place a relative path could point to, in the order node tries them.
function candidates(base) {
  return [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => `${base}/index${ext}`)];
}

// The files each file requires, found by reading the files reachable from the
// tests, then turned around: file -> the files that require it. Reads each file
// once. Node modules and anything outside the repo are skipped. A path that
// points at nothing (a file this pull request deleted) still gets an entry
// under every name it could have had, so the tests that still need it show up.
function requirers(root, tests) {
  const reverse = new Map();
  const seen = new Set(tests);
  const stack = [...tests];
  const add = (target, from) => {
    if (!reverse.has(target)) reverse.set(target, new Set());
    reverse.get(target).add(from);
  };
  while (stack.length) {
    const file = stack.pop();
    if (!CODE_FILE.test(file)) continue;
    let source;
    try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[2] ?? match[4] ?? match[6];
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (target.startsWith('../') || target === '..' || target.split('/').includes('node_modules')) continue;
      const found = candidates(target).find((name) => isFile(root, name));
      for (const name of found ? [found] : candidates(target)) add(name, file);
      if (found && !seen.has(found)) {
        seen.add(found);
        stack.push(found);
      }
    }
  }
  return reverse;
}

// The tests that reach `file`, grouped by how many requires away they are,
// nearest first. A test helper that other tests require is passed through but
// not counted: running it alone proves nothing.
function ringsFor(reverse, tests, file) {
  const seen = new Set([file]);
  const rings = [];
  let ring = [file];
  while (ring.length) {
    const next = [];
    for (const name of ring) {
      for (const from of reverse.get(name) || []) {
        if (seen.has(from)) continue;
        seen.add(from);
        next.push(from);
      }
    }
    const hit = next.filter((name) => tests.has(name) && !reverse.has(name)).sort();
    if (hit.length) rings.push(hit);
    ring = next;
  }
  return rings;
}

// Which tests to add for the files a pull request changes. Returns one entry
// per changed file that some test reaches, by file name: `total` is how many
// tests reach it and `tests` is the nearest rings that were kept, none if even
// the nearest ring was over a limit. `graph` is a map from requirers(), for
// callers that ask many times.
function cover(root, changed, tests, { cap = COVER_CAP, milliseconds = COVER_MILLISECONDS, weights = durations, graph } = {}) {
  const graphed = changed.filter((file) => GRAPH_FILE.test(file));
  if (!graphed.length) return [];
  const reverse = graph ?? requirers(root, tests);
  const cost = (file) => Number.isFinite(weights[file]) && weights[file] > 0 ? weights[file] : 1000;
  const sum = (files) => files.reduce((total, file) => total + cost(file), 0);
  const planned = [];
  for (const source of graphed) {
    const rings = ringsFor(reverse, tests, source);
    const total = rings.reduce((count, ring) => count + ring.length, 0);
    if (total) planned.push({ source, rings, total });
  }
  // The shared time goes to the files that are cheapest to cover first.
  planned.sort((a, b) => sum(a.rings[0]) - sum(b.rings[0]) || a.source.localeCompare(b.source, 'en'));
  const chosen = new Set();
  let spent = 0;
  const entries = planned.map(({ source, rings, total }) => {
    const picked = [];
    for (const ring of rings) {
      const price = sum(ring.filter((file) => !chosen.has(file)));
      if (picked.length + ring.length > cap || spent + price > milliseconds) break;
      picked.push(...ring);
      for (const file of ring) chosen.add(file);
      spent += price;
    }
    return { source, total, tests: picked };
  });
  return entries.sort((a, b) => a.source.localeCompare(b.source, 'en'));
}

function pick(root, base, options = {}) {
  const quick = fs.readFileSync(path.join(root, 'test', 'fast-tests.txt'), 'utf8')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  // Only names the full run would also treat as tests, and only ones on disk.
  const testFiles = discover(root);
  const tests = new Set(testFiles);
  const all = changedFiles(root, base);
  const changed = all.filter((file) => tests.has(file) && fs.existsSync(path.join(root, file)));
  const covering = cover(root, all, tests, options);
  const added = covering.flatMap((entry) => entry.tests);
  return { quick, changed, covering, files: [...new Set([...quick, ...changed, ...added])] };
}

// A short plain account of what the covering step added and why.
function describeCover(picked, { cap = COVER_CAP, milliseconds = COVER_MILLISECONDS } = {}) {
  if (!picked.covering.length) return [];
  const known = new Set([...picked.quick, ...picked.changed]);
  const extra = [...new Set(picked.covering.flatMap((entry) => entry.tests))].filter((file) => !known.has(file));
  const lines = [`tests that reach the changed source files: ${extra.length} added.`];
  for (const { source, total, tests } of picked.covering) {
    if (!tests.length) {
      lines.push(`  ${source}: ${total} test files reach it, over the limit for a pull request (${cap} files, ${milliseconds / 1000} s of tests); the merge queue covers it.`);
    } else if (tests.length === total) {
      lines.push(`  ${source}: ${total === 1 ? 'the 1 test file' : `all ${total} test files`} that reach it.`);
    } else {
      lines.push(`  ${source}: the ${tests.length} nearest of ${total} test files that reach it; the merge queue covers the rest.`);
    }
  }
  for (const file of extra) lines.push(`  ${file}`);
  return lines;
}

function main(args, root = path.resolve(__dirname, '..')) {
  const group = /^(\d+)\/(\d+)$/.exec(args[1] || '1/1');
  const index = Number(group?.[1]);
  const count = Number(group?.[2]);
  if (args.length < 1 || args.length > 2 || !args[0] || !group || index < 1 || index > count || count > 64) {
    console.error('name the revision to compare with and, if you like, a group: HEAD^1 2/3.');
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
  for (const line of describeCover(picked)) console.log(line);
  const files = assign(picked.files, count)[index - 1].files;
  console.log(`group ${index}/${count} runs ${files.length} of ${picked.files.length} files.`);
  // Fewer files than groups leaves a group empty; the others ran them all.
  if (!files.length) return 0;
  // Same environment as npm run test:fast: no shard split, so a big file
  // runs whole instead of only its first part.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.ATRIS_TEST_SPLIT;
  // Most quick tests wait on children or timers; use eight slots on four CPUs.
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=8', ...files], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (run.error) console.error(run.error.message);
  return run.status ?? 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { changedFiles, pick, main, cover, requirers, describeCover, COVER_CAP, COVER_MILLISECONDS };
