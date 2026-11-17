'use strict';

// atris check init: a starter atris/checks.json from what the project already
// has. It only names checks that exist (package.json scripts, test files that
// are there); every guess about when a check should run or how risky a path is
// carries a "confirm" note for a person. It never invents a check.

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
      ...(name === 'test' ? { always: true } : {}),
      confirm: CONFIRM,
    };
  }
  let pyproject = '';
  try { pyproject = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'); } catch {}
  const hasPytest = files.some((file) => /(?:^|\/)(?:pytest\.ini|conftest\.py)$/.test(file)) || /\[tool\.pytest/.test(pyproject);
  if (hasPytest) {
    checks.pytest = { run: 'python -m pytest -q', where: 'here', when: ['**/*.py'], confirm: `${CONFIRM}; a whole pytest run can be slow, narrow it` };
  }
  const hasVitest = files.some((file) => /(?:^|\/)vitest\.config\.[a-z]+$/.test(file))
    || Boolean(pkg && ((pkg.devDependencies || {}).vitest || (pkg.dependencies || {}).vitest));
  if (hasVitest && !Object.values(checks).some((check) => /vitest/.test(check.run))) {
    checks.vitest = { run: 'npx vitest run', where: 'here', when: ['src/**'], confirm: CONFIRM };
  }
  const tests = files.filter((file) => /(?:^|\/)(?:scripts\/)?test-[^/]+\.(?:c?js|mjs)$/.test(file) && file.startsWith('scripts/'));
  if (tests.length) {
    checks['changed-tests'] = {
      run: 'node {file}',
      each: ['scripts/test-*.{js,cjs,mjs}'],
      where: 'here',
      confirm: `${CONFIRM}; runs each changed test file, a file marked launches: app goes to the no-screen lane, one marked spends: goes to paid`,
    };
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
    gates: { release: Object.keys(checks).filter((name) => !checks[name].each && checks[name].where === 'here') },
    default: Object.keys(checks).filter((name) => checks[name].always),
  };
  return { map, notes, empty: Object.keys(checks).length === 0 };
}

module.exports = { starterMap };
