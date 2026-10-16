#!/usr/bin/env node
// The judge for "Campaign ships across Atris": every surface must agree on
// the golden campaign files in test/fixtures/campaign/.
//
//   node scripts/campaign-conformance.js [--json] [--only cli,backend] [--merged]
//        [--surface backend=/path/to/checkout] [--fixtures <dir>]
//   node scripts/campaign-conformance.js --write-manifest
//
// --merged judges what has landed: each repo's default branch on origin, in a
// clean temporary checkout, never anyone's uncommitted work. The campaign's
// judge (npm run validate:campaign) uses it.
//
// Exit 0 only when the fixture hashes match MANIFEST.json and every surface's
// runner reproduces every expected result. A missing runner is a failure.
// Protocol: test/fixtures/campaign/README.md "Surfaces and the judge".

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const RUNNER = path.join('scripts', 'campaign-fold-runner');

const SURFACES = [
  { name: 'cli', repo: 'atris-cli', kind: 'fold' },
  { name: 'backend', repo: 'atrisos-backend', kind: 'fold' },
  { name: 'desktop', repo: 'atris-desktop-v2', kind: 'view' },
  { name: 'web', repo: 'atrisos-web', kind: 'view' },
  { name: 'terrace', repo: 'terrace', kind: 'view' },
];

function parseArgs(argv) {
  const args = { json: false, only: null, overrides: {}, fixtures: null, writeManifest: false, merged: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--write-manifest') args.writeManifest = true;
    else if (arg === '--merged') args.merged = true;
    else if (arg === '--only') {
      args.only = String(argv[++i] || '').split(',').filter(Boolean);
      if (!args.only.length) throw new Error('--only needs at least one surface name');
    }
    else if (arg === '--fixtures') args.fixtures = path.resolve(argv[++i] || '');
    else if (arg === '--surface') {
      const [name, dir] = String(argv[++i] || '').split('=');
      if (!name || !dir) throw new Error('--surface takes name=/path/to/checkout');
      args.overrides[name] = path.resolve(dir);
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return args;
}

// The CLI checkout itself, and its siblings, live next to the main checkout,
// so a worktree of atris-cli still finds the other repos.
function siblingsRoot() {
  if (process.env.ATRIS_SURFACES_ROOT) return process.env.ATRIS_SURFACES_ROOT;
  const { mainCheckoutRoot } = require('../lib/engine-registry');
  return path.dirname(mainCheckoutRoot(REPO) || REPO);
}

function mainCheckoutOf(repo) {
  const { mainCheckoutRoot } = require('../lib/engine-registry');
  return mainCheckoutRoot(repo);
}

function surfaceRepo(surface, overrides) {
  if (overrides[surface.name]) return overrides[surface.name];
  if (surface.name === 'cli') return REPO;
  return path.join(siblingsRoot(), surface.repo);
}

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120000 });
}

function defaultBranch(repo) {
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '');
  const remote = git(repo, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const match = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remote.stdout || '');
  return match ? match[1] : 'master';
}

// A clean checkout of what has landed on origin, removed after the run.
function mergedCheckout(repo, scratch, name) {
  if (!fs.existsSync(path.join(repo, '.git'))) return { error: `no checkout at ${repo}` };
  const branch = defaultBranch(repo);
  const fetched = git(repo, ['fetch', '--quiet', 'origin', branch]);
  if (fetched.status !== 0) return { error: `could not fetch origin/${branch}: ${String(fetched.stderr).trim().split('\n').pop()}` };
  const dir = path.join(scratch, name);
  const added = git(repo, ['worktree', 'add', '--detach', '--quiet', dir, 'FETCH_HEAD']);
  if (added.status !== 0) return { error: `could not check out origin/${branch}: ${String(added.stderr).trim().split('\n').pop()}` };
  return { dir, branch, cleanup: () => git(repo, ['worktree', 'remove', '--force', dir]) };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixtureFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json').sort();
}

function writeManifest(dir) {
  const files = {};
  for (const file of fixtureFiles(dir)) files[file] = sha256(path.join(dir, file));
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({ files }, null, 2) + '\n');
  return Object.keys(files).length;
}

function checkManifest(dir) {
  const manifestPath = path.join(dir, 'MANIFEST.json');
  if (!fs.existsSync(manifestPath)) return ['MANIFEST.json is missing'];
  const pinned = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || {};
  const problems = [];
  const present = fixtureFiles(dir);
  for (const file of present) {
    if (!pinned[file]) problems.push(`${file} is not pinned`);
    else if (pinned[file] !== sha256(path.join(dir, file))) problems.push(`${file} changed since it was pinned`);
  }
  for (const file of Object.keys(pinned)) {
    if (!present.includes(file)) problems.push(`${file} is pinned but missing`);
  }
  return problems;
}

// First path where two JSON values differ, or null when equal.
function diffPath(a, b, at = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return at || '(root)';
  if (Array.isArray(a) !== Array.isArray(b)) return at || '(root)';
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${at}.length`;
    for (let i = 0; i < a.length; i++) {
      const found = diffPath(a[i], b[i], `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) {
    if (!(key in a) || !(key in b)) return `${at}.${key}`;
    const found = diffPath(a[key], b[key], `${at}.${key}`);
    if (found) return found;
  }
  return null;
}

function loadGoldens(dir) {
  const goldens = [];
  let decideCases = [];
  for (const file of fixtureFiles(dir)) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (file === 'decide-cases.json') decideCases = data.cases || [];
    else goldens.push(data);
  }
  return { goldens, decideCases };
}

// Runners never see the answers. A fold runner gets each file's events and
// each decide case's view, plus now where one is set; a view runner gets only the views to round-trip.
function runnerInputs(goldens, decideCases) {
  // Real path: macOS temp folders sit behind a symlink, and runners that
  // compare their own path with argv would otherwise stay silent.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-campaign-judge-'));
  const foldDir = path.join(root, 'fold');
  const viewDir = path.join(root, 'view');
  fs.mkdirSync(foldDir);
  fs.mkdirSync(viewDir);
  for (const golden of goldens) {
    const file = `${golden.name}.json`;
    const input = { name: golden.name, events: golden.events };
    if (golden.now !== undefined) input.now = golden.now;
    fs.writeFileSync(path.join(foldDir, file), JSON.stringify(input));
    if (!('error' in golden.expected)) {
      fs.writeFileSync(path.join(viewDir, file), JSON.stringify({ name: golden.name, expected: golden.expected }));
    }
  }
  fs.writeFileSync(path.join(foldDir, 'decide-cases.json'), JSON.stringify({ cases: decideCases.map((c) => (c.now === undefined ? { view: c.view } : { view: c.view, now: c.now })) }));
  return { root, fold: foldDir, view: viewDir };
}

function judgeSurface(surface, repo, dir, goldens, decideCases) {
  const runner = path.join(repo, RUNNER);
  const base = { surface: surface.name, kind: surface.kind, repo };
  if (!fs.existsSync(runner)) return { ...base, status: 'not built', detail: `no ${RUNNER}` };
  const run = spawnSync(runner, [dir[surface.kind]], { cwd: repo, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  if (run.error || run.status !== 0) {
    const why = run.error ? run.error.message : String(run.stderr || '').trim().split('\n').slice(-3).join(' | ');
    return { ...base, status: 'runner failed', detail: why || `exit ${run.status}` };
  }
  let out;
  try {
    out = JSON.parse(run.stdout);
  } catch {
    return { ...base, status: 'runner failed', detail: 'output is not JSON' };
  }
  if (out.kind !== surface.kind) return { ...base, status: 'runner failed', detail: `kind is ${out.kind}, expected ${surface.kind}` };

  const mismatches = [];
  const checked = goldens.filter((g) => surface.kind === 'fold' || !('error' in g.expected));
  for (const golden of checked) {
    const got = (out.results || {})[golden.name];
    if (got === undefined) mismatches.push({ file: golden.name, at: 'missing' });
    else {
      const at = diffPath(got, golden.expected);
      if (at) mismatches.push({ file: golden.name, at });
    }
  }
  let decidePassed = null;
  if (surface.kind === 'fold') {
    const got = Array.isArray(out.decide) ? out.decide : [];
    decidePassed = 0;
    decideCases.forEach((c, i) => {
      const at = got[i] === undefined ? 'missing' : diffPath(got[i], c.expected);
      if (at) mismatches.push({ file: `decide-cases[${i}]`, at });
      else decidePassed++;
    });
  }
  return {
    ...base,
    status: mismatches.length ? 'mismatch' : 'pass',
    files: { passed: checked.length - mismatches.filter((m) => !m.file.startsWith('decide-cases')).length, total: checked.length },
    decide: decidePassed === null ? null : { passed: decidePassed, total: decideCases.length },
    mismatches,
  };
}

function runJudge(args) {
  const dir = args.fixtures || path.join(REPO, 'test', 'fixtures', 'campaign');
  const manifestProblems = checkManifest(dir);
  const { goldens, decideCases } = loadGoldens(dir);
  const unknown = (args.only || []).filter((name) => !SURFACES.some((s) => s.name === name));
  if (unknown.length) throw new Error(`unknown surface: ${unknown.join(', ')} (surfaces: ${SURFACES.map((s) => s.name).join(', ')})`);
  const surfaces = SURFACES.filter((s) => !args.only || args.only.includes(s.name));
  let results = [];
  if (!manifestProblems.length) {
    const inputs = runnerInputs(goldens, decideCases);
    try {
      results = surfaces.map((s) => {
        const repo = surfaceRepo(s, args.overrides);
        if (!args.merged) return judgeSurface(s, repo, inputs, goldens, decideCases);
        const checkout = mergedCheckout(s.name === 'cli' ? (mainCheckoutOf(repo) || repo) : repo, inputs.root, `merged-${s.name}`);
        if (checkout.error) return { surface: s.name, kind: s.kind, repo, status: 'not merged', detail: checkout.error };
        try {
          return { ...judgeSurface(s, checkout.dir, inputs, goldens, decideCases), repo: `${repo} @ origin/${checkout.branch}` };
        } finally {
          checkout.cleanup();
        }
      });
    } finally {
      fs.rmSync(inputs.root, { recursive: true, force: true });
    }
  }
  const passed = manifestProblems.length === 0 && results.length > 0 && results.every((r) => r.status === 'pass');
  return { passed, merged: args.merged, only: args.only || null, fixtures: dir, golden_files: goldens.length, decide_cases: decideCases.length, manifest_problems: manifestProblems, surfaces: results };
}

function render(report) {
  const lines = [];
  if (report.manifest_problems.length) {
    lines.push('the golden files do not match MANIFEST.json, so no surface was judged:');
    for (const problem of report.manifest_problems) lines.push(`  ${problem}`);
  }
  for (const r of report.surfaces) {
    let line = `${r.surface.padEnd(8)} ${r.status}`;
    if (r.files) line += `  ${r.files.passed}/${r.files.total} files`;
    if (r.decide) line += `, ${r.decide.passed}/${r.decide.total} decide cases`;
    if (r.detail) line += `  (${r.detail})`;
    lines.push(line);
    for (const m of (r.mismatches || []).slice(0, 5)) lines.push(`         ${m.file} differs at ${m.at}`);
    if ((r.mismatches || []).length > 5) lines.push(`         and ${r.mismatches.length - 5} more`);
  }
  const failing = report.surfaces.filter((r) => r.status !== 'pass').length;
  const scope = report.only ? ` (checked only ${report.surfaces.map((r) => r.surface).join(', ')}; the campaign judge checks all five)` : '';
  lines.push(report.passed
    ? `judge passes: every surface checked agrees on ${report.golden_files} golden files${scope}`
    : `judge fails: ${failing || 'all'} of ${report.surfaces.length || 5} surfaces not passing`);
  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.writeManifest) {
    const dir = args.fixtures || path.join(REPO, 'test', 'fixtures', 'campaign');
    console.log(`pinned ${writeManifest(dir)} golden files in ${path.join(dir, 'MANIFEST.json')}`);
    return 0;
  }
  const report = runJudge(args);
  console.log(args.json ? JSON.stringify(report, null, 2) : render(report));
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { checkManifest, diffPath, runJudge, writeManifest };
