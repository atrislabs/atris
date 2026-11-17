'use strict';

// atris check init: a starter atris/checks.json from what the project already
// has. It only names checks that exist (package.json scripts, test files that
// are there); every guess about when a check should run or how risky a path is
// carries a "confirm" note for a person. It never invents a check.
//
// It never marks a check `always`: init cannot know how long a check takes,
// and always is only for checks of 5 seconds or less. A project's full test
// command goes in the release gate (high risk runs it) and becomes the
// fallback of a selector that runs only the tests a change needs.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { whereFromMarkers } = require('./check-plan');

const SCRIPT_NAME = /^(?:test|check|lint|typecheck|types)(?::|$)/;
const HIGH_RISK_WORDS = [
  ['sign-in', /(?:^|[/_.-])(?:auth|login|signin|sign-in|oauth|session)/i],
  ['money', /(?:^|[/_.-])(?:billing|payment|payments|stripe|credit|credits|wallet|checkout|invoice)/i],
  ['security', /(?:^|[/_.-])(?:keychain|secret|secrets|vault|security|api[_-]?keys?)/i],
  ['release', /(?:^|[/_.-])(?:release|publish|deploy)/i],
];
const CONFIRM = 'found by atris check init; a person confirms when it should run';

function trackedFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) return [];
  return String(result.stdout || '').split('\0').filter(Boolean);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function head(root, file) {
  try { return fs.readFileSync(path.join(root, file), 'utf8').split('\n').slice(0, 20).join('\n'); } catch { return ''; }
}

// Group a list of files into a few folder globs, so the starter stays short.
function folderGlobs(files, limit = 12) {
  const counts = new Map();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    const key = dir === '.' ? file : `${dir}/${path.posix.basename(file).replace(/\.[^.]+$/, '')}*`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.keys()].sort().slice(0, limit);
}

function starterMap(root) {
  const files = trackedFiles(root);
  const checks = {};
  const notes = [];
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = (pkg && pkg.scripts) || {};
  for (const name of Object.keys(scripts).filter((key) => SCRIPT_NAME.test(key)).sort()) {
    const body = String(scripts[name]);
    const scriptFile = (body.match(/(?:node|bash|sh|python3?)\s+(\S+\.(?:c?js|mjs|sh|py))/) || [])[1];
    const where = scriptFile ? whereFromMarkers(head(root, scriptFile), 'here') : 'here';
    checks[name.replace(/:/g, '-')] = {
      run: `npm run ${name}`,
      where,
      when: [],
      ...(name === 'test' ? { tier: 'high' } : {}),
      confirm: CONFIRM,
    };
  }
  let pyproject = '';
  try { pyproject = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'); } catch {}
  const hasPytest = files.some((file) => /(?:^|\/)(?:pytest\.ini|conftest\.py)$/.test(file)) || /\[tool\.pytest/.test(pyproject);
  if (hasPytest) {
    const roots = [...new Set(files.filter((file) => /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(file)).map((file) => path.posix.dirname(file).split('/').slice(0, 2).join('/')))].sort().slice(0, 6);
    checks.pytest = { run: 'python -m pytest -q', where: 'here', tier: 'high', confirm: `${CONFIRM}; the whole suite, run for high risk changes and when no test covers a file` };
    checks['py-tests'] = {
      select: 'pytest',
      roots: roots.length ? roots : ['tests'],
      run: 'python -m pytest -q {parallel} {files}',
      max: 40,
      fallback: 'pytest',
      where: 'here',
      confirm: `${CONFIRM}; runs only the tests that cover a change`,
    };
  }
  const hasVitest = files.some((file) => /(?:^|\/)vitest\.config\.[a-z]+$/.test(file))
    || Boolean(pkg && ((pkg.devDependencies || {}).vitest || (pkg.dependencies || {}).vitest));
  if (hasVitest && !Object.values(checks).some((check) => /vitest/.test(check.run))) {
    checks.vitest = { run: 'npx vitest run', where: 'here', tier: 'high', confirm: CONFIRM };
  }
  const vitestFull = Object.entries(checks).find(([, check]) => /vitest/.test(check.run) || (pkg && /vitest/.test(String(scripts[check.run.replace(/^npm run /, '')] || ''))));
  const unitTests = files.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && !file.startsWith('node_modules/'));
  if (hasVitest && vitestFull && unitTests.length) {
    checks['unit-tests'] = {
      select: 'node-test',
      roots: [...new Set(unitTests.map((file) => file.split('/')[0]))].sort().slice(0, 6),
      run: 'npx vitest run {files}',
      max: 40,
      fallback: vitestFull[0],
      where: 'here',
      confirm: `${CONFIRM}; runs only the test files that cover a change`,
    };
  }
  const tests = files.filter((file) => /(?:^|\/)(?:scripts\/)?test-[^/]+\.(?:c?js|mjs)$/.test(file) && file.startsWith('scripts/'));
  const fullTest = checks.test ? 'test' : '';
  if (tests.length && fullTest) {
    checks.tests = {
      select: 'node-test',
      roots: ['scripts'],
      run: 'node {file}',
      max: 40,
      fallback: fullTest,
      where: 'here',
      seconds: 3,
      confirm: `${CONFIRM}; runs each test that covers a change (changed, imports it, named for it); a file marked launches: app goes to the no-screen lane, one marked spends: goes to paid`,
    };
  } else if (tests.length) {
    checks['changed-tests'] = {
      run: 'node {file}',
      each: ['scripts/test-*.{js,cjs,mjs}'],
      where: 'here',
      confirm: `${CONFIRM}; runs each changed test file, a file marked launches: app goes to the no-screen lane, one marked spends: goes to paid`,
    };
  }
  if (tests.length) {
    const offHere = tests.map((file) => [file, whereFromMarkers(head(root, file), 'here')]).filter(([, where]) => where !== 'here');
    if (offHere.length) notes.push(`${offHere.length} test file(s) say they open the app or spend money; they will never run here`);
  }
  if (files.includes('scripts/ship.mjs') || files.includes('scripts/ship.sh')) {
    notes.push('this project has its own ship script; copy its always-run checks into "checks" by hand, init does not read code it cannot run');
  }
  const high = {};
  for (const [kind, pattern] of HIGH_RISK_WORDS) {
    const hits = files.filter((file) => pattern.test(file) && !/(?:^|\/)(?:tests?|__tests__|docs?|atris)\//.test(file) && !/\.md$/.test(file));
    if (hits.length) high[kind] = folderGlobs(hits);
  }
  const map = {
    version: 1,
    note: 'Starter map from atris check init. Every check and risk path here was found, not invented; confirm each one, then remove its confirm line.',
    checks,
    risk: {
      low: ['**/*.md', 'docs/**'],
      high,
    },
    gates: { release: Object.keys(checks).filter((name) => !checks[name].each && !checks[name].select && checks[name].where === 'here') },
    // A file no rule knows: the selectors pick its tests, or fall back to the full run.
    default: Object.keys(checks).filter((name) => checks[name].select).length
      ? Object.keys(checks).filter((name) => checks[name].select)
      : Object.keys(checks).filter((name) => checks[name].tier === 'high'),
  };
  return { map, notes, empty: Object.keys(checks).length === 0 };
}

module.exports = { starterMap };
