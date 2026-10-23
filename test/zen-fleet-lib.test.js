'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { fleetFile, fleetRepos, fleetZen, printFleet, riskyEdits } = require('../lib/zen-fleet');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-fleet-lib-'));
const fakeHome = path.join(sandbox, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

const saved = { HOME: process.env.HOME, ATRIS_ZEN_FLEET_FILE: process.env.ATRIS_ZEN_FLEET_FILE };
process.env.HOME = fakeHome;
delete process.env.ATRIS_ZEN_FLEET_FILE;

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let counter = 0;
function freshDir(label) {
  counter += 1;
  const dir = path.join(sandbox, `${label}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function gitRepo(label) {
  const dir = freshDir(label);
  const result = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(result.status, 0, result.stderr);
  return dir;
}

function put(root, file, body = 'x') {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('fleetFile defaults to ~/.atris/zen.json and honors the env override', () => {
  assert.strictEqual(fleetFile(), path.join(fakeHome, '.atris', 'zen.json'));

  process.env.ATRIS_ZEN_FLEET_FILE = path.join(sandbox, 'elsewhere.json');
  try {
    assert.strictEqual(fleetFile(), path.join(sandbox, 'elsewhere.json'));
  } finally {
    delete process.env.ATRIS_ZEN_FLEET_FILE;
  }
});

test('fleetRepos prefers command line paths and expands ~ and relative paths', () => {
  const listFile = path.join(sandbox, 'ignored-list.json');
  fs.writeFileSync(listFile, JSON.stringify({ repos: ['/from/file'] }));
  process.env.ATRIS_ZEN_FLEET_FILE = listFile;
  try {
    const repos = fleetRepos(['~/code/app', '~', 'rel/dir', '/abs/path/']);
    assert.deepStrictEqual(repos, [
      path.join(fakeHome, 'code', 'app'),
      fakeHome,
      path.resolve('rel/dir'),
      '/abs/path',
    ]);
  } finally {
    delete process.env.ATRIS_ZEN_FLEET_FILE;
  }
});

test('fleetRepos reads the list file, drops non-strings, and survives bad files', () => {
  const listFile = path.join(sandbox, 'list.json');
  process.env.ATRIS_ZEN_FLEET_FILE = listFile;
  try {
    assert.deepStrictEqual(fleetRepos(), [], 'missing file gives an empty list');

    fs.writeFileSync(listFile, '{ not json');
    assert.deepStrictEqual(fleetRepos(), [], 'unparseable file gives an empty list');

    fs.writeFileSync(listFile, JSON.stringify({ repos: 'not-an-array' }));
    assert.deepStrictEqual(fleetRepos(), [], 'repos that is not an array gives an empty list');

    fs.writeFileSync(listFile, JSON.stringify({ repos: ['~/one', 42, null, { path: 'x' }, '/two'] }));
    assert.deepStrictEqual(fleetRepos(), [path.join(fakeHome, 'one'), '/two']);
  } finally {
    delete process.env.ATRIS_ZEN_FLEET_FILE;
  }
});

test('riskyEdits flags unsaved databases and secrets, including inside new folders', () => {
  const repo = gitRepo('risky');
  put(repo, 'data/app.db');
  put(repo, 'cache.sqlite3');
  put(repo, '.env');
  put(repo, '.env.production');
  put(repo, 'keys/server.pem');
  put(repo, 'notes/my-secret-plan.txt');
  put(repo, 'new-folder/inner/state.duckdb');

  const risky = riskyEdits(repo).sort();
  assert.deepStrictEqual(risky, [
    '.env',
    '.env.production',
    'cache.sqlite3',
    'data/app.db',
    'keys/server.pem',
    'new-folder/inner/state.duckdb',
    'notes/my-secret-plan.txt',
  ]);
});

test('riskyEdits ignores growing logs, plain code, and clean repos', () => {
  const clean = gitRepo('clean');
  assert.deepStrictEqual(riskyEdits(clean), []);

  const repo = gitRepo('calm');
  put(repo, 'events.jsonl');
  put(repo, 'ledger.ndjson');
  put(repo, 'src/index.js');
  put(repo, 'README.md');
  put(repo, 'environment.md');
  assert.deepStrictEqual(riskyEdits(repo), []);

  assert.deepStrictEqual(riskyEdits(freshDir('not-a-git-repo')), [], 'a folder with no git gives nothing');
});

test('fleetZen reports a missing repo with a home-relative path and nothing for you', () => {
  const gone = path.join(fakeHome, 'projects', 'gone');
  const [result] = fleetZen({ repos: [gone], fetch: false });
  assert.strictEqual(result.repo, gone);
  assert.strictEqual(result.name, 'gone');
  assert.strictEqual(result.state, 'missing');
  assert.strictEqual(result.text, 'not found at ~/projects/gone');
  assert.deepStrictEqual(result.yours, []);

  const outside = path.join(sandbox, 'outside-home');
  const [far] = fleetZen({ repos: [outside], fetch: false });
  assert.strictEqual(far.text, `not found at ${outside}`);
});

test('fleetZen skips a whole repo that has unsaved live data and names up to three files', () => {
  const few = gitRepo('skip-few');
  put(few, 'app.db');
  put(few, '.env');
  const [skippedFew] = fleetZen({ repos: [few], fetch: false });
  assert.strictEqual(skippedFew.state, 'skipped');
  assert.match(skippedFew.text, /^skipped, unsaved live data or secrets: /);
  assert.ok(skippedFew.text.includes('app.db'));
  assert.ok(skippedFew.text.includes('.env'));
  assert.ok(!skippedFew.text.includes('more'));
  assert.deepStrictEqual(skippedFew.yours, []);

  const many = gitRepo('skip-many');
  for (const file of ['a.db', 'b.db', 'c.db', 'd.db', 'e.db']) put(many, file);
  const [skippedMany] = fleetZen({ repos: [many], fetch: false });
  assert.strictEqual(skippedMany.state, 'skipped');
  assert.ok(skippedMany.text.endsWith(' and 2 more'), skippedMany.text);
});

test('fleetZen returns one result per repo, in order', () => {
  const risky = gitRepo('order-risky');
  put(risky, 'prod.db');
  const missing = path.join(sandbox, 'order-missing');
  const results = fleetZen({ repos: [missing, risky], fetch: false });
  assert.deepStrictEqual(results.map((r) => r.name), ['order-missing', path.basename(risky)]);
  assert.deepStrictEqual(results.map((r) => r.state), ['missing', 'skipped']);
  assert.deepStrictEqual(fleetZen({ repos: [], fetch: false }), []);
});

test('printFleet lines up repo names, lists what is for you, and counts calm repos', () => {
  const lines = captureLog(() => printFleet([
    { name: 'app', state: 'zen', text: 'already zen', yours: [] },
    {
      name: 'longer-name',
      state: 'almost',
      text: 'dropped 2 stashes',
      more: ['your copy went to zen-backup/x'],
      yours: [{ text: 'review the old branch', cmd: 'git branch -D old' }],
    },
    { name: 'db', state: 'skipped', text: 'skipped, unsaved live data or secrets: app.db', yours: [] },
  ]));

  assert.deepStrictEqual(lines, [
    '',
    '  atris zen, every repo',
    '',
    '  app          already zen',
    '  longer-name  dropped 2 stashes',
    '               your copy went to zen-backup/x',
    '  db           skipped, unsaved live data or secrets: app.db',
    '',
    '  for you',
    '  longer-name: review the old branch   git branch -D old',
    '',
    '  1 of 3 repos zen, 1 skipped for you to look at.',
    '',
  ]);
});

test('printFleet leaves out the for-you block and skipped count when there is nothing to say', () => {
  const lines = captureLog(() => printFleet([
    { name: 'one', state: 'zen', text: 'zen', yours: [] },
    { name: 'two', state: 'zen', text: 'already zen', yours: [] },
  ]));

  assert.ok(!lines.includes('  for you'));
  assert.strictEqual(lines[lines.length - 2], '  2 of 2 repos zen.');
});
