'use strict';

// atris check: rule-picked checks, one receipt, a change's own proof, and the
// push. Every case runs in a throwaway git repo (a local bare repo stands in
// for GitHub), with no network and nothing that opens a window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkCommand, isLocalCheck } = require('../commands/check');
const { planChecks, validateMap, globToRegExp } = require('../lib/check-plan');
const { checkSkippedHere } = require('../lib/task-proof');
const { CHECK_NEEDS_LANE_LINE } = require('../lib/check-receipt');
const { starterMap } = require('../lib/check-init');

const OK = "process.exit(0);\n";
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

function configure(root) {
  git(root, 'config', 'user.email', 'check@example.test');
  git(root, 'config', 'user.name', 'check test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', '/dev/null');
}

// A repo with an origin (a bare repo), master pushed, and a feature branch.
function project(t, { map, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=master', remote);
  git(dir, 'init', '--quiet', '--initial-branch=master', root);
  configure(root);
  git(root, 'remote', 'add', 'origin', remote);
  write(root, 'README.md', '# fixture\n');
  write(root, 'ok.js', OK);
  write(root, 'fail.js', FAIL);
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 1;\n};\n');
  write(root, 'proof.test.js', "const assert = require('assert');\nconst feature = require('./src/feature');\nassert.ok(feature() >= 1);\n");
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  if (map) write(root, 'atris/checks.json', JSON.stringify(map, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  git(root, 'push', '--quiet', 'origin', 'master');
  git(root, 'remote', 'set-head', 'origin', 'master');
  git(root, 'switch', '--quiet', '-c', 'feature');
  return { dir, root, remote };
}

function commit(root, message = 'change') {
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', message);
}

async function check(root, args, env = {}) {
  const lines = [];
  const saved = {};
  const all = { ATRIS_CHECK_PERSON: '1', ...env };
  for (const [key, value] of Object.entries(all)) { saved[key] = process.env[key]; process.env[key] = value; }
  try {
    const code = await checkCommand(args, { cwd: root, log: (line) => lines.push(String(line)) });
    return { code, out: lines.join('\n') };
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function receiptOf(root) {
  const dir = path.join(root, '.atris', 'receipts');
  const name = fs.readdirSync(dir).find((file) => file.startsWith('check-'));
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

const BASE_MAP = {
  checks: {
    lint: { run: 'node ok.js', always: true, seconds: 1 },
    feature: { run: 'node ok.js', when: ['src/**'] },
    docs: { run: 'node ok.js', when: ['docs/**'] },
    auth: { run: 'node ok.js', risk: 'sign-in' },
    full: { run: 'node ok.js' },
  },
  risk: { low: ['**/*.md', 'docs/**'], high: { 'sign-in': ['src/auth/**'] } },
  gates: { release: ['lint', 'full'] },
  default: ['full'],
};

const PROOF = ['--proof', 'node proof.test.js'];

// ------------------------------------------------------------ the rules

test('globs match whole paths, ** spans folders, {a,b} is either', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.js'));
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(globToRegExp('**/*.md').test('docs/a/b.md'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('backend/routers/auth*').test('backend/routers/auth_utils.py'));
  assert.ok(globToRegExp('x.{js,ts}').test('x.ts'));
});

test('a changed file picks the checks whose globs match it, plus the always set, and says why', () => {
  const picked = planChecks(validateMap(BASE_MAP), ['src/feature.js']);
  const names = picked.selected.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['feature', 'lint']);
  assert.deepEqual(picked.selected.find((entry) => entry.name === 'feature').reasons, ['path-match: src/feature.js']);
  assert.deepEqual(picked.selected.find((entry) => entry.name === 'lint').reasons, ['always']);
  assert.ok(picked.notPicked.includes('docs'));
});

test('a high risk file adds every check guarding that risk and the whole release gate', () => {
  const picked = planChecks(validateMap(BASE_MAP), ['src/auth/session.js']);
  const reasons = Object.fromEntries(picked.selected.map((entry) => [entry.name, entry.reasons]));
  assert.equal(picked.tier, 'high');
  assert.deepEqual(reasons.auth, ['high-risk: sign-in']);
  assert.ok(reasons.full.includes('release gate (high-risk: sign-in)'));
  assert.ok(reasons.lint.includes('always'));
});

test('a file no glob knows widens to the default set and is listed as unmapped', () => {
  const picked = planChecks(validateMap(BASE_MAP), ['weird/thing.bin']);
  assert.deepEqual(picked.unmapped, ['weird/thing.bin']);
  assert.deepEqual(picked.selected.find((entry) => entry.name === 'full').reasons, ['unmapped: weird/thing.bin']);
});

test('the map file, lockfiles and migrations are high risk in every project', () => {
  const map = validateMap(BASE_MAP);
  for (const file of ['atris/checks.json', 'package-lock.json', 'db/migrations/001.sql']) {
    assert.equal(planChecks(map, [file]).tier, 'high', file);
  }
});

test('a chained command, an unknown where or a gate naming nothing is a map error', () => {
  assert.throws(() => validateMap({ checks: { a: { run: 'node a.js && node b.js' } } }), /chains/);
  assert.throws(() => validateMap({ checks: { a: { run: 'node a.js', where: 'cloud' } } }), /where/);
  assert.throws(() => validateMap({ checks: { a: { run: 'node a.js' } }, gates: { release: ['b'] } }), /not a check/);
  assert.doesNotThrow(() => validateMap({ checks: { a: { run: "node -e 'a(); b()'" } } }));
});

test('needsElectron sends a check to the no-screen lane, whatever where says', () => {
  const map = validateMap({ checks: { app: { run: 'node ok.js', where: 'here', needsElectron: true, always: true, seconds: 1 } } });
  assert.equal(map.checks.app.where, 'no-screen');
});

// The exact failure of 2026-11-16: a sign-in fix passed three rounds of
// builders because a hand-picked list skipped the real pre-release gate.
test('backend: changing routers/auth_utils.py selects the whole fast gate and the release gate', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'check', 'atrisos-backend-checks.json'), 'utf8'));
  const map = validateMap(raw);
  const picked = planChecks(map, ['backend/routers/auth_utils.py']);
  const byName = Object.fromEntries(picked.selected.map((entry) => [entry.name, entry]));
  assert.equal(picked.tier, 'high');
  assert.ok(picked.highKinds.includes('sign-in'));
  assert.equal(byName['fast-gate'].run, 'bash backend/scripts/test_fast.sh');
  assert.ok(byName['fast-gate'].reasons.some((reason) => reason.startsWith('high-risk: sign-in')));
  assert.ok(byName['fast-gate'].reasons.some((reason) => reason.startsWith('release gate')));
  assert.equal(byName['fast-gate'].stage, 2, 'the gate runs after the quick first stage');
  for (const name of map.gates.release) assert.ok(byName[name], `release gate check ${name} picked`);
  // fast-gate is no longer always: a wording change does not run it.
  assert.ok(!planChecks(map, ['README.md']).selected.some((entry) => entry.name === 'fast-gate'));
});

test('a changed helper picks the checks of the files that import it', (t) => {
  const { root } = project(t, {
    map: { checks: { lint: { run: 'node ok.js', always: true, seconds: 1 }, feature: { run: 'node ok.js', when: ['src/feature.js'] } } },
    files: { 'lib/util.js': 'module.exports = 1;\n', 'src/feature.js': "const util = require('../lib/util');\nmodule.exports = function feature() {\n  return util;\n};\n" },
  });
  return (async () => {
    write(root, 'lib/util.js', 'module.exports = 2;\n');
    const { out } = await check(root, ['--explain']);
    assert.match(out, /feature\s+<- import-match: src\/feature\.js imports lib\/util\.js/);
  })();
});

test('importers_except: an entry file that imports everything is not counted as an importer', () => {
  const map = validateMap({ checks: { root: { run: 'node ok.js', when: ['src/App.tsx'] } }, importers_except: ['src/App.tsx'] });
  const picked = planChecks(map, ['src/screen.tsx'], { importers: new Map([['src/screen.tsx', ['src/App.tsx']]]) });
  assert.equal(picked.selected.length, 0);
  const counted = planChecks(validateMap({ checks: { root: { run: 'node ok.js', when: ['src/App.tsx'] } } }), ['src/screen.tsx'], { importers: new Map([['src/screen.tsx', ['src/App.tsx']]]) });
  assert.deepEqual(counted.selected[0].reasons, ['import-match: src/App.tsx imports src/screen.tsx']);
});

test('python imports count too: a changed module picks its importer\'s checks', () => {
  const { pySpecifiers } = require('../lib/check-imports');
  assert.ok(pySpecifiers('from routers.auth_utils import get_user\nimport os\n').includes('routers.auth_utils'));
});

// ------------------------------------------------------------ running and the receipt

test('proven: exit 0, every picked check passed, the proof passed, one receipt', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, PROOF);
  assert.equal(result.code, 0, result.out);
  const receipt = receiptOf(root);
  assert.equal(receipt.verdict, 'proven');
  assert.equal(receipt.proof.status, 'passed');
  assert.match(receipt.proof.changed_line_coverage, /^[1-9]\d*\/\d+$/);
  assert.equal(receipt.pushable, false, 'uncommitted code is never pushable');
  assert.equal(receipt.checks.find((row) => row.name === 'docs').status, 'skipped-by-rule');
});

test('failed: exit 1 when a picked check fails', async (t) => {
  const map = { ...BASE_MAP, checks: { ...BASE_MAP.checks, feature: { run: 'node fail.js', when: ['src/**'] } } };
  const { root } = project(t, { map });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, PROOF);
  assert.equal(result.code, 1);
  assert.equal(receiptOf(root).verdict, 'failed');
});

test('a skip is never a pass: a no-screen check needs the lane, exit 3, never proven', async (t) => {
  const map = { ...BASE_MAP, checks: { ...BASE_MAP.checks, app: { run: 'node ok.js', where: 'no-screen', when: ['src/**'] } } };
  const { root } = project(t, { map });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, PROOF);
  assert.equal(result.code, 3);
  assert.ok(result.out.includes(CHECK_NEEDS_LANE_LINE));
  const receipt = receiptOf(root);
  assert.equal(receipt.verdict, 'partly');
  assert.equal(receipt.checks.find((row) => row.name === 'app').status, 'needs-lane');
  assert.ok(!fs.existsSync(path.join(root, 'ran-app')));
});

test('a check that skips itself (prints the skip line, exits 0) is needs-lane, not passed', async (t) => {
  const skip = "console.log('test-x skipped on this Mac: opens the app; runs in the no-screen lane');\n";
  const map = { ...BASE_MAP, checks: { ...BASE_MAP.checks, feature: { run: 'node skip.js', when: ['src/**'] } } };
  const { root } = project(t, { map, files: { 'skip.js': skip } });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, PROOF);
  assert.equal(result.code, 3);
  assert.equal(receiptOf(root).checks.find((row) => row.name === 'feature').status, 'needs-lane');
});

test('paid checks never run without --allow-paid', async (t) => {
  const map = { ...BASE_MAP, checks: { ...BASE_MAP.checks, model: { run: 'node touch.js', where: 'paid', when: ['src/**'] } } };
  const { root } = project(t, { map, files: { 'touch.js': "require('fs').writeFileSync('ran-paid', '');\n" } });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, PROOF);
  assert.equal(result.code, 3);
  assert.ok(!fs.existsSync(path.join(root, 'ran-paid')));
});

test("the no-screen lane refuses to run on a person's machine", async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  const result = await check(root, ['--lane', 'no-screen']);
  assert.equal(result.code, 2);
});

test('a receipt cannot be reused once the code changes', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  assert.equal((await check(root, PROOF)).code, 0);
  const file = path.join(root, '.atris', 'receipts', fs.readdirSync(path.join(root, '.atris', 'receipts')).find((name) => name.startsWith('check-')));
  assert.equal((await check(root, ['--verify', '--receipt', file])).code, 0);
  commit(root, 'same code, now committed');
  assert.equal((await check(root, ['--verify', '--receipt', file])).code, 0, 'committing the same code keeps the receipt valid');
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 3;\n};\n');
  const after = await check(root, ['--verify', '--receipt', file]);
  assert.equal(after.code, 1);
  assert.match(after.out, /different code/);
});

test('a receipt cannot be reused after an edit in the same Git timestamp tick', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  const source = path.join(root, 'src/feature.js');
  const tick = new Date('2020-01-01T00:00:00Z');
  git(root, 'config', 'core.trustctime', 'false');
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  fs.utimesSync(source, tick, tick);
  const checked = await check(root, PROOF);
  assert.equal(checked.code, 0, checked.out);
  const file = path.join(root, '.atris', 'receipts', `check-${git(root, 'rev-parse', 'HEAD').slice(0, 12)}.json`);
  commit(root);
  const before = await check(root, ['--verify', '--receipt', file]);
  assert.equal(before.code, 0, before.out);

  const index = path.resolve(root, git(root, 'rev-parse', '--git-path', 'index'));
  fs.utimesSync(index, tick, tick);
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 3;\n};\n');
  fs.utimesSync(source, tick, tick);
  assert.equal(git(root, '--no-optional-locks', 'diff', '--name-only'), 'src/feature.js');

  const after = await check(root, ['--verify', '--receipt', file]);
  assert.equal(after.code, 1, after.out);
  assert.match(after.out, /different code/);
});

test('a receipt made from a hand-picked --files list never verifies', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  await check(root, ['--files', 'src/feature.js', ...PROOF]);
  const result = await check(root, ['--verify']);
  assert.equal(result.code, 1);
  assert.match(result.out, /hand-picked/);
});

test('--explain runs nothing and writes no receipt', async (t) => {
  const map = { checks: { lint: { run: 'node touch.js', always: true, seconds: 1 } } };
  const { root } = project(t, { map, files: { 'touch.js': "require('fs').writeFileSync('ran', '');\n" } });
  write(root, 'src/feature.js', 'module.exports = 3;\n');
  const result = await check(root, ['--explain']);
  assert.equal(result.code, 0);
  assert.match(result.out, /run here\s+lint\s+<- always/);
  assert.ok(!fs.existsSync(path.join(root, 'ran')));
  assert.ok(!fs.existsSync(path.join(root, '.atris', 'receipts')));
});

test('usage and map errors exit 2; a project with no map is told to run init', async (t) => {
  const { root } = project(t, {});
  const none = await check(root, []);
  assert.equal(none.code, 2);
  assert.match(none.out, /no atris\/checks\.json/);
  write(root, 'atris/checks.json', '{ not json');
  assert.equal((await check(root, [])).code, 2);
  assert.equal((await check(root, ['--lane', 'moon'])).code, 2);
});

test('a project with no map is untouched: mission ids still go to the cloud check, stray exit 3 is a failure', () => {
  assert.equal(isLocalCheck(['run_123']), false);
  assert.equal(isLocalCheck(['run_123', '--json']), false);
  assert.equal(isLocalCheck([]), true);
  assert.equal(isLocalCheck(['--explain']), true);
  assert.equal(checkSkippedHere({ status: 3, stdout: 'something else' }), false);
  assert.equal(checkSkippedHere({ status: 3, stdout: `${CHECK_NEEDS_LANE_LINE}. 2 passed here` }), true);
  assert.equal(checkSkippedHere({ status: 0, stdout: CHECK_NEEDS_LANE_LINE }), false);
});

// ------------------------------------------------------------ the cage

test('the cage kills a hung check and its whole process group, and keeps windows shut', async (t) => {
  const hang = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "require('fs').writeFileSync('grandchild.pid', String(child.pid));",
    "require('fs').writeFileSync('env.json', JSON.stringify({ CI: process.env.CI, BROWSER: process.env.BROWSER, ERAN: process.env.ELECTRON_RUN_AS_NODE, ALLOW: process.env.OBELISK_ALLOW_APP_LAUNCH || null }));",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const map = { checks: { hang: { run: 'node hang.js', always: true, seconds: 1, timeout_seconds: 1 } } };
  const { root } = project(t, { map, files: { 'hang.js': hang } });
  write(root, 'README.md', 'docs only\n');
  const result = await check(root, [], { OBELISK_ALLOW_APP_LAUNCH: '1' });
  assert.equal(result.code, 1);
  assert.match(receiptOf(root).checks[0].note, /timed out/);
  const pid = Number(fs.readFileSync(path.join(root, 'grandchild.pid'), 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pid, 0), 'the grandchild is gone too');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'env.json'), 'utf8')), { CI: '1', BROWSER: 'none', ERAN: '1', ALLOW: null });
});

// ------------------------------------------------------------ the proof

test('no proof for a normal change: never proven, said plainly', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, []);
  assert.equal(result.code, 1);
  assert.match(result.out, /no proof for this change/);
});

test('a docs change needs no proof', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  write(root, 'README.md', '# better words\n');
  const result = await check(root, []);
  assert.equal(result.code, 0, result.out);
  assert.equal(receiptOf(root).proof.status, 'exempt');
});

test('a proof that never runs a changed line is flagged', async (t) => {
  const files = {
    'src/feature.js': 'function feature() {\n  return 1;\n}\nfunction other() {\n  return 1;\n}\nmodule.exports = { feature, other };\n',
    'proof.test.js': "const assert = require('assert');\nconst { feature } = require('./src/feature');\nassert.equal(feature(), 1);\n",
  };
  const { root } = project(t, { map: BASE_MAP, files });
  write(root, 'src/feature.js', files['src/feature.js'].replace('function other() {\n  return 1;', 'function other() {\n  return 2;'));
  const result = await check(root, PROOF);
  assert.equal(result.code, 1);
  assert.match(receiptOf(root).proof.why, /without running a single changed line/);
  assert.equal(receiptOf(root).proof.changed_line_coverage, '0/1');
});

test('a proof test with no assertion, or that mocks what it proves, is flagged', async (t) => {
  const { root } = project(t, { map: BASE_MAP, files: { 'empty.test.js': "require('./src/feature');\n", 'mock.test.js': "jest.mock('./src/feature');\nexpect(1).toBe(1);\n" } });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const empty = await check(root, ['--proof', 'node empty.test.js']);
  assert.equal(empty.code, 1);
  assert.match(receiptOf(root).proof.why, /no assertion/);
  const mocked = await check(root, ['--proof', 'node mock.test.js']);
  assert.equal(mocked.code, 1);
  assert.match(receiptOf(root).proof.why, /mocks src\/feature\.js/);
});

test('a proof about other code is not proof of this change', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, ['--proof', 'node ok.js']);
  assert.equal(result.code, 1);
  assert.match(receiptOf(root).proof.why, /neither runs a changed file nor names one/);
});

test('a commit Proof: line is the proof, and it travels with the change', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  commit(root, 'Feature returns two\n\nProof: node proof.test.js');
  const result = await check(root, []);
  assert.equal(result.code, 0, result.out);
  assert.equal(receiptOf(root).proof.source, 'commit Proof: line');
});

test('--deep: the proof must fail on the base code and pass here', async (t) => {
  const files = { 'deep.test.js': "const assert = require('assert');\nassert.equal(require('./src/feature')(), 2);\n" };
  const { root } = project(t, { map: BASE_MAP, files });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const strong = await check(root, ['--proof', 'node deep.test.js', '--deep']);
  assert.equal(strong.code, 0, strong.out);
  assert.match(receiptOf(root).proof.deep, /fails on the base code/);
  const weak = await check(root, ['--proof', 'node proof.test.js', '--deep']);
  assert.equal(weak.code, 1);
  assert.match(receiptOf(root).proof.why, /also passes on the base code/);
});

// ------------------------------------------------------------ keys

test('the key scan fails the change and never prints the key', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  const key = ['sk', 'ant', 'api03', 'Zx9'.repeat(10)].join('-');
  write(root, 'docs/setup.md', `use this: ${key}\n`);
  const result = await check(root, ['--json']);
  assert.equal(result.code, 1);
  assert.ok(!result.out.includes(key), 'not in the output');
  const raw = fs.readFileSync(path.join(root, '.atris', 'receipts', fs.readdirSync(path.join(root, '.atris', 'receipts')).find((name) => name.startsWith('check-'))), 'utf8');
  assert.ok(!raw.includes(key), 'not in the receipt');
  assert.match(receiptOf(root).secret_scan.why, /docs\/setup\.md:1 \(anthropic key\)/);
});

// ------------------------------------------------------------ init

test('init names only checks that exist, marks each to confirm, and reads launch and spend markers', (t) => {
  const { root } = project(t, {
    files: {
      'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'node scripts/lint.js', build: 'vite build', 'test:app': 'node scripts/test-app.mjs' } }),
      'scripts/lint.js': '// spends: nothing (reads files)\n',
      'scripts/test-app.mjs': '// launches: app\n',
      'scripts/test-model.mjs': '// spends: model calls\n',
    },
  });
  const { map, notes } = starterMap(root);
  assert.deepEqual(Object.keys(map.checks).sort(), ['lint', 'test', 'test-app', 'tests']);
  assert.equal(map.checks.tests.select, 'node-test');
  assert.equal(map.checks.tests.fallback, 'test');
  assert.ok(!Object.values(map.checks).some((check) => check.always), 'init never writes always: it cannot know how long a check takes');
  assert.equal(map.checks['test-app'].where, 'no-screen');
  assert.equal(map.checks.lint.where, 'here');
  for (const check of Object.values(map.checks)) assert.ok(check.confirm);
  assert.ok(!JSON.stringify(map).includes('vite build'), 'build is not a check');
  assert.ok(notes.some((note) => /open the app or spend money/.test(note)));
  assert.doesNotThrow(() => validateMap(map));
});

test('init writes nothing when the project has no checks to start from', async (t) => {
  const { root } = project(t, {});
  fs.rmSync(path.join(root, 'proof.test.js'));
  const result = await check(root, ['init']);
  assert.equal(result.code, 2);
  assert.ok(!fs.existsSync(path.join(root, 'atris', 'checks.json')));
});

// ------------------------------------------------------------ push, stage, land

function otherClone(t, remote, dir) {
  const other = path.join(dir, `other-${Math.random().toString(36).slice(2)}`);
  git(dir, 'clone', '--quiet', remote, other);
  configure(other);
  return other;
}

function remoteSha(remote, ref) {
  return git(remote, 'rev-parse', ref);
}

const PUSH_MAP = { ...BASE_MAP, push: { max_files: 5, max_lines: 200 } };

test('push: a large proven change prints a command that lands it', async (t) => {
  const { root, remote, dir } = project(t, { map: PUSH_MAP });
  write(root, 'src/feature.js', 'module.exports = function feature() { return 2; };\n');
  for (let i = 0; i < 5; i += 1) write(root, `src/extra${i}.js`, `module.exports = ${i};\n`);
  commit(root, 'Large change\n\nProof: node proof.test.js');
  const sha = git(root, 'rev-parse', 'HEAD');
  const result = await check(root, ['push']);
  assert.equal(result.code, 3, result.out);
  assert.match(result.out, /staged: waits for the no-screen lane/);
  const command = `ATRIS_CHECK_PERSON=0 atris check land ${sha.slice(0, 12)} --lane no-screen`;
  assert.ok(result.out.split('\n').includes(`no runner on this project? land it with: ${command}`), result.out);
  const runner = otherClone(t, remote, dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.resolve(__dirname, '../bin/atris.js'), path.join(bin, 'atris'));
  const landed = spawnSync(command, { cwd: runner, shell: true, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.equal(remoteSha(remote, 'master'), sha);
});

test('push: a change waiting for a lane does not suggest a local landing command', async (t) => {
  const map = { ...PUSH_MAP, checks: { ...PUSH_MAP.checks, app: { run: 'node ok.js', where: 'no-screen', when: ['src/**'] } }, push: { ...PUSH_MAP.push, lane_status: 'echo success' } };
  const { root, remote, before, result } = await stagedCase(t, { map, change: (repo) => write(repo, 'src/feature.js', 'module.exports = function feature() { return 2; };\n') });
  assert.equal(result.code, 3, result.out);
  assert.ok(receiptOf(root).checks.some((row) => row.status === 'needs-lane'));
  assert.match(result.out, /staged: waits for the no-screen lane/);
  assert.doesNotMatch(result.out, /no runner on this project\? land it with:/);
  assert.equal(remoteSha(remote, 'master'), before);
});

test('push: first update on the latest default branch, then check that exact code, then push it', async (t) => {
  const { root, remote, dir } = project(t, { map: PUSH_MAP });
  const other = otherClone(t, remote, dir);
  write(other, 'docs/other.md', 'someone else\n');
  commit(other, 'other work');
  git(other, 'push', '--quiet', 'origin', 'master');
  const moved = remoteSha(remote, 'master');
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  commit(root, 'Feature two\n\nProof: node proof.test.js');
  const result = await check(root, ['push']);
  assert.equal(result.code, 0, result.out);
  const receipt = receiptOf(root);
  assert.equal(receipt.merge_base, moved, 'checked on top of the moved default branch');
  assert.equal(git(remote, 'rev-parse', 'master^{tree}'), receipt.tree, 'the pushed code is the checked code');
  assert.match(result.out, /yes\s+small/);
});

test('push refuses uncommitted code', async (t) => {
  const { root } = project(t, { map: PUSH_MAP });
  write(root, 'src/feature.js', 'module.exports = 5;\n');
  assert.equal((await check(root, ['--push'])).code, 2);
});

test('push is compare and swap: when the default branch moves mid-check it updates, re-checks and retries', async (t) => {
  // The always check pushes one commit to the default branch from another
  // clone the first time it runs, so the first push loses the race.
  const racer = [
    "const fs = require('fs'); const { execFileSync } = require('child_process');",
    'const other = process.env.RACE_OTHER; const flag = process.env.RACE_FLAG;',
    'if (other && !fs.existsSync(flag)) {',
    "  fs.writeFileSync(flag, '');",
    "  fs.writeFileSync(other + '/docs/race.md', 'raced\\n');",
    "  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'race'], ['push', '-q', 'origin', 'master']]) execFileSync('git', args, { cwd: other });",
    '}',
  ].join('\n');
  const map = { ...PUSH_MAP, checks: { ...PUSH_MAP.checks, lint: { run: 'node racer.js', always: true, seconds: 1 } } };
  const { root, remote, dir } = project(t, { map, files: { 'racer.js': racer, 'docs/.keep': '' } });
  const other = otherClone(t, remote, dir);
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  commit(root, 'Feature two\n\nProof: node proof.test.js');
  const result = await check(root, ['push'], { RACE_OTHER: other, RACE_FLAG: path.join(dir, 'raced') });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /moved while checking \(try 1 of 3\)/);
  assert.match(result.out, /also checking the 1 file\(s\) its new commits changed/);
  const log = git(remote, 'log', '--format=%s', 'master');
  assert.match(log, /race/);
  assert.match(log, /Feature two/);
});

async function stagedCase(t, { map = PUSH_MAP, files = {}, change }) {
  const { root, remote } = project(t, { map, files });
  const before = remoteSha(remote, 'master');
  change(root);
  commit(root, 'Change\n\nProof: node proof.test.js');
  const result = await check(root, ['push']);
  return { root, remote, before, result };
}

const conditionCases = [
  ['high risk', {
    change: (root) => { write(root, 'src/auth/session.js', "require('../feature');\nmodule.exports = 1;\n"); write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n'); },
    label: /no \s+no high risk path/,
  }],
  ['a check skipped itself', {
    map: { ...PUSH_MAP, checks: { ...PUSH_MAP.checks, feature: { run: 'node skip.js', when: ['src/**'] } } },
    files: { 'skip.js': "console.log('x skipped on this Mac: opens the app; runs in the no-screen lane');\n" },
    change: (root) => write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n'),
    label: /no \s+every check that may run here passed/,
  }],
  ['too big', {
    change: (root) => { write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n'); for (let i = 0; i < 6; i += 1) write(root, `src/extra${i}.js`, `module.exports = ${i};\n`); },
    label: /no \s+small/,
  }],
  ['the lane is red', {
    map: { ...PUSH_MAP, checks: { ...PUSH_MAP.checks, app: { run: 'node ok.js', where: 'no-screen', when: ['nothing/**'] } }, push: { lane_status: 'echo failure' } },
    change: (root) => write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n'),
    label: /no \s+the default branch's lane is not red \(red/,
  }],
  ['a no-screen check was picked', {
    map: { ...PUSH_MAP, checks: { ...PUSH_MAP.checks, app: { run: 'node ok.js', where: 'no-screen', when: ['src/**'] } }, push: { lane_status: 'echo success' } },
    change: (root) => write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n'),
    label: /no \s+no check waits for another lane/,
  }],
];

for (const [name, spec] of conditionCases) {
  test(`push: ${name} stages the change instead of pushing it to the default branch`, async (t) => {
    const { remote, before, result } = await stagedCase(t, spec);
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /staged: waits for the no-screen lane/);
    assert.match(result.out, spec.label);
    assert.equal(remoteSha(remote, 'master'), before, 'the default branch did not move');
    assert.match(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/atris/ready/'), /refs\/heads\/atris\/ready\/[0-9a-f]{12}/);
  });
}

test('land: a runner runs the rest and fast-forwards on green, then removes the staged ref', async (t) => {
  const map = { ...PUSH_MAP, checks: { ...PUSH_MAP.checks, app: { run: 'node ok.js', where: 'no-screen', when: ['src/**'] } } };
  const { root, remote, dir } = project(t, { map });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  commit(root, 'Feature two\n\nProof: node proof.test.js');
  assert.equal((await check(root, ['push'])).code, 3);
  const sha = git(root, 'rev-parse', 'HEAD').slice(0, 12);
  const runner = otherClone(t, remote, dir);
  const landed = await check(runner, ['land', sha], { ATRIS_CHECK_PERSON: '0' });
  assert.equal(landed.code, 0, landed.out);
  assert.equal(remoteSha(remote, 'master').slice(0, 12), sha);
  assert.equal(git(remote, 'for-each-ref', 'refs/heads/atris/ready/'), '');
});

test('land: on red the default branch stays and the staged ref is left, naming what failed', async (t) => {
  const map = { ...PUSH_MAP, checks: { ...PUSH_MAP.checks, app: { run: 'node fail.js', where: 'no-screen', when: ['src/**'] } } };
  const { root, remote, dir } = project(t, { map });
  const before = remoteSha(remote, 'master');
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  commit(root, 'Feature two\n\nProof: node proof.test.js');
  assert.equal((await check(root, ['push'])).code, 3);
  const sha = git(root, 'rev-parse', 'HEAD').slice(0, 12);
  const runner = otherClone(t, remote, dir);
  const result = await check(runner, ['land', sha], { ATRIS_CHECK_PERSON: '0' });
  assert.equal(result.code, 1);
  assert.match(result.out, /failed: app/);
  assert.equal(remoteSha(remote, 'master'), before);
  assert.match(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/atris/ready/'), new RegExp(sha));
});

test("land refuses a person's machine", async (t) => {
  const { root } = project(t, { map: PUSH_MAP });
  assert.equal((await check(root, ['land', 'abcdef123456'])).code, 2);
});

// ------------------------------------------------------------ storage

const { pruneReceipts } = require('../lib/check-receipt');
const { sweepStaleDeepCopies } = require('../lib/check-proof');

test('receipts: newest 200, nothing past 14 days, never one a staged ref still waits on', (t) => {
  const { root } = project(t, { map: BASE_MAP });
  const dir = path.join(root, '.atris', 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/heads/atris/ready/waiting', head);
  const now = Date.now();
  for (let i = 0; i < 205; i += 1) {
    const file = path.join(dir, `check-${String(i).padStart(12, '0')}.json`);
    fs.writeFileSync(file, JSON.stringify({ kind: 'atris.check.v1', head_sha: `x${i}` }));
    const when = new Date(now - i * 60000);
    fs.utimesSync(file, when, when);
  }
  const old = path.join(dir, 'check-old000000000.json');
  fs.writeFileSync(old, JSON.stringify({ kind: 'atris.check.v1', head_sha: 'old' }));
  const staged = path.join(dir, 'check-staged000000.json');
  fs.writeFileSync(staged, JSON.stringify({ kind: 'atris.check.v1', head_sha: head }));
  const longAgo = new Date(now - 20 * 24 * 3600 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  fs.utimesSync(staged, longAgo, longAgo);
  pruneReceipts(root, { now });
  const left = fs.readdirSync(dir).filter((name) => name.startsWith('check-'));
  assert.equal(left.length, 201, 'the newest 200 plus the staged one');
  assert.ok(left.includes('check-staged000000.json'));
  assert.ok(!left.includes('check-old000000000.json'));
});

test('a receipt keeps no logs: 40 lines of a failed check, nothing for passed ones', async (t) => {
  const noisy = "for (let i = 0; i < 100; i += 1) console.log('line ' + i); process.exit(1);\n";
  const map = { ...BASE_MAP, checks: { ...BASE_MAP.checks, feature: { run: 'node noisy.js', when: ['src/**'] } } };
  const { root } = project(t, { map, files: { 'noisy.js': noisy } });
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, PROOF);
  const receipt = receiptOf(root);
  const failed = receipt.checks.find((row) => row.name === 'feature');
  assert.equal(failed.output_tail.split('\n').length, 40);
  assert.match(failed.output_tail, /line 99$/);
  assert.equal(receipt.checks.find((row) => row.name === 'lint').output_tail, undefined);
  assert.match(result.out, /^storage: receipts \d+ (?:B|KB), cache \d+ (?:B|KB)$/m);
});

test('the import cache is one file under 5 MB; a bigger one is thrown away and rebuilt', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  const cache = path.join(root, '.atris', 'cache', 'check-imports.json');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ version: 1, specs: { junk: ['x'.repeat(6 * 1024 * 1024)] } }));
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  await check(root, ['--explain']);
  assert.ok(fs.statSync(cache).size < 64 * 1024, 'rebuilt small');
  assert.deepEqual(fs.readdirSync(path.dirname(cache)).sort(), ['.gitignore', 'check-imports.json']);
});

test('--deep leaves no copy behind, and a crash-left one older than an hour goes on the next run', async (t) => {
  const files = { 'deep.test.js': "const assert = require('assert');\nassert.equal(require('./src/feature')(), 2);\n" };
  const { root } = project(t, { map: BASE_MAP, files });
  const stale = path.join(os.tmpdir(), `atris-check-deep-crashed-${process.pid}`);
  fs.mkdirSync(stale, { recursive: true });
  const hourAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stale, hourAgo, hourAgo);
  const fresh = path.join(os.tmpdir(), `atris-check-deep-running-${process.pid}`);
  fs.mkdirSync(fresh, { recursive: true });
  t.after(() => fs.rmSync(fresh, { recursive: true, force: true }));
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  const result = await check(root, ['--proof', 'node deep.test.js', '--deep']);
  assert.equal(result.code, 0, result.out);
  assert.equal(fs.existsSync(stale), false, 'the crash-left copy is gone');
  assert.ok(fs.existsSync(fresh), 'a young one (maybe another run) stays');
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1, 'no worktree left registered');
  assert.equal(sweepStaleDeepCopies(root), 0);
});

test('init adds the receipts and cache folders to .gitignore when git does not ignore them yet', (t) => {
  const { root } = project(t, { files: { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) } });
  return (async () => {
    assert.equal((await check(root, ['init'])).code, 0);
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /\.atris\/receipts\//);
    assert.match(ignore, /\.atris\/cache\//);
  })();
});

test('sweep: a staged ref older than 7 days already on the default branch goes; one not on it is listed and kept', async (t) => {
  const { root, remote } = project(t, { map: PUSH_MAP });
  const old = { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() };
  git(root, 'switch', '--quiet', 'master');
  write(root, 'docs/landed.md', 'landed long ago\n');
  git(root, 'add', '-A');
  spawnSync('git', ['commit', '--quiet', '-m', 'old landed work'], { cwd: root, env: old });
  git(root, 'push', '--quiet', 'origin', 'master');
  git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/atris/ready/landed00000');
  write(root, 'docs/young.md', 'landed today\n');
  commit(root, 'young landed work');
  git(root, 'push', '--quiet', 'origin', 'master');
  git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/atris/ready/young000000');
  git(root, 'switch', '--quiet', 'feature');
  write(root, 'src/feature.js', 'module.exports = 9;\n');
  git(root, 'add', '-A');
  spawnSync('git', ['commit', '--quiet', '-m', 'old waiting work'], { cwd: root, env: old });
  git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/atris/ready/waiting0000');
  const result = await check(root, ['sweep']);
  assert.equal(result.code, 0, result.out);
  const refs = git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/atris/ready/');
  assert.doesNotMatch(refs, /landed00000/, 'old and landed: removed');
  assert.match(refs, /young000000/, 'landed but younger than 7 days: kept');
  assert.match(refs, /waiting0000/, 'never deleted when it did not land');
  assert.match(result.out, /removed 1 staged ref/);
  assert.match(result.out, /waiting, not on master: atris\/ready\/waiting0000 \(10 days old\)/);
  assert.match(result.out, /^storage: /m);
});

// ------------------------------------------------------------ CodeOps fixes red

function fakeAtris(t, dir) {
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(dir, 'atris-calls.log');
  fs.writeFileSync(path.join(bin, 'atris'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(calls)}\necho COMMIT=abc123 PUSHED=fix-branch\n`);
  fs.chmodSync(path.join(bin, 'atris'), 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, calls };
}

async function failedProject(t) {
  const map = { ...BASE_MAP, checks: { ...BASE_MAP.checks, feature: { run: 'node fail.js', when: ['src/**'] } } };
  const made = project(t, { map });
  // A GitHub name for origin, while pushes still go to the local bare repo.
  git(made.root, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
  git(made.root, 'config', `url.${made.remote}.insteadOf`, 'https://github.com/acme/app.git');
  write(made.root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  commit(made.root, 'Feature two\n\nProof: node proof.test.js');
  assert.equal((await check(made.root, [])).code, 1);
  return made;
}

test('fix --dry-run prints the exact command and task and sends nothing', async (t) => {
  const { root, dir } = await failedProject(t);
  const fake = fakeAtris(t, dir);
  const result = await check(root, ['fix', '--dry-run'], { PATH: fake.PATH });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /wakes a cloud computer \(costs a little\)/);
  assert.match(result.out, /^\)"; atris computer pr acme\/app "\$TASK" --business atris-codeops --base feature$/m);
  assert.ok(!result.out.includes(root), 'no folder of this machine goes into the cloud task');
  assert.match(result.out, /1\. feature: `node fail\.js` \(exit 1\)/);
  assert.match(result.out, /Never weaken, skip or delete a check/);
  assert.match(result.out, /dry run: nothing was sent/);
  assert.equal(fs.existsSync(fake.calls), false, 'nothing dispatched');
});

test('fix hands one job per receipt to CodeOps, pushing the branch first', async (t) => {
  const { root, dir, remote } = await failedProject(t);
  const fake = fakeAtris(t, dir);
  const first = await check(root, ['fix'], { PATH: fake.PATH });
  assert.equal(first.code, 0, first.out);
  const args = fs.readFileSync(fake.calls, 'utf8').split('\n');
  assert.deepEqual(args.slice(0, 3), ['computer', 'pr', 'acme/app']);
  assert.ok(args.includes('--business') && args.includes('atris-codeops') && args.includes('--base') && args.includes('feature'));
  assert.equal(git(remote, 'rev-parse', 'feature'), git(root, 'rev-parse', 'HEAD'), 'the failed branch is on GitHub for CodeOps');
  const second = await check(root, ['fix'], { PATH: fake.PATH });
  assert.equal(second.code, 2);
  assert.match(second.out, /one fix job per receipt/);
  await check(root, []);
  const third = await check(root, ['fix'], { PATH: fake.PATH });
  assert.equal(third.code, 2, 'checking the same code again does not open a second job');
  assert.equal(fs.readFileSync(fake.calls, 'utf8').split('\n').filter((line) => line === 'computer').length, 1);
});

test('fix refuses a receipt that did not fail', async (t) => {
  const { root } = project(t, { map: BASE_MAP });
  write(root, 'README.md', '# words\n');
  await check(root, []);
  const file = path.join(root, '.atris', 'receipts', fs.readdirSync(path.join(root, '.atris', 'receipts')).find((name) => name.startsWith('check-')));
  assert.equal((await check(root, ['fix', '--receipt', file, '--dry-run'])).code, 2);
});
