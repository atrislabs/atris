'use strict';

// The hourly lander takes a change only with an atris check receipt it can
// work out again, in projects whose default branch has atris/checks.json.
// Every case is a throwaway repo; the lander's own checks run the real
// `atris check` with ATRIS_CHECK_PERSON=1, so nothing opens and no lane runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landStaleGreenBranches } = require('../lib/land-green');
const { storeReceipt, refFor } = require('../lib/check-receipt-ref');
const { receiptGateSetting } = require('../lib/land-receipt-gate');

const ATRIS = path.join(__dirname, '..', 'bin', 'atris.js');
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function commitAll(cwd, message, when = daysAgo(3)) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  return git(cwd, ['rev-parse', 'HEAD']);
}

// count.js appends one line to $LAND_COUNT, so a test can tell whether the
// lander ran a check itself. It fails when $LAND_FAIL is set.
const COUNT = "const fs = require('fs'); if (process.env.LAND_COUNT) fs.appendFileSync(process.env.LAND_COUNT, 'ran\\n'); process.exit(process.env.LAND_FAIL ? 1 : 0);\n";

const MAP = {
  checks: {
    lint: { run: 'node count.js', always: true, seconds: 1 },
    feature: { run: 'node count.js', when: ['src/**'], seconds: 1 },
    charge: { run: 'node count.js', risk: 'money', seconds: 1 },
    full: { run: 'node count.js', seconds: 1 },
  },
  risk: { low: ['**/*.md'], high: { money: ['src/billing/**'] } },
  gates: { release: ['lint', 'full'] },
  default: ['full'],
};

function makeRepo(t, { map = MAP } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-receipt-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-receipt-scratch-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); });
  git(root, ['init', '-q', '-b', 'master']);
  for (const [key, value] of [['user.name', 'Bench Author'], ['user.email', 'bench@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(root, ['config', key, value]);
  write(root, 'package.json', JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test: 'node count.js' } }));
  write(root, 'count.js', COUNT);
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 1;\n};\n');
  write(root, 'src/billing/charge.js', 'module.exports = function charge() {\n  return 1;\n};\n');
  write(root, 'proof.test.js', "const assert = require('assert');\nassert.ok(require('./src/feature')() >= 1);\nassert.ok(require('./src/billing/charge')() >= 1);\n");
  write(root, '.gitignore', '.atris/\n');
  if (map) write(root, 'atris/checks.json', JSON.stringify(map, null, 2));
  commitAll(root, 'base', daysAgo(10));
  return { root, scratch, count: path.join(scratch, 'count.log') };
}

function branch(root, name, files, message) {
  git(root, ['checkout', '-q', '-b', name]);
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  const sha = commitAll(root, message || `${name} work\n\nProof: node proof.test.js`);
  git(root, ['checkout', '-q', 'master']);
  return sha;
}

// The receipt a worker's atris check --push would leave as a ref.
function workerReceipt(root, name, edit = null) {
  git(root, ['checkout', '-q', name]);
  try {
    const run = spawnSync(process.execPath, [ATRIS, 'check'], { cwd: root, encoding: 'utf8', env: { ...process.env, ATRIS_CHECK_PERSON: '1', ATRIS_SKIP_UPDATE_CHECK: '1' } });
    const sha = git(root, ['rev-parse', 'HEAD']);
    const file = path.join(root, '.atris', 'receipts', `check-${sha.slice(0, 12)}.json`);
    assert.ok(fs.existsSync(file), run.stdout + run.stderr);
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (edit) edit(receipt);
    assert.equal(storeReceipt(root, receipt).ok, true);
    fs.rmSync(path.join(root, '.atris', 'receipts'), { recursive: true, force: true });
    return receipt;
  } finally {
    git(root, ['checkout', '-q', 'master']);
  }
}

function land(repo, opts = {}) {
  const { env: extraEnv, ...rest } = opts;
  return landStaleGreenBranches(repo.root, {
    push: true,
    openFlags: false,
    handBack: false,
    mergePath: 'push',
    stateFile: null,
    scratchDir: repo.scratch,
    runVerifyFn: () => ({ status: 0, failing: [], command: 'node count.js', duration_ms: 1, timed_out: false, tail: '' }),
    env: { ...process.env, LAND_COUNT: repo.count, ...(extraEnv || {}) },
    ...rest,
  });
}

const runs = (repo) => (fs.existsSync(repo.count) ? fs.readFileSync(repo.count, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const onMaster = (root, sha) => spawnSync('git', ['merge-base', '--is-ancestor', sha, 'master'], { cwd: root }).status === 0;
const FEATURE_TWO = { 'src/feature.js': 'module.exports = function feature() {\n  return 2;\n};\n' };

test('a valid receipt from atris check --push lands, and the lander does not run the checks again', (t) => {
  const repo = makeRepo(t);
  const sha = branch(repo.root, 'member/valid', FEATURE_TWO);
  workerReceipt(repo.root, 'member/valid');
  const result = land(repo);
  const verdict = result.verdicts.find((v) => v.branch === 'member/valid');
  assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
  assert.equal(verdict.check_receipt.source, 'this repo');
  assert.equal(verdict.check_receipt.tier, 'normal');
  assert.equal(runs(repo), 0, 'no check ran in the lander');
  assert.ok(onMaster(repo.root, sha));
});

test('a forged receipt (hand-edited verdict) is refused with the reason and does not land', (t) => {
  const repo = makeRepo(t);
  const sha = branch(repo.root, 'member/forged', FEATURE_TWO);
  workerReceipt(repo.root, 'member/forged', (r) => {
    const row = r.checks.find((entry) => entry.name === 'feature');
    Object.assign(row, { status: 'failed', exit_code: 1 });
    r.verdict = 'proven';
  });
  const result = land(repo);
  const verdict = result.verdicts.find((v) => v.branch === 'member/forged');
  assert.equal(verdict.action, 'skipped');
  assert.equal(verdict.reason, 'receipt_refused');
  assert.match(verdict.detail, /the receipt says proven, but its own rows make it failed/);
  assert.equal(runs(repo), 0, 'a refused receipt is not checked again on trust');
  assert.ok(!onMaster(repo.root, sha));
});

test('a receipt that omits a check the plan picks is refused', (t) => {
  const repo = makeRepo(t);
  branch(repo.root, 'member/omits', FEATURE_TWO);
  workerReceipt(repo.root, 'member/omits', (r) => { r.checks = r.checks.filter((row) => row.name !== 'feature'); });
  const verdict = land(repo).verdicts.find((v) => v.branch === 'member/omits');
  assert.equal(verdict.reason, 'receipt_refused');
  assert.match(verdict.detail, /leaves out feature/);
});

test('a receipt for another commit (sha mismatch) is refused', (t) => {
  const repo = makeRepo(t);
  const sha = branch(repo.root, 'member/moved', FEATURE_TWO);
  const receipt = workerReceipt(repo.root, 'member/moved');
  // The branch gets one more commit; the old receipt is stored under the new sha.
  git(repo.root, ['checkout', '-q', 'member/moved']);
  write(repo.root, 'src/feature.js', 'module.exports = function feature() {\n  return 3;\n};\n');
  const next = commitAll(repo.root, 'more\n\nProof: node proof.test.js');
  git(repo.root, ['checkout', '-q', 'master']);
  git(repo.root, ['update-ref', refFor(next), git(repo.root, ['rev-parse', refFor(sha)])]);
  assert.equal(receipt.head_sha, sha);
  const verdict = land(repo).verdicts.find((v) => v.branch === 'member/moved');
  assert.equal(verdict.reason, 'receipt_refused');
  assert.match(verdict.detail, /names commit [0-9a-f]{12}, but the change is commit/);
});

test('a change that edits the map in the same change is checked by the default branch map and is high risk', (t) => {
  const repo = makeRepo(t);
  const loose = { ...MAP, checks: { ...MAP.checks, feature: { run: 'node -e "process.exit(0)"', when: ['src/**'], seconds: 1 } } };
  branch(repo.root, 'member/map', { ...FEATURE_TWO, 'atris/checks.json': JSON.stringify(loose, null, 2) });
  // The worker's receipt, rewritten as if its own looser map decided.
  workerReceipt(repo.root, 'member/map', (r) => {
    r.map_blob = git(repo.root, ['rev-parse', 'member/map:atris/checks.json']);
    r.risk_tier = 'normal';
  });
  const verdict = land(repo).verdicts.find((v) => v.branch === 'member/map');
  assert.equal(verdict.reason, 'receipt_refused');
  assert.match(verdict.detail, /made with a different map/);
});

test('a high risk change with a valid receipt is checked again by the lander, and a failure there holds it', (t) => {
  const repo = makeRepo(t);
  const sha = branch(repo.root, 'member/money', { 'src/billing/charge.js': 'module.exports = function charge() {\n  return 2;\n};\n' });
  const receipt = workerReceipt(repo.root, 'member/money');
  assert.equal(receipt.risk_tier, 'high');
  assert.equal(receipt.verdict, 'proven');
  // The checks fail now: the receipt's "passed" rows are not believed.
  const held = land(repo, { env: { LAND_FAIL: '1' } }).verdicts.find((v) => v.branch === 'member/money');
  assert.equal(held.reason, 'check_failed', JSON.stringify(held));
  assert.match(held.detail, /high risk, so the lander runs the checks itself, and it failed/);
  assert.ok(runs(repo) > 0, 'the lander ran the checks');
  assert.ok(!onMaster(repo.root, sha));
});

test('a high risk change whose checks pass when the lander runs them lands', (t) => {
  const repo = makeRepo(t);
  const sha = branch(repo.root, 'member/money-ok', { 'src/billing/charge.js': 'module.exports = function charge() {\n  return 2;\n};\n' });
  workerReceipt(repo.root, 'member/money-ok');
  const verdict = land(repo).verdicts.find((v) => v.branch === 'member/money-ok');
  assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
  assert.equal(verdict.check_receipt.source, 'the lander, rerun for high risk');
  assert.ok(runs(repo) > 0);
  assert.ok(onMaster(repo.root, sha));
});

test('a branch with no receipt is checked by the lander itself, and lands only when proven', (t) => {
  const repo = makeRepo(t);
  const good = branch(repo.root, 'member/old-good', FEATURE_TWO);
  const result = land(repo);
  const verdict = result.verdicts.find((v) => v.branch === 'member/old-good');
  assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
  assert.equal(verdict.check_receipt.source, 'the lander');
  assert.equal(verdict.check_ran, true);
  assert.ok(runs(repo) > 0);
  assert.ok(onMaster(repo.root, good));
});

test('a branch with no receipt and no proof waits with a plain reason, never lands on trust', (t) => {
  const repo = makeRepo(t);
  const sha = branch(repo.root, 'member/no-proof', FEATURE_TWO, 'no proof line here');
  const verdict = land(repo).verdicts.find((v) => v.branch === 'member/no-proof');
  assert.equal(verdict.reason, 'check_failed', JSON.stringify(verdict));
  assert.match(verdict.detail, /no proof for this change/);
  assert.ok(!onMaster(repo.root, sha));
});

test('a no-screen check is never run by the lander and never a pass: the change waits for the lane', (t) => {
  const map = { ...MAP, checks: { ...MAP.checks, app: { run: 'node count.js', where: 'no-screen', when: ['src/**'] } } };
  const repo = makeRepo(t, { map });
  const sha = branch(repo.root, 'member/app', FEATURE_TWO);
  const verdict = land(repo).verdicts.find((v) => v.branch === 'member/app');
  assert.equal(verdict.reason, 'needs_lane', JSON.stringify(verdict));
  assert.match(verdict.detail, /^app must run in the no-screen or paid lane/);
  assert.ok(!onMaster(repo.root, sha));
});

test('a candidate the lander cannot check in its time waits, untried, for the next run', (t) => {
  const repo = makeRepo(t);
  const sha = branch(repo.root, 'member/slow', FEATURE_TWO);
  const verdict = land(repo, { checkSeconds: 1 }).verdicts.find((v) => v.branch === 'member/slow');
  assert.equal(verdict.reason, 'check_budget', JSON.stringify(verdict));
  assert.match(verdict.detail, /checked next run/);
  assert.equal(runs(repo), 0);
  assert.ok(!onMaster(repo.root, sha));
});

test('a project without a map lands exactly as before: no receipt asked, no check run', (t) => {
  const repo = makeRepo(t, { map: null });
  const sha = branch(repo.root, 'member/plain', FEATURE_TWO, 'plain work');
  const verdict = land(repo).verdicts.find((v) => v.branch === 'member/plain');
  assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
  assert.equal(verdict.check_receipt, undefined);
  assert.equal(runs(repo), 0);
  assert.ok(onMaster(repo.root, sha));
});

test('the off switch: ATRIS_LAND_RECEIPTS=0 or the policy key lands a forged receipt as before', (t) => {
  assert.equal(receiptGateSetting({}, {}), true);
  assert.equal(receiptGateSetting({ green_landing_receipts: false }, {}), false);
  assert.equal(receiptGateSetting({}, { ATRIS_LAND_RECEIPTS: '0' }), false);
  assert.equal(receiptGateSetting({ green_landing_receipts: true }, { ATRIS_LAND_RECEIPTS: 'off' }), false);
  const repo = makeRepo(t);
  const sha = branch(repo.root, 'member/forged-off', FEATURE_TWO, 'no proof, and a forged receipt');
  workerReceipt(repo.root, 'member/forged-off', (r) => { r.verdict = 'proven'; });
  const verdict = land(repo, { env: { ATRIS_LAND_RECEIPTS: '0' } }).verdicts.find((v) => v.branch === 'member/forged-off');
  assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
  assert.equal(verdict.check_receipt, undefined);
  assert.ok(onMaster(repo.root, sha));
  const byPolicy = makeRepo(t);
  branch(byPolicy.root, 'member/policy-off', FEATURE_TWO, 'no proof');
  assert.equal(land(byPolicy, { receipts: false }).verdicts.find((v) => v.branch === 'member/policy-off').action, 'landed');
});
