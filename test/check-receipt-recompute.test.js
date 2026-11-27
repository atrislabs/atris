'use strict';

// atris check --verify works the plan out again from the diff and the default
// branch's map, and refuses a receipt that does not hold up against it. Each
// case hand-edits a real receipt the way a forger would. Every repo is a
// throwaway one with a local bare origin: no network, nothing on screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkCommand } = require('../commands/check');
const { planChecks, validateMap } = require('../lib/check-plan');
const { recheckReceipt } = require('../lib/check-recompute');

const OK = 'process.exit(0);\n';
const FAIL = "console.log('broken'); process.exit(1);\n";

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function project(t, map, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recompute-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=master', remote);
  git(dir, 'init', '--quiet', '--initial-branch=master', root);
  for (const [key, value] of [['user.email', 'check@example.test'], ['user.name', 'check test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(root, 'config', key, value);
  git(root, 'remote', 'add', 'origin', remote);
  write(root, 'ok.js', OK);
  write(root, 'fail.js', FAIL);
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 1;\n};\n');
  write(root, 'proof.test.js', "const assert = require('assert');\nconst feature = require('./src/feature');\nassert.ok(feature() >= 1);\n");
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  write(root, 'atris/checks.json', JSON.stringify(map, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  git(root, 'push', '--quiet', 'origin', 'master');
  git(root, 'remote', 'set-head', 'origin', 'master');
  git(root, 'switch', '--quiet', '-c', 'feature');
  return root;
}

function commit(root, message = 'change') {
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', message);
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

function receiptFile(root) {
  const dir = path.join(root, '.atris', 'receipts');
  return path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('check-')));
}

function editReceipt(root, edit) {
  const file = receiptFile(root);
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(receipt);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

const MAP = {
  checks: {
    lint: { run: 'node ok.js', always: true, seconds: 1 },
    feature: { run: 'node ok.js', when: ['src/**'] },
    auth: { run: 'node ok.js', risk: 'sign-in' },
    full: { run: 'node ok.js' },
  },
  risk: { low: ['**/*.md'], high: { 'sign-in': ['src/auth/**'] } },
  gates: { release: ['lint', 'full'] },
  default: ['full'],
};

const PROOF = ['--proof', 'node proof.test.js'];
const featureTwo = (root) => write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');

test('a genuine receipt verifies, and the receipt names the map that decided', async (t) => {
  const root = project(t, MAP);
  featureTwo(root);
  commit(root, 'Feature two\n\nProof: node proof.test.js');
  assert.equal((await check(root, [])).code, 0);
  const receipt = JSON.parse(fs.readFileSync(receiptFile(root), 'utf8'));
  assert.match(receipt.map_from, /^the merge base [0-9a-f]{12}$/);
  assert.equal(receipt.map_blob, git(root, 'rev-parse', 'master:atris/checks.json'));
  const verified = await check(root, ['--verify']);
  assert.equal(verified.code, 0, verified.out);
  assert.match(verified.out, /worked out again/);
});

test('forged verdict: a failed check hand-edited to proven is refused, naming the check', async (t) => {
  const map = { ...MAP, checks: { ...MAP.checks, feature: { run: 'node fail.js', when: ['src/**'] } } };
  const root = project(t, map);
  featureTwo(root);
  assert.equal((await check(root, PROOF)).code, 1);
  editReceipt(root, (r) => { r.verdict = 'proven'; });
  const verdictOnly = await check(root, ['--verify']);
  assert.equal(verdictOnly.code, 1);
  assert.match(verdictOnly.out, /the receipt says proven, but its own rows make it failed/);
  editReceipt(root, (r) => { r.checks.find((row) => row.name === 'feature').status = 'passed'; });
  const rowToo = await check(root, ['--verify']);
  assert.equal(rowToo.code, 1);
  assert.match(rowToo.out, /feature is marked passed, but its exit code is 1/);
});

test('a receipt that omits a check the plan picks, or marks it skipped by rule, is refused', async (t) => {
  const root = project(t, MAP);
  featureTwo(root);
  assert.equal((await check(root, PROOF)).code, 0);
  editReceipt(root, (r) => { r.checks.find((row) => row.name === 'feature').status = 'skipped-by-rule'; });
  const skipped = await check(root, ['--verify']);
  assert.equal(skipped.code, 1);
  assert.match(skipped.out, /the receipt skipped feature by rule, but the plan picks it/);
  editReceipt(root, (r) => { r.checks = r.checks.filter((row) => row.name !== 'feature'); });
  const omitted = await check(root, ['--verify']);
  assert.equal(omitted.code, 1);
  assert.match(omitted.out, /the receipt leaves out feature, which the plan picks/);
});

test('sha mismatch: the same code under another commit is refused', async (t) => {
  const root = project(t, MAP);
  featureTwo(root);
  commit(root, 'Feature two\n\nProof: node proof.test.js');
  assert.equal((await check(root, [])).code, 0);
  git(root, 'commit', '--quiet', '--amend', '-m', 'Feature two, reworded\n\nProof: node proof.test.js');
  const result = await check(root, ['--verify', '--receipt', receiptFile(root)]);
  assert.equal(result.code, 1);
  assert.match(result.out, /the receipt names commit [0-9a-f]{12}, but the code here is commit [0-9a-f]{12}/);
});

test('a receipt that claims a lower risk tier than the change has is refused', async (t) => {
  const root = project(t, MAP, { 'src/auth/login.js': 'module.exports = 1;\n' });
  write(root, 'src/auth/login.js', 'module.exports = 2;\n');
  write(root, 'proof.test.js', "const assert = require('assert');\nassert.equal(require('./src/auth/login'), 2);\n");
  assert.equal((await check(root, PROOF)).code, 0);
  editReceipt(root, (r) => { r.risk_tier = 'normal'; });
  const result = await check(root, ['--verify']);
  assert.equal(result.code, 1);
  assert.match(result.out, /the receipt claims normal risk, but the change is high risk \(src\/auth\/login\.js\)/);
});

test('map edited in the same change: the default branch map decides, and a receipt made by the new map is refused', async (t) => {
  const map = { ...MAP, checks: { ...MAP.checks, feature: { run: 'node fail.js', when: ['src/**'] } } };
  const root = project(t, map);
  featureTwo(root);
  // The change also rewrites the failing check into one that passes.
  write(root, 'atris/checks.json', JSON.stringify({ ...map, checks: { ...map.checks, feature: { run: 'node ok.js', when: ['src/**'] } } }, null, 2));
  const result = await check(root, PROOF);
  assert.equal(result.code, 1, 'the base map still runs the failing check');
  const receipt = JSON.parse(fs.readFileSync(receiptFile(root), 'utf8'));
  assert.equal(receipt.risk_tier, 'high', 'a change to the map is high risk');
  assert.equal(receipt.checks.find((row) => row.name === 'feature').run, 'node fail.js');
  assert.match(receipt.map_from, /merge base/);
  // A forger rewrites the receipt as if the new map had decided.
  editReceipt(root, (r) => {
    r.map_blob = git(root, 'hash-object', 'atris/checks.json');
    for (const row of r.checks) if (row.status === 'failed') { row.status = 'passed'; row.exit_code = 0; row.run = 'node ok.js'; }
    r.verdict = 'proven';
  });
  const forged = await check(root, ['--verify']);
  assert.equal(forged.code, 1);
  assert.match(forged.out, /made with a different map/);
});

test('a no-screen check relabelled as a here check that passed is refused', async (t) => {
  const map = { ...MAP, checks: { ...MAP.checks, app: { run: 'node ok.js', where: 'no-screen', when: ['src/**'] } } };
  const root = project(t, map);
  featureTwo(root);
  assert.equal((await check(root, PROOF)).code, 3);
  editReceipt(root, (r) => {
    const row = r.checks.find((entry) => entry.name === 'app');
    Object.assign(row, { status: 'passed', where: 'here', exit_code: 0 });
    delete row.lane;
    r.verdict = 'proven';
  });
  const result = await check(root, ['--verify']);
  assert.equal(result.code, 1);
  assert.match(result.out, /app is a no-screen check, but the receipt calls it here/);
  assert.match(result.out, /app only runs in the no-screen lane, but the receipt says it passed in the here lane/);
});

test('a proof swapped for one about other code, and a receipt with no map named, are refused', async (t) => {
  const root = project(t, MAP);
  featureTwo(root);
  assert.equal((await check(root, PROOF)).code, 0);
  editReceipt(root, (r) => { r.proof.command = 'node ok.js'; });
  const swapped = await check(root, ['--verify']);
  assert.equal(swapped.code, 1);
  assert.match(swapped.out, /the proof is marked passed, but/);
  editReceipt(root, (r) => { r.proof.command = 'node proof.test.js'; delete r.map_blob; });
  const old = await check(root, ['--verify']);
  assert.equal(old.code, 1);
  assert.match(old.out, /does not say which map it was made with/);
});

test('the lander view: a check that passed in some lane still needs it, while --verify trusts a lane receipt', async (t) => {
  const map = { ...MAP, checks: { ...MAP.checks, app: { run: 'node ok.js', where: 'no-screen', when: ['src/**'] } } };
  const root = project(t, map);
  featureTwo(root);
  commit(root, 'Feature two\n\nProof: node proof.test.js');
  assert.equal((await check(root, [])).code, 3);
  // As a no-screen runner would have written it.
  editReceipt(root, (r) => {
    const row = r.checks.find((entry) => entry.name === 'app');
    Object.assign(row, { status: 'passed', exit_code: 0 });
    delete row.lane;
    Object.assign(r, { lane: 'no-screen', person_machine: false, verdict: 'proven' });
  });
  const receipt = JSON.parse(fs.readFileSync(receiptFile(root), 'utf8'));
  const sha = git(root, 'rev-parse', 'HEAD');
  const trusted = recheckReceipt(root, receipt, { sha });
  assert.equal(trusted.ok, true, trusted.why);
  assert.equal(trusted.verdict, 'proven');
  const lander = recheckReceipt(root, receipt, { sha, trustLane: false });
  assert.equal(lander.ok, true, lander.why);
  assert.equal(lander.verdict, 'partly');
  assert.deepEqual(lander.needs_lane, ['app']);
  const wrongSha = recheckReceipt(root, receipt, { sha: git(root, 'rev-parse', 'master') });
  assert.equal(wrongSha.ok, false);
  assert.match(wrongSha.why, /names commit/);
});

test('importers_except cannot quiet a high risk importer: the change stays high risk', () => {
  const map = validateMap({
    checks: { full: { run: 'node ok.js' }, auth: { run: 'node ok.js', risk: 'sign-in' } },
    risk: { high: { 'sign-in': ['src/auth/**'] } },
    gates: { release: ['full'] },
    default: ['full'],
    importers_except: ['src/auth/**', 'src/App.tsx'],
  });
  const importers = new Map([['src/util.js', ['src/auth/login.js', 'src/App.tsx']]]);
  const picked = planChecks(map, ['src/util.js'], { importers });
  assert.equal(picked.tier, 'high');
  assert.deepEqual(picked.importers.map((file) => file.path), ['src/auth/login.js'], 'the plain entry file is still excepted');
  assert.ok(picked.selected.some((entry) => entry.key === 'auth'));
});

test('a test that drops its launches: app line in the same change still goes to the no-screen lane', () => {
  const map = validateMap({ checks: { ui: { run: 'node {file}', each: ['tests/*.test.js'] } } });
  const now = { 'tests/app.test.js': "const x = 1;\n" };
  const before = { 'tests/app.test.js': '// launches: app\nconst x = 1;\n' };
  const picked = planChecks(map, ['tests/app.test.js'], {
    listFiles: () => Object.keys(now),
    readFile: (file) => now[file] || '',
    readBaseFile: (file) => before[file] || '',
  });
  assert.equal(picked.selected[0].where, 'no-screen');
});
