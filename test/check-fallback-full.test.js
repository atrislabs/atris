'use strict';

// When a selector cannot pick the tests (no test covers a changed file, or too
// many were picked), its fallback stands in. A fallback that runs only part of
// the tests can never prove a change: the run says so, the verdict is not
// proven, --lint-map flags the map and --verify refuses a receipt that says
// otherwise. A gate, a check in the release gate, a check marked "full": true
// or a lane check is a whole fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkCommand } = require('../commands/check');
const { validateMap, planChecks, lintMap, fallbackIsFull } = require('../lib/check-plan');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function project(t, map) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '--quiet', '--initial-branch=master');
  for (const [key, value] of [['user.email', 'check@example.test'], ['user.name', 'check test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(root, 'config', key, value);
  write(root, 'ok.js', 'process.exit(0);\n');
  write(root, 'src/lonely.js', 'module.exports = function lonely() {\n  return 1;\n};\n');
  write(root, 'scripts/test-other.mjs', "import assert from 'node:assert';\nassert.ok(true);\n");
  write(root, 'proof.test.js', "const assert = require('assert');\nassert.ok(require('./src/lonely')() >= 1);\n");
  write(root, 'atris/checks.json', JSON.stringify(map, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  git(root, 'switch', '--quiet', '-c', 'feature');
  write(root, 'src/lonely.js', 'module.exports = function lonely() {\n  return 2;\n};\n');
  return root;
}

async function check(root, args) {
  const lines = [];
  const saved = process.env.ATRIS_CHECK_PERSON;
  process.env.ATRIS_CHECK_PERSON = '1';
  try {
    const code = await checkCommand(args, { cwd: root, log: (line) => lines.push(String(line)) });
    return { code, out: lines.join('\n') };
  } finally {
    if (saved === undefined) delete process.env.ATRIS_CHECK_PERSON; else process.env.ATRIS_CHECK_PERSON = saved;
  }
}

const selector = (fallback) => ({ select: 'node-test', roots: ['scripts'], run: 'node {file}', fallback, seconds: 1 });
const PROOF = ['--proof', 'node proof.test.js'];

test('a fallback that is one command (a partial list) runs, but the change is never proven', async (t) => {
  const root = project(t, { checks: { tests: selector('node scripts/test-other.mjs'), full: { run: 'node ok.js' } }, gates: { release: ['full'] }, default: ['tests'] });
  const result = await check(root, PROOF);
  assert.equal(result.code, 3, result.out);
  assert.match(result.out, /needs full gate\s+tests fallback.*runs only part of the tests/);
  const dir = path.join(root, '.atris', 'receipts');
  const file = path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('check-')));
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(receipt.verdict, 'partly');
  const row = receipt.checks.find((entry) => entry.name === 'tests fallback');
  assert.equal(row.partial_fallback, true);
  // A forger marks it passed.
  Object.assign(row, { status: 'passed' });
  delete row.lane;
  receipt.verdict = 'proven';
  fs.writeFileSync(file, JSON.stringify(receipt));
  const forged = await check(root, ['--verify']);
  assert.equal(forged.code, 1);
  assert.match(forged.out, /tests fallback is a fallback that runs only part of the tests, so it can never count as passed/);
});

test('a fallback check outside the release gate is partial; one in the release gate, marked full, or a gate name is whole', async (t) => {
  const base = { checks: { tests: selector('some'), some: { run: 'node ok.js' }, full: { run: 'node ok.js' } }, gates: { release: ['full'] }, default: ['tests'] };
  const partial = project(t, base);
  assert.equal((await check(partial, PROOF)).code, 3);
  const inGate = project(t, { ...base, checks: { ...base.checks, tests: selector('full') } });
  assert.equal((await check(inGate, PROOF)).code, 0);
  const marked = project(t, { ...base, checks: { ...base.checks, some: { run: 'node ok.js', full: true } } });
  assert.equal((await check(marked, PROOF)).code, 0);
  const gate = project(t, { ...base, checks: { ...base.checks, tests: selector('release') } });
  const result = await check(gate, PROOF);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /pass\s+full/, 'a gate name runs the whole gate');
});

test('--lint-map flags a map whose fallback is a partial list, and passes a whole one', () => {
  const partial = lintMap({ checks: { tests: selector('node scripts/test-a.mjs scripts/test-b.mjs'), full: { run: 'node ok.js' } }, gates: { release: ['full'] } });
  assert.equal(partial.errors.length, 0);
  assert.match(partial.warnings.join('\n'), /check "tests" falls back to the command "node scripts\/test-a\.mjs scripts\/test-b\.mjs": that runs only part of the tests/);
  const whole = lintMap({ checks: { tests: selector('full'), full: { run: 'node ok.js', seconds: 60 } }, gates: { release: ['full'] } });
  assert.deepEqual(whole.warnings, []);
  const map = validateMap({ checks: { tests: selector('lane'), lane: { run: 'node ok.js', where: 'no-screen' } } });
  assert.equal(fallbackIsFull(map, 'lane'), true, 'a lane check is whole: it never passes here anyway');
});

test('a check picked by its own rule as well as by a partial fallback is not marked partial', () => {
  const map = validateMap({ checks: { tests: selector('some'), some: { run: 'node ok.js', when: ['src/**'] } } });
  const picked = planChecks(map, ['src/lonely.js'], { listFiles: () => ['src/lonely.js', 'scripts/test-other.mjs'], readFile: () => '' });
  const some = picked.selected.find((entry) => entry.key === 'some');
  assert.ok(some);
  assert.equal(some.partialFallback, undefined);
});
