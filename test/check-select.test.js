'use strict';

// atris check v1.1: test selection inside a check, risk tiers, the time
// budget and replay. Every case runs in a throwaway git repo, with no network
// and nothing that opens a window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkCommand } = require('../commands/check');
const { planChecks, validateMap, lintMap } = require('../lib/check-plan');
const { planOptions } = require('../lib/check-context');
const { commentsOnly } = require('../lib/check-comments');
const { pySpecifiers, buildGraph } = require('../lib/check-imports');
const { starterMap } = require('../lib/check-init');
const budget = require('../lib/check-budget');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

const OK = 'process.exit(0);\n';

// A repo with a node app, a python package and their tests.
const FILES = {
  'README.md': '# fixture\n',
  'ok.js': OK,
  'fail.js': "console.log('broken'); process.exit(1);\n",
  'slow.js': 'setTimeout(() => process.exit(0), 1200);\n',
  'src/lib/modelCatalog.js': "module.exports = { pickModelForLane: () => 'fast' };\n",
  'src/lib/helper.js': "const catalog = require('./modelCatalog');\nmodule.exports = () => catalog.pickModelForLane();\n",
  'src/lib/lonely.js': 'module.exports = 3;\n',
  'src/screen.js': "const helper = require('./lib/helper');\nmodule.exports = helper;\n",
  'src/auth/session.js': 'module.exports = 1;\n',
  'scripts/test-model-catalog.mjs': "import assert from 'node:assert';\nassert.ok(true);\n",
  'scripts/test-helper-direct.mjs': "import helper from '../src/lib/helper.js';\nimport assert from 'node:assert';\nassert.ok(helper);\n",
  'scripts/test-screen.mjs': "import screen from '../src/screen.js';\nimport assert from 'node:assert';\nassert.ok(screen);\n",
  'scripts/test-lane-pick.mjs': "// reads pickModelForLane by name\nimport assert from 'node:assert';\nassert.ok('pickModelForLane');\n",
  'scripts/test-app-window.mjs': "// launches: app\nimport assert from 'node:assert';\nassert.ok(true);\n",
  'backend/services/billing_math.py': 'def total(a, b):\n    return a + b\n',
  'backend/services/report_card.py': 'from services import billing_math\n\nVALUE = billing_math.total(1, 2)\n',
  'backend/services/quiet.py': 'X = 1\n',
  'backend/tests/test_report_card.py': 'from services.report_card import VALUE\n\ndef test_value():\n    assert VALUE == 3\n',
  'backend/tests/test_uses_paren.py': 'from services import (\n    report_card,\n)\n\ndef test_it():\n    assert report_card\n',
  'backend/tests/test_mock_path.py': "def test_it(monkeypatch):\n    monkeypatch.setattr('services.quiet.X', 2)\n    assert True\n",
};

const MAP = {
  checks: {
    keys: { run: 'node ok.js', always: true, tier: 'low', seconds: 1 },
    'node-tests': { select: 'node-test', roots: ['scripts'], when: ['src/**', 'scripts/**'], run: 'node {file}', fallback: 'full', seconds: 1 },
    'py-tests': { select: 'pytest', roots: ['backend/tests'], when: ['backend/**'], cwd: 'backend', run: 'node ../ok.js {files}', fallback: 'full', seconds: 1 },
    full: { run: 'node ok.js', tier: 'high', seconds: 3 },
    auth: { run: 'node ok.js', risk: 'sign-in', seconds: 1 },
  },
  risk: { low: ['**/*.md', 'docs/**'], high: { 'sign-in': ['src/auth/**'] } },
  gates: { release: ['full'] },
  default: ['node-tests'],
  owners: { 'src/lib/lonely.js': ['scripts/test-screen.mjs'] },
};

function project(t, { map = MAP, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-select-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=master', remote);
  git(dir, 'init', '--quiet', '--initial-branch=master', root);
  for (const [key, value] of [['user.email', 'check@example.test'], ['user.name', 'check test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(root, 'config', key, value);
  git(root, 'remote', 'add', 'origin', remote);
  for (const [file, text] of Object.entries({ ...FILES, ...files })) write(root, file, text);
  write(root, 'atris/checks.json', JSON.stringify(map, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  git(root, 'push', '--quiet', 'origin', 'master');
  git(root, 'remote', 'set-head', 'origin', 'master');
  git(root, 'switch', '--quiet', '-c', 'feature');
  return { dir, root, remote };
}

function planFor(root, files, map = MAP) {
  const valid = validateMap(map);
  return planChecks(valid, files, planOptions(root, valid, files, { base: 'HEAD', writeCache: false, probe: false }));
}

async function check(root, args, env = {}) {
  const lines = [];
  const saved = {};
  for (const [key, value] of Object.entries({ ATRIS_CHECK_PERSON: '1', ...env })) { saved[key] = process.env[key]; process.env[key] = value; }
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

function testsOf(picked, name) {
  return Object.fromEntries((picked.selections[name] ? picked.selections[name].tests : []).map((entry) => [entry.file, entry.reasons]));
}

// ------------------------------------------------------------ selection and reasons

test('a selector picks tests with a reason each: changed, imports (direct and one hop), named-for, owner', (t) => {
  const { root } = project(t);
  const picked = planFor(root, ['src/lib/modelCatalog.js', 'scripts/test-screen.mjs']);
  const tests = testsOf(picked, 'node-tests');
  assert.deepEqual(tests['scripts/test-screen.mjs'], ['changed']);
  assert.ok(tests['scripts/test-helper-direct.mjs'].includes('imports: src/lib/modelCatalog.js (via src/lib/helper.js)'));
  assert.ok(tests['scripts/test-model-catalog.mjs'].includes('named-for: src/lib/modelCatalog.js'), 'kebab-case test name');
  assert.ok(tests['scripts/test-lane-pick.mjs'].includes('named-for: src/lib/modelCatalog.js (mentions pickModelForLane)'), 'an exported name');
  assert.equal(picked.tier, 'normal');
  assert.ok(!picked.selected.some((entry) => entry.name === 'full'), 'a normal change never runs the full gate here');
  const owned = testsOf(planFor(root, ['src/lib/lonely.js']), 'node-tests');
  assert.deepEqual(owned['scripts/test-screen.mjs'], ['owner: src/lib/lonely.js']);
});

test('python: package imports, from x import (y) over lines, one hop, and module paths in text all count', (t) => {
  const { root } = project(t);
  assert.ok(pySpecifiers('from services import (\n    report_card,\n    other,  # why\n)\n').includes('services.report_card'));
  assert.ok(pySpecifiers('import services.quiet as q\n').includes('services.quiet'));
  const tests = testsOf(planFor(root, ['backend/services/billing_math.py']), 'py-tests');
  assert.ok(tests['backend/tests/test_report_card.py'].includes('imports: backend/services/billing_math.py (via backend/services/report_card.py)'));
  const direct = testsOf(planFor(root, ['backend/services/report_card.py']), 'py-tests');
  assert.ok(direct['backend/tests/test_uses_paren.py'].includes('imports: backend/services/report_card.py'));
  assert.ok(direct['backend/tests/test_report_card.py'].includes('named-for: backend/services/report_card.py'));
  const mocked = testsOf(planFor(root, ['backend/services/quiet.py']), 'py-tests');
  assert.ok(mocked['backend/tests/test_mock_path.py'].includes('named-for: backend/services/quiet.py (mentions services.quiet)'));
});

test('tsconfig paths: an alias import resolves to its file', (t) => {
  const { root } = project(t, {
    files: {
      'tsconfig.json': '{\n  // comments are fine\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"], "contract": ["./src/lib/lonely.js"] } },\n}\n',
      'src/uses-alias.ts': "import lonely from 'contract';\nimport helper from '@lib/helper';\nexport default [lonely, helper];\n",
    },
  });
  const graph = buildGraph(root, { writeCache: false });
  assert.deepEqual(graph.importersOf('src/lib/lonely.js'), ['src/uses-alias.ts']);
  assert.ok(graph.importersOf('src/lib/helper.js').includes('src/uses-alias.ts'));
});

test('zero coverage is a finding: no test covers the file, so the selector widens to its fallback', async (t) => {
  const { root } = project(t);
  const picked = planFor(root, ['backend/services/quiet.py', 'src/lib/nobody.js'].slice(1));
  assert.deepEqual(picked.uncovered, ['src/lib/nobody.js']);
  assert.equal(picked.selections['node-tests'].mode, 'fallback');
  assert.ok(picked.selected.find((entry) => entry.name === 'full').reasons.some((reason) => reason.startsWith('fallback for node-tests: no test covers src/lib/nobody.js')));
  write(root, 'src/lib/nobody.js', 'module.exports = 9;\n');
  const { out } = await check(root, ['--explain']);
  assert.match(out, /no test covers src\/lib\/nobody\.js/);
});

test('more than max picked tests is a big blast radius: the fallback runs instead', (t) => {
  const map = JSON.parse(JSON.stringify(MAP));
  map.checks['node-tests'].max = 2;
  const { root } = project(t, { map });
  const picked = planFor(root, ['src/lib/modelCatalog.js'], map);
  assert.equal(picked.selections['node-tests'].mode, 'fallback');
  assert.match(picked.selections['node-tests'].why, /more than the max of 2/);
  assert.ok(picked.selected.some((entry) => entry.name === 'full'));
});

test('a selected test marked launches: app is never run here: needs the lane, never a pass', async (t) => {
  const { root } = project(t);
  write(root, 'scripts/test-app-window.mjs', "// launches: app\nimport assert from 'node:assert';\nassert.ok(1);\n");
  const result = await check(root, ['--proof', 'node scripts/test-app-window.mjs']);
  const row = receiptOf(root).checks.find((entry) => entry.name === 'node-tests scripts/test-app-window.mjs');
  assert.equal(row.status, 'needs-lane');
  assert.notEqual(result.code, 0);
});

test('{files} runs once, relative to the check cwd, with the check env', async (t) => {
  const map = JSON.parse(JSON.stringify(MAP));
  map.checks['py-tests'].run = 'node ../args.js {files}';
  map.checks['py-tests'].env = { ATRIS_SELECT_PROBE: 'yes', CI: 'no' };
  const { root } = project(t, {
    map,
    files: { 'args.js': "const fs = require('fs');\nif (process.env.ATRIS_SELECT_PROBE !== 'yes' || process.env.CI !== '1') process.exit(4);\nfor (const f of process.argv.slice(2)) if (!fs.existsSync(f)) process.exit(5);\nprocess.exit(process.argv.length > 2 ? 0 : 6);\n" },
  });
  write(root, 'backend/services/report_card.py', 'from services import billing_math\n\nVALUE = billing_math.total(1, 2) + 0\n');
  await check(root, ['--proof', 'node ok.js backend/services/report_card.py']);
  const row = receiptOf(root).checks.find((entry) => entry.name === 'py-tests');
  assert.equal(row.status, 'passed', JSON.stringify(row));
  assert.ok(row.tests.length >= 2);
  assert.match(row.run, /tests\/test_report_card\.py/);
});

// ------------------------------------------------------------ tiers

test('low: a wording change runs only low tier checks, never the gate, and needs no proof', async (t) => {
  const { root } = project(t);
  write(root, 'README.md', '# fixture, reworded\n');
  const result = await check(root, []);
  assert.equal(result.code, 0, result.out);
  const receipt = receiptOf(root);
  assert.equal(receipt.risk_tier, 'low');
  assert.deepEqual(receipt.checks.filter((row) => row.status === 'passed').map((row) => row.name), ['keys']);
  assert.equal(receipt.tier_target_seconds, 5);
});

test('low: a comments-only edit to a .py or .js file is low, unless the path is high risk', (t) => {
  const { root } = project(t);
  write(root, 'backend/services/billing_math.py', '# adds two numbers\ndef total(a, b):\n    return a + b  \n');
  write(root, 'src/lib/helper.js', "// helper, now with a comment\nconst catalog = require('./modelCatalog');\nmodule.exports = () => catalog.pickModelForLane();\n");
  write(root, 'src/auth/session.js', '// only a comment\nmodule.exports = 1;\n');
  const low = planFor(root, ['backend/services/billing_math.py', 'src/lib/helper.js']);
  assert.equal(low.tier, 'low');
  assert.ok(low.lowWhy.every((file) => file.why === 'comments or whitespace only'));
  assert.ok(!low.selected.some((entry) => entry.name === 'full'));
  assert.equal(planFor(root, ['src/auth/session.js']).tier, 'high');
  write(root, 'src/lib/helper.js', "const catalog = require('./modelCatalog');\nmodule.exports = () => catalog.pickModelForLane() + 1;\n");
  assert.equal(planFor(root, ['src/lib/helper.js']).tier, 'normal');
});

test('comments-only detection says no when unsure: strings, regexes, indentation, trailing comments', () => {
  assert.equal(commentsOnly('a.py', 'x = 1\n', '# note\nx = 1\n'), true);
  assert.equal(commentsOnly('a.py', 's = "# a"\n', 's = "# b"\n'), false);
  assert.equal(commentsOnly('a.py', 'if a:\n    x = 1\n', 'if a:\n  x = 1\n'), false);
  assert.equal(commentsOnly('a.py', 'x = 1  # a\n', 'x = 1  # b\n'), false);
  assert.equal(commentsOnly('a.ts', 'const r = /a\\/\\/b/;\n', 'const r = /a\\/\\/c/;\n'), false);
  assert.equal(commentsOnly('a.ts', 'const s = `a ${b}`;\n', '/* why */\nconst s = `a ${b}`;\n'), true);
  assert.equal(commentsOnly('a.ts', 'const s = `a ${b}`;\n', 'const s = `a ${c}`;\n'), false);
  assert.equal(commentsOnly('a.ts', 'return\nx\n', 'return x\n'), false);
  assert.equal(commentsOnly('a.json', '{}', '{ }'), false);
  assert.equal(commentsOnly('a.py', 'x = 1\n', null), false);
});

test('low: a tests-only change runs the changed tests and nothing wider', (t) => {
  const { root } = project(t);
  const picked = planFor(root, ['scripts/test-screen.mjs']);
  assert.equal(picked.tier, 'low');
  assert.deepEqual(picked.selected.map((entry) => entry.key).sort(), ['keys', 'node-tests scripts/test-screen.mjs']);
});

test('high: selected tests and quick checks first, then the release gate; a red first stage stops the gate', async (t) => {
  const map = JSON.parse(JSON.stringify(MAP));
  map.checks.full.run = 'node ok.js';
  map.owners = { 'src/auth/**': ['scripts/test-fails.mjs'] };
  const { root } = project(t, { map, files: { 'scripts/test-fails.mjs': "process.exit(1);\n" } });
  const picked = planFor(root, ['src/auth/session.js'], map);
  const stage = Object.fromEntries(picked.selected.map((entry) => [entry.key, entry.stage]));
  assert.equal(stage['node-tests scripts/test-fails.mjs'], 1);
  assert.equal(stage.full, 2);
  write(root, 'src/auth/session.js', 'module.exports = 2;\n');
  const result = await check(root, ['--proof', 'node ok.js src/auth/session.js']);
  assert.equal(result.code, 1, result.out);
  const receipt = receiptOf(root);
  assert.equal(receipt.checks.find((row) => row.name === 'full').status, 'not-run');
  assert.equal(receipt.verdict, 'failed');
});

// ------------------------------------------------------------ the map lint

test('a slow always is refused, with a clear message, by the map lint and at the start of every check', async (t) => {
  const slow = { checks: { gate: { run: 'node ok.js', always: true, seconds: 120 } } };
  assert.throws(() => validateMap(slow), /always is only for checks of 5s or less/);
  assert.throws(() => validateMap({ checks: { gate: { run: 'node ok.js', always: true } } }), /says no "seconds"/);
  assert.deepEqual(lintMap({ checks: { gate: { run: 'node ok.js', always: true, seconds: 2 } } }).errors, []);
  assert.throws(() => validateMap({ checks: { s: { select: 'pytest', roots: ['tests'], run: 'pytest' } } }), /needs \{files\}/);
  assert.throws(() => validateMap({ checks: { s: { select: 'pytest', roots: ['tests'], run: 'pytest {files}' } } }), /no "fallback"/);
  const { root } = project(t, { map: slow });
  const lint = await check(root, ['--lint-map']);
  assert.equal(lint.code, 2);
  assert.match(lint.out, /refused {2}check "gate" is always but takes about 120s/);
  const run = await check(root, []);
  assert.equal(run.code, 2);
  assert.match(run.out, /the map was refused, so nothing ran/);
});

test('init writes a map the lint accepts: selectors with a fallback, no always', (t) => {
  const { root } = project(t, { files: { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'backend/pytest.ini': '[pytest]\n' } });
  const { map } = starterMap(root);
  assert.deepEqual(lintMap(map).errors, []);
  assert.equal(map.checks['py-tests'].fallback, 'pytest');
  assert.equal(map.checks.tests.fallback, 'test');
});

// ------------------------------------------------------------ the budget

test('every receipt has expected and actual seconds; going over the target names the check that blew it', async (t) => {
  const map = JSON.parse(JSON.stringify(MAP));
  map.budget = { normal: 1 };
  map.checks.slow = { run: 'node slow.js', when: ['src/**'], seconds: 1 };
  const { root } = project(t, { map });
  write(root, 'src/lib/modelCatalog.js', "module.exports = { pickModelForLane: () => 'slow' };\n");
  const first = await check(root, ['--proof', 'node ok.js src/lib/modelCatalog.js']);
  const receipt = receiptOf(root);
  assert.ok(receipt.actual_seconds > 1, first.out);
  assert.equal(receipt.over_budget.target_seconds, 1);
  assert.equal(receipt.over_budget.check, 'slow');
  assert.match(first.out, /over budget: .* slow took/);
  assert.ok(receipt.checks.find((row) => row.name === 'slow').expected_seconds === 1);
  const history = budget.loadDurations(root);
  assert.ok(history.slow.s[0] >= 1, 'the real time is recorded');
  const { out } = await check(root, ['--explain']);
  assert.match(out, /slow {2}<- path-match: src\/lib\/modelCatalog\.js[^\n]* {2}~1\.\ds\n/, 'the next estimate is the measured time');
  assert.match(out, /target 1s for a normal risk change/);
});

test('the duration cache keeps a few samples per check and the estimate is their median', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-durations-'));
  try {
    for (const seconds of [10, 2, 3, 4, 3, 50, 3, 3, 3, 3, 3]) budget.recordDurations(dir, [{ key: 'gate', seconds }]);
    const history = budget.loadDurations(dir);
    assert.equal(history.gate.s.length, 9);
    assert.equal(budget.estimate({ key: 'gate', seconds: 120 }, history).seconds, 3);
    assert.equal(budget.estimate({ key: 'new', seconds: 7 }, history).seconds, 7);
    assert.equal(budget.estimate({ key: 'tests', seconds: 20, selectedCount: 4, perTestSeconds: 1 }, {}).seconds, 24);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ replay

test('replay: one row per recent first-parent commit with tier, tests, seconds and push or stage, plus the spread', async (t) => {
  const { root } = project(t);
  const land = (file, text, message) => {
    git(root, 'switch', '--quiet', 'master');
    git(root, 'switch', '--quiet', '-c', `b-${Math.random().toString(36).slice(2)}`);
    write(root, file, text);
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', message);
    const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(root, 'switch', '--quiet', 'master');
    git(root, 'merge', '--quiet', '--no-ff', '-m', `Merge ${message}`, branch);
  };
  land('src/lib/modelCatalog.js', "module.exports = { pickModelForLane: () => 'x' };\n", 'catalog');
  land('docs/a.md', 'docs\n', 'docs only');
  land('src/auth/session.js', 'module.exports = 5;\n', 'auth');
  land('src/lib/nobody.js', 'module.exports = 1;\n', 'no tests');
  git(root, 'push', '--quiet', 'origin', 'master');
  const before = git(root, 'status', '--porcelain');
  const result = await check(root, ['replay', '--last', '3', '--json']);
  assert.equal(result.code, 0, result.out);
  const data = JSON.parse(result.out);
  assert.equal(data.rows.length, 3);
  assert.equal(data.summary.skipped_docs_only, 1);
  const [nobody, auth, catalog] = data.rows;
  assert.equal(catalog.tier, 'normal');
  assert.ok(catalog.selected_tests >= 3);
  assert.equal(catalog.would, 'push');
  assert.equal(auth.tier, 'high');
  assert.equal(auth.would, 'stage');
  assert.deepEqual(nobody.uncovered, ['src/lib/nobody.js']);
  assert.equal(nobody.fallback, true);
  for (const row of data.rows) for (const key of ['sha', 'tier', 'selected_tests', 'expected_seconds', 'would']) assert.ok(key in row, key);
  for (const key of ['median_seconds', 'p90_seconds', 'share_percent']) assert.ok(key in data.summary.tiers.normal, key);
  assert.deepEqual(auth.uncovered, ['src/auth/session.js'], 'high risk with no test is still a gap worth seeing');
  assert.equal(data.summary.zero_cover_percent, 67);
  assert.equal(git(root, 'status', '--porcelain'), before, 'replay changes nothing in the checkout');
  const text = await check(root, ['replay', '--last', '3']);
  assert.match(text.out, /normal +2 commits \(67%\) {2}median/);
  // Each row and the summary say where their times came from, so a replay on a
  // fresh machine is not read as measured.
  for (const row of data.rows) assert.equal(typeof row.times_from.measured, 'number');
  const from = data.summary.times_from;
  const total = from.measured + from.map + from.default + from.unknown;
  assert.ok(total > 0);
  assert.match(text.out, new RegExp(`times: ${from.measured} of ${total} check runs measured on this machine, ${from.map} from the map's seconds`));
  if (!from.measured) assert.match(text.out, /none are measured, so read these as the map's numbers/);
});

test('one hop does not go through a hub many tests import, but does go through a shared test fixture', (t) => {
  const files = { 'src/hub.js': "const helper = require('./lib/helper');\nmodule.exports = helper;\n", 'scripts/fixtures-shared.mjs': '' };
  for (let i = 0; i < 9; i += 1) files[`scripts/test-hub-${i}.mjs`] = "import hub from '../src/hub.js';\nimport assert from 'node:assert';\nassert.ok(hub);\n";
  files['scripts/test-shared-base.mjs'] = "import helper from '../src/lib/helper.js';\nexport const base = helper;\n";
  for (let i = 0; i < 9; i += 1) files[`scripts/test-uses-base-${i}.mjs`] = "import { base } from './test-shared-base.mjs';\nimport assert from 'node:assert';\nassert.ok(base);\n";
  const { root } = project(t, { files });
  const picked = planFor(root, ['src/lib/helper.js']);
  const sel = picked.selections['node-tests'];
  assert.ok(sel.hubs.some((hub) => hub.file === 'src/hub.js' && hub.tests === 9), JSON.stringify(sel.hubs));
  assert.ok(!sel.tests.some((test) => test.file.startsWith('scripts/test-hub-')));
  assert.ok(sel.tests.some((test) => test.file === 'scripts/test-uses-base-3.mjs'), 'a test fixture module is followed');
});

test('a broad file is matched by the names the change touches, not by its file name', (t) => {
  const map = JSON.parse(JSON.stringify(MAP));
  map.broad = ['src/big.js'];
  const { root } = project(t, {
    map,
    files: {
      'src/big.js': 'function renderSidebarPanel() {\n  return 1;\n}\n\nfunction otherThingHere() {\n  return 2;\n}\n',
      'scripts/test-sidebar.mjs': "// slices renderSidebarPanel out of src/big.js\nimport assert from 'node:assert';\nassert.ok(1);\n",
      'scripts/test-big-file.mjs': "// reads src/big.js whole\nimport assert from 'node:assert';\nassert.ok(1);\n",
    },
  });
  write(root, 'src/big.js', 'function renderSidebarPanel() {\n  return 3;\n}\n\nfunction otherThingHere() {\n  return 2;\n}\n');
  const tests = testsOf(planFor(root, ['src/big.js'], map), 'node-tests');
  assert.deepEqual(tests['scripts/test-sidebar.mjs'], ['named-for: src/big.js (changes renderSidebarPanel)']);
  assert.ok(!tests['scripts/test-big-file.mjs'], 'naming the broad file is not enough');
  write(root, 'src/big.js', 'function renderSidebarPanel() {\n  return 1;\n}\n\nfunction otherThingHere() {\n  return 4;\n}\n');
  const other = planFor(root, ['src/big.js'], map);
  assert.deepEqual(other.uncovered, ['src/big.js']);
});

test('a feature part a split module loads by a string counts as imported by it, and the module is not a hub in front of it', (t) => {
  const files = {
    'backend/utils/feature_parts.py': 'def run(namespace, relpath):\n    pass\n',
    'backend/services/scanner.py': 'X = 1\n__import__("utils.feature_parts", fromlist=["run"]).run(globals(), "scanner_features/core/core.py")\n',
    'backend/services/scanner_features/core/core.py': 'def scan():\n    return 1\n',
    // Not inside the module's own _features folder: never followed.
    'backend/services/other_features/x.py': 'Y = 1\n',
  };
  for (let i = 0; i < 9; i += 1) files[`backend/tests/test_scan_${i}.py`] = 'from services import scanner\n\ndef test_it():\n    assert scanner.X\n';
  const { root } = project(t, { files });
  write(root, 'backend/services/scanner_features/core/core.py', 'def scan():\n    return 2\n');
  const picked = planFor(root, ['backend/services/scanner_features/core/core.py']);
  const sel = picked.selections['py-tests'];
  assert.equal(sel.mode, 'tests', JSON.stringify(sel));
  assert.equal(sel.tests.length, 9, 'all nine tests of the module run the part');
  assert.match(sel.tests[0].reasons[0], /imports: backend\/services\/scanner_features\/core\/core\.py \(via backend\/services\/scanner\.py\)/);
  assert.deepEqual(sel.hubs, []);
  const graph = buildGraph(root, { writeCache: false });
  assert.deepEqual(graph.importersOf('backend/services/scanner_features/core/core.py'), ['backend/services/scanner.py']);
  assert.deepEqual(graph.importersOf('backend/services/other_features/x.py'), []);
  assert.deepEqual(pySpecifiers('import os\n'), ['os'], 'a module without feature_parts gets no part edges');
});

test('cheapest first: the key scan, then quick checks, then the tests, then the full gate; the first failure stops the rest', async (t) => {
  const map = JSON.parse(JSON.stringify(MAP));
  map.checks.lint = { run: 'node fail.js', when: ['src/**'], seconds: 1 };
  const { root } = project(t, { map });
  const picked = planFor(root, ['src/lib/modelCatalog.js'], map);
  const stage = Object.fromEntries(picked.selected.map((entry) => [entry.key, entry.stage]));
  assert.equal(stage.lint, 0, 'a quick check goes first');
  assert.equal(stage['node-tests scripts/test-model-catalog.mjs'], 1, 'the selected tests come next');
  write(root, 'src/lib/modelCatalog.js', "module.exports = { pickModelForLane: () => 'slow' };\n");
  const failedLint = await check(root, ['--proof', 'node scripts/test-model-catalog.mjs']);
  assert.equal(failedLint.code, 1, failedLint.out);
  let receipt = receiptOf(root);
  const tests = receipt.checks.filter((row) => row.name.startsWith('node-tests '));
  assert.ok(tests.length > 0);
  for (const row of tests) {
    assert.equal(row.status, 'not-run');
    assert.equal(row.note, 'not run because lint failed');
  }
  assert.equal(receipt.proof.status, 'not-run');
  assert.equal(receipt.verdict, 'failed');
  // --verify never counts a check that did not run as a pass.
  const file = path.join(root, '.atris', 'receipts', fs.readdirSync(path.join(root, '.atris', 'receipts')).find((name) => name.startsWith('check-')));
  for (const row of receipt.checks) if (row.status === 'not-run' || row.status === 'failed') { row.status = 'passed'; row.exit_code = row.exit_code ?? null; }
  receipt.verdict = 'proven';
  fs.writeFileSync(file, JSON.stringify(receipt));
  const forged = await check(root, ['--verify']);
  assert.equal(forged.code, 1);
  // A key in the change stops everything before any check runs.
  fs.rmSync(path.join(root, '.atris', 'receipts'), { recursive: true, force: true });
  write(root, 'src/lib/modelCatalog.js', `module.exports = { key: '${'sk-ant-api03-'}${'a'.repeat(90)}' };\n`);
  const keyed = await check(root, ['--proof', 'node scripts/test-model-catalog.mjs']);
  assert.equal(keyed.code, 1, keyed.out);
  receipt = receiptOf(root);
  assert.equal(receipt.secret_scan.status, 'failed');
  assert.equal(receipt.checks.find((row) => row.name === 'lint').note, 'not run because the key scan failed');
});

test('every check is told its base and changed files, and the lint names a fallback with no seconds', async (t) => {
  const map = JSON.parse(JSON.stringify(MAP));
  map.checks.base = { run: 'node seebase.js', when: ['src/**'], seconds: 1 };
  const see = "const fs = require('fs');\nconst files = fs.readFileSync(process.env.ATRIS_CHECK_FILES, 'utf8').split('\\n').filter(Boolean);\nprocess.exit(process.env.ATRIS_CHECK_BASE && files.includes('src/lib/lonely.js') ? 0 : 1);\n";
  const { root } = project(t, { map, files: { 'seebase.js': see } });
  write(root, 'src/lib/lonely.js', 'module.exports = 4;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'lonely');
  await check(root, ['--base', 'HEAD~1', '--proof', 'node scripts/test-screen.mjs src/lib/lonely.js']);
  const row = receiptOf(root).checks.find((entry) => entry.name === 'base');
  assert.equal(row.status, 'passed', JSON.stringify(row));
  assert.ok(!fs.readdirSync(os.tmpdir()).some((name) => name.startsWith('atris-check-files-') && fs.existsSync(path.join(os.tmpdir(), name, 'changed-files.txt')) && fs.readFileSync(path.join(os.tmpdir(), name, 'changed-files.txt'), 'utf8').includes('src/lib/lonely.js') && fs.statSync(path.join(os.tmpdir(), name)).mtimeMs > Date.now() - 60000), 'the file list is removed after the run');
  const untimed = JSON.parse(JSON.stringify(MAP));
  delete untimed.checks.full.seconds;
  assert.match(lintMap(untimed).warnings.join('\n'), /falls back to "full", which says no "seconds"/);
});

test('replay leaves a commit that picked a check with no time out of the medians, and says so', () => {
  const { summarize, summaryLines } = require('../lib/check-replay');
  const row = (tier, seconds, unknown) => ({ tier, expected_seconds: seconds, unknown_seconds: unknown, uncovered: [], times_from: {} });
  const summary = summarize([row('normal', 0, true), row('normal', 10, false), row('normal', 30, false)], 0);
  assert.equal(summary.tiers.normal.median_seconds, 20);
  assert.equal(summary.unknown_seconds_commits, 1);
  assert.match(summaryLines({ base: 'origin/master', summary }).join('\n'), /1 commit picked a check with no time/);
});
