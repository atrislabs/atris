'use strict';

// The eight gaps found when sentinel watch fixed our own website and backend:
// stale install notice, the real package tool error, scoped overrides, every
// lockfile fixed by its own tool with a full left-over list, lockfile paths in
// findings, subfolder lockfiles, major version jumps and resolved events only
// from the default branch. Temp repos, a fake OSV server and fake package
// tools. No real network and no real npm or pnpm run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

const watch = require('../lib/sentinel-watch');
const powers = require('../commands/sentinel-powers');

const made = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  return file;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

async function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function assertVoice(text) {
  assert.ok(!text.includes('\u2014'), 'em dash in output');
  const m = text.match(/.{0,40},\s+(?:and|but|so|then|because|which|when)\b.{0,20}/);
  assert.ok(!m, `comma before a joining word: ${m && m[0]}`);
}

function fakeOsv({ vulns = {}, byPackage = {} } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      calls.push({ method: req.method, url: req.url, json });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && req.url === '/v1/querybatch') {
        return send(200, { results: json.queries.map((q) => ({ vulns: (byPackage[`${q.package.ecosystem}:${q.package.name}@${q.version}`] || []).map((id) => ({ id })) })) });
      }
      const m = req.url.match(/^\/v1\/vulns\/(.+)$/);
      if (req.method === 'GET' && m) {
        const v = vulns[decodeURIComponent(m[1])];
        return v ? send(200, v) : send(404, {});
      }
      if (req.method === 'POST' && req.url === '/api/sentinel/events') return send(201, { saved: json.events.length });
      send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ calls, base, api: `${base}/api`, close: () => new Promise((r) => server.close(r)), sent: () => calls.filter((c) => c.url === '/api/sentinel/events').flatMap((c) => c.json.events) });
  }));
}

function vuln(id, name, fixed, eco = 'npm', severity = 'HIGH') {
  return { id, database_specific: { severity }, affected: [{ package: { ecosystem: eco, name }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }] };
}

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function withGitEnv() {
  const saved = {};
  for (const [k, v] of Object.entries(GIT_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}
function sh(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim(); }
function gitRepo(files, { ignore } = {}) {
  const root = tmp('swg-git-');
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  if (ignore) write(root, '.gitignore', ignore);
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'init');
  return root;
}

// A fake package tool runner: git runs for real, every other tool calls the
// handler for that tool. The handler edits files the way the real tool would.
function fakeTools(handlers, calls = []) {
  return (cmd, args, opts = {}) => {
    if (cmd === 'git') return execFileSync(cmd, args, { ...opts, env: { ...process.env, ...GIT_ENV } });
    calls.push({ cmd, args, cwd: opts.cwd });
    const h = handlers[cmd];
    if (!h) { const e = new Error(`spawnSync ${cmd} ENOENT`); e.code = 'ENOENT'; throw e; }
    return h(args, opts.cwd) || '';
  };
}

// ---------------------------------------------------------------- 1. stale install

test('gap 1: a stale install prints one plain upgrade line. the skip flag and --json turn it off', async () => {
  const lines = [];
  const n = powers.startUpdateNotice(['watch'], { env: {}, check: async () => ({ installed: '3.82.7', latest: '3.83.0', needsUpdate: true }), packageRoot: tmp('swg-pkg-') });
  const line = await n.print((m) => lines.push(m));
  assert.strictEqual(line, '  a newer atris is out: 3.83.0. this one is 3.82.7. update with: npm install -g atris@latest');
  assert.deepStrictEqual(lines, [line]);
  assertVoice(line);
  let asked = 0;
  const check = async () => { asked += 1; return { installed: '1.0.0', latest: '2.0.0', needsUpdate: true }; };
  assert.strictEqual(await powers.startUpdateNotice(['watch'], { env: { ATRIS_SKIP_UPDATE_CHECK: '1' }, check }).print(() => {}), null);
  assert.strictEqual(await powers.startUpdateNotice(['watch', '--json'], { env: {}, check }).print(() => {}), null);
  assert.strictEqual(asked, 0, 'a skipped notice never asks npm');
  assert.strictEqual(await powers.startUpdateNotice(['watch'], { env: {}, check: async () => null }).print(() => {}), null);
  const slow = powers.startUpdateNotice(['watch'], { env: {}, check: () => new Promise(() => {}), timeoutMs: 30 });
  assert.strictEqual(await slow.print(() => {}), null, 'a slow registry never holds the run');
});

test('gap 1: atris sentinel watch from the cli shows the upgrade line from the update cache', () => {
  const home = tmp('swg-home-');
  write(home, '.atris/.update-check', { lastCheck: new Date().toISOString(), latestVersion: '99.0.0' });
  const empty = tmp('swg-empty-');
  const bin = path.join(__dirname, '..', 'bin', 'atris.js');
  const env = { ...process.env, HOME: home, ATRIS_AUTO_UPDATE: 'off' };
  delete env.ATRIS_SKIP_UPDATE_CHECK;
  delete env.NO_UPDATE_NOTIFIER;
  const r = spawnSync(process.execPath, [bin, 'sentinel', 'watch', empty, '--no-upload'], { env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const hits = r.stdout.split('\n').filter((l) => /a newer atris is out: 99\.0\.0/.test(l));
  assert.strictEqual(hits.length, 1, r.stdout);
  assert.match(hits[0], /update with: (?:npm install -g atris@latest|atris upgrade)/);
  const skip = spawnSync(process.execPath, [bin, 'sentinel', 'watch', empty, '--no-upload'], { env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(skip.status, 0, skip.stderr);
  assert.ok(!/newer atris/.test(skip.stdout));
});

// ---------------------------------------------------------------- npm fixtures

// eslint pulls a safe minimatch 3.1.2. glob pulls an affected minimatch 9.0.3.
function scopedLock({ globMinimatch = '9.0.3', eslintMinimatch = '3.1.2' } = {}) {
  return {
    name: 'web', lockfileVersion: 3,
    packages: {
      '': { name: 'web', devDependencies: { eslint: '^8.0.0', glob: '^10.0.0' } },
      'node_modules/eslint': { version: '8.57.0', dev: true, dependencies: { minimatch: '^3.1.2' } },
      'node_modules/minimatch': { version: eslintMinimatch, dev: true },
      'node_modules/glob': { version: '10.3.0', dev: true, dependencies: { minimatch: '^9.0.1' } },
      'node_modules/glob/node_modules/minimatch': { version: globMinimatch, dev: true },
    },
  };
}
const SCOPED_PKG = { name: 'web', devDependencies: { eslint: '^8.0.0', glob: '^10.0.0' } };
const MINIMATCH = { vulns: { 'GHSA-mm00-0000-0001': vuln('GHSA-mm00-0000-0001', 'minimatch', '9.0.5') }, byPackage: { 'npm:minimatch@9.0.3': ['GHSA-mm00-0000-0001'] } };

// ---------------------------------------------------------------- 2. real error

test('gap 2: a failing npm shows its own words and the installed npm version, never just Command failed', async () => {
  const srv = await fakeOsv(MINIMATCH);
  const restoreEnv = withGitEnv();
  const root = gitRepo({ 'package.json': SCOPED_PKG, 'package-lock.json': scopedLock() });
  const pkgBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const run = fakeTools({
    npm(args) {
      if (args[0] === '--version') return '11.3.0\n';
      const e = new Error('Command failed: npm install --package-lock-only --ignore-scripts --no-audit --no-fund');
      e.status = 1;
      e.stderr = "npm error Cannot read properties of null (reading 'edgesOut')\nnpm error A complete log of this run can be found in: /Users/x/.npm/_logs/debug-0.log\n";
      throw e;
    },
  });
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assertVoice(r.out);
    assert.match(r.out, /npm could not update package-lock\.json\. it said:\n {4}Cannot read properties of null \(reading 'edgesOut'\)/);
    assert.match(r.out, /this looks like an npm bug or a version problem\. npm 11\.3\.0 is installed here\. a newer npm may get past it: npm install -g npm@latest/);
    assert.ok(!/Command failed/.test(r.out + r.err));
    assert.ok(!/complete log/.test(r.out));
    assert.match(r.out, /left for you to update \(1\):\n {4}minimatch 9\.0\.3 to 9\.0\.5 in package-lock\.json: npm could not update package-lock\.json/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), pkgBefore, 'package.json put back');
    assert.strictEqual(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'empty fix branch dropped');
  } finally { restoreEnv(); await srv.close(); }
  // A plain failure with no known bug shape gets the words but no npm hint.
  const lines = watch.toolErrorLines(Object.assign(new Error('Command failed: npm install'), { status: 1, stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope\n' }), 'npm');
  assert.deepStrictEqual(lines, ['404 Not Found - GET https://registry.npmjs.org/nope']);
  assert.deepStrictEqual(watch.toolErrorLines(Object.assign(new Error('Command failed: npm install'), { status: 7, stderr: '' }), 'npm'), ['npm stopped with exit code 7 and printed no reason']);
});

// ---------------------------------------------------------------- 3. scoped overrides

test('gap 3: the override is scoped to the package that pulls in the affected copy and the safe copy never moves', async () => {
  const srv = await fakeOsv(MINIMATCH);
  const restoreEnv = withGitEnv();
  const root = gitRepo({ 'package.json': SCOPED_PKG, 'package-lock.json': scopedLock() });
  const seen = [];
  const run = fakeTools({
    npm(args, cwd) {
      seen.push(readJson(path.join(cwd, 'package.json')));
      assert.deepStrictEqual(args, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
      write(cwd, 'package-lock.json', scopedLock({ globMinimatch: '9.0.5' }));
    },
  });
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assertVoice(r.out);
    assert.deepStrictEqual(seen[0].overrides, { 'glob@10.3.0': { minimatch: '^9.0.5' } });
    assert.ok(!('minimatch' in seen[0].overrides), 'no global minimatch override');
    const lock = readJson(path.join(root, 'package-lock.json'));
    assert.strictEqual(lock.packages['node_modules/minimatch'].version, '3.1.2', "eslint's minimatch stays");
    assert.match(r.out, /updated 2 files on a new branch: sentinel\/fix-dependencies-/);
    assert.ok(!/left for you/.test(r.out));
  } finally { restoreEnv(); await srv.close(); }
});

test('gap 3: when the tool moves a safe copy anyway the change is undone and listed', async () => {
  const srv = await fakeOsv(MINIMATCH);
  const restoreEnv = withGitEnv();
  const root = gitRepo({ 'package.json': SCOPED_PKG, 'package-lock.json': scopedLock() });
  const lockBefore = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
  const run = fakeTools({ npm(args, cwd) { write(cwd, 'package-lock.json', scopedLock({ globMinimatch: '9.0.5', eslintMinimatch: '9.0.5' })); } });
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assert.match(r.out, /minimatch 9\.0\.3 to 9\.0\.5 in package-lock\.json: the update also changed more than the affected copy: minimatch 3\.1\.2 at node_modules\/minimatch changed\. it was undone/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), lockBefore);
    assert.match(r.out, /the fix changed nothing/);
  } finally { restoreEnv(); await srv.close(); }
});

// ---------------------------------------------------------------- 4 + 5. pnpm and lockfile paths

// Both lockfiles hold zod 3.22.0 (pulled by e2b) and undici 5.0.0 (pulled by
// the project itself).
const PNPM_LOCK = (zod = '3.22.0', undici = '5.0.0') => [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      e2b:',
  '        specifier: ^1.0.0',
  '        version: 1.0.0',
  '      undici:',
  '        specifier: ^5.0.0',
  `        version: ${undici}`,
  '',
  'packages:',
  '',
  '  e2b@1.0.0:',
  '    resolution: {integrity: sha512-a}',
  '',
  `  zod@${zod}:`,
  '    resolution: {integrity: sha512-b}',
  '',
  `  undici@${undici}:`,
  '    resolution: {integrity: sha512-c}',
  '',
  'snapshots:',
  '',
  '  e2b@1.0.0:',
  '    dependencies:',
  `      zod: ${zod}`,
  '',
  `  zod@${zod}: {}`,
  '',
  `  undici@${undici}: {}`,
  '',
].join('\n');
const NPM_LOCK = (zod = '3.22.0', undici = '5.0.0') => ({
  name: 'api', lockfileVersion: 3,
  packages: {
    '': { name: 'api', dependencies: { e2b: '^1.0.0', undici: '^5.0.0' } },
    'node_modules/e2b': { version: '1.0.0', dependencies: { zod: '^3.22.0' } },
    'node_modules/zod': { version: zod },
    'node_modules/undici': { version: undici },
  },
});
const API_PKG = { name: 'api', dependencies: { e2b: '^1.0.0', undici: '^5.0.0' } };
const API_OSV = {
  vulns: { 'GHSA-zd00-0000-0001': vuln('GHSA-zd00-0000-0001', 'zod', '3.22.3'), 'GHSA-un00-0000-0001': vuln('GHSA-un00-0000-0001', 'undici', '5.28.4') },
  byPackage: { 'npm:zod@3.22.0': ['GHSA-zd00-0000-0001'], 'npm:undici@5.0.0': ['GHSA-un00-0000-0001'] },
};

test('gap 4: the npm and the pnpm lockfile are each fixed by their own tool, scoped', async () => {
  const srv = await fakeOsv(API_OSV);
  const restoreEnv = withGitEnv();
  const root = gitRepo({ 'package.json': API_PKG, 'package-lock.json': NPM_LOCK(), 'pnpm-lock.yaml': PNPM_LOCK() });
  const calls = [];
  const pkgs = {};
  const run = fakeTools({
    npm(args, cwd) { pkgs.npm = readJson(path.join(cwd, 'package.json')); write(cwd, 'package-lock.json', NPM_LOCK('3.22.3', '5.28.4')); },
    pnpm(args, cwd) { assert.deepStrictEqual(args, ['install', '--lockfile-only', '--ignore-scripts']); pkgs.pnpm = readJson(path.join(cwd, 'package.json')); write(cwd, 'pnpm-lock.yaml', PNPM_LOCK('3.22.3', '5.28.4')); },
  }, calls);
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assertVoice(r.out);
    assert.deepStrictEqual(calls.map((c) => c.cmd).sort(), ['npm', 'pnpm']);
    assert.deepStrictEqual(pkgs.npm.overrides, { 'e2b@1.0.0': { zod: '^3.22.3' } });
    assert.strictEqual(pkgs.npm.dependencies.undici, '^5.28.4', 'a direct dependency is raised in place');
    assert.deepStrictEqual(pkgs.pnpm.pnpm.overrides, { 'e2b@1.0.0>zod': '^3.22.3' });
    assert.ok(!/left for you/.test(r.out), r.out);
    assert.match(r.out, /updated 3 files on a new branch/);
    const after = await watch.runWatch(root, { base: srv.base });
    assert.strictEqual(after.affected.length, 0, 'the recheck is clean in both lockfiles');
  } finally { restoreEnv(); await srv.close(); }
});

test('gap 4: the pnpm graph names who pulls in each copy in v5, v6 and v9 lockfiles', () => {
  const edge = (e) => `${e.from.project !== undefined ? `project:${e.from.project}` : `${e.from.name}@${e.from.version}`}>${e.name}@${e.version}`;
  assert.deepStrictEqual(watch.pnpmGraph(PNPM_LOCK()).map(edge), ['project:.>e2b@1.0.0', 'project:.>undici@5.0.0', 'e2b@1.0.0>zod@3.22.0']);
  const v6 = ["lockfileVersion: '6.0'", '', 'dependencies:', '  e2b:', '    specifier: ^1.0.0', '    version: 1.0.0', '', 'packages:', '', '  /e2b@1.0.0:', '    resolution: {integrity: x}', '    dependencies:', '      zod: 3.22.0', "      '@scope/peer': 2.0.0(react@18.2.0)", '    dev: false', ''].join('\n');
  assert.deepStrictEqual(watch.pnpmGraph(v6).map(edge), ['project:.>e2b@1.0.0', 'e2b@1.0.0>zod@3.22.0', 'e2b@1.0.0>@scope/peer@2.0.0']);
  const v5 = ['lockfileVersion: 5.4', '', 'dependencies:', '  e2b: 1.0.0', '', 'packages:', '', '  /e2b/1.0.0:', '    dependencies:', '      zod: 3.22.0', '    dev: false', ''].join('\n');
  assert.deepStrictEqual(watch.pnpmGraph(v5).map(edge), ['project:.>e2b@1.0.0', 'e2b@1.0.0>zod@3.22.0']);
});

test('gap 4: when pnpm is missing every package it left is listed, never a partial list', async () => {
  const srv = await fakeOsv(API_OSV);
  const restoreEnv = withGitEnv();
  const root = gitRepo({ 'package.json': API_PKG, 'package-lock.json': NPM_LOCK(), 'pnpm-lock.yaml': PNPM_LOCK() });
  const run = fakeTools({ npm(args, cwd) { write(cwd, 'package-lock.json', NPM_LOCK('3.22.3', '5.28.4')); } });
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assertVoice(r.out);
    assert.match(r.out, /pnpm could not update pnpm-lock\.yaml\. it said:\n {4}pnpm is not installed here/);
    assert.match(r.out, /left for you to update \(2\):/);
    assert.match(r.out, /undici 5\.0\.0 to 5\.28\.4 in pnpm-lock\.yaml: pnpm could not update pnpm-lock\.yaml/);
    assert.match(r.out, /zod 3\.22\.0 to 3\.22\.3 in pnpm-lock\.yaml: pnpm could not update pnpm-lock\.yaml/);
    // The npm side still landed on the branch, with the pnpm overrides put back.
    const pkg = readJson(path.join(root, 'package.json'));
    assert.deepStrictEqual(pkg.overrides, { 'e2b@1.0.0': { zod: '^3.22.3' } });
    assert.ok(!pkg.pnpm, 'the failed pnpm step left nothing behind');
    assert.strictEqual(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'), PNPM_LOCK());
  } finally { restoreEnv(); await srv.close(); }
});

test('gap 4: an affected version still in the lockfile after the tool ran is listed as left', async () => {
  const srv = await fakeOsv(API_OSV);
  const restoreEnv = withGitEnv();
  const root = gitRepo({ 'package.json': API_PKG, 'pnpm-lock.yaml': PNPM_LOCK() });
  const run = fakeTools({ pnpm(args, cwd) { write(cwd, 'pnpm-lock.yaml', PNPM_LOCK('3.22.0', '5.28.4')); } });
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assert.match(r.out, /left for you to update \(1\):\n {4}zod 3\.22\.0 to 3\.22\.3 in pnpm-lock\.yaml: pnpm-lock\.yaml still holds it after the update/);
  } finally { restoreEnv(); await srv.close(); }
});

test('gap 5: each finding names its lockfile in the report and the event says it in plain words', async () => {
  const srv = await fakeOsv(API_OSV);
  const root = tmp('swg-paths-');
  write(root, 'package-lock.json', NPM_LOCK());
  write(root, 'web/pnpm-lock.yaml', PNPM_LOCK());
  try {
    const result = await watch.runWatch(root, { base: srv.base });
    const zods = result.affected.filter((a) => a.name === 'zod').map((a) => a.lockfile).sort();
    assert.deepStrictEqual(zods, ['package-lock.json', 'web/pnpm-lock.yaml']);
    const report = watch.renderReport(result);
    assertVoice(report);
    assert.match(report, /zod 3\.22\.0 in package-lock\.json: security hole\. fixed in 3\.22\.3/);
    assert.match(report, /zod 3\.22\.0 in web\/pnpm-lock\.yaml: security hole/);
    assert.match(report, /2 affected packages\./, 'one package version in two lockfiles counts once');
    assert.ok(!/\(npm\)/.test(report));
    const evs = watch.toEvents(result, { repo: 'api' });
    assert.strictEqual(evs.length, 2, 'one event per package version');
    assert.ok(evs.every((e) => /Found in 2 lockfiles in this project\./.test(e.detail)));
    const solo = await watch.runWatch(root, { base: srv.base, maxLockfiles: 20 });
    solo.affected = solo.affected.filter((a) => a.lockfile === 'web/pnpm-lock.yaml');
    const ev = watch.toEvents(solo, { repo: 'api' })[0];
    assert.match(ev.detail, /Found in the pnpm lockfile in the web folder\.$/);
    assert.ok(!/pnpm-lock|\//.test(ev.detail), 'no file path in the uploaded event');
    const top = { ...solo, affected: result.affected.filter((a) => a.lockfile === 'package-lock.json') };
    assert.match(watch.toEvents(top, { repo: 'api' })[0].detail, /Found in the npm lockfile at the top of the project\.$/);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- 6. subfolders

test('gap 6: lockfiles in subfolders are read, installed copies and ignored folders are not, with a cap', async () => {
  const srv = await fakeOsv({ vulns: { 'PYSEC-2026-0002': vuln('PYSEC-2026-0002', 'requests', '2.20.0', 'PyPI') }, byPackage: { 'PyPI:requests@2.19.0': ['PYSEC-2026-0002'] } });
  const root = gitRepo({
    'package-lock.json': NPM_LOCK(),
    'backend/requirements.txt': 'requests==2.19.0\n',
    'apps/web/pnpm-lock.yaml': PNPM_LOCK(),
    'node_modules/x/package-lock.json': NPM_LOCK(),
    '.venv/lib/requirements.txt': 'requests==2.19.0\n',
    'vendor/gems/Gemfile.lock': 'GEM\n  specs:\n    rack (2.0.1)\n',
    'dist/package-lock.json': NPM_LOCK(),
    'build/requirements.txt': 'requests==2.19.0\n',
  }, { ignore: 'scratch/\n' });
  write(root, 'scratch/requirements.txt', 'requests==2.19.0\n');
  try {
    const result = await watch.runWatch(root, { base: srv.base });
    assert.deepStrictEqual(result.lockfiles.map((l) => l.file), ['package-lock.json', 'backend/requirements.txt', 'apps/web/pnpm-lock.yaml']);
    const report = watch.renderReport(result);
    assert.match(report, /from 3 lockfiles against the osv database\n {2}read: package-lock\.json, backend\/requirements\.txt, apps\/web\/pnpm-lock\.yaml/);
    assert.match(report, /requests 2\.19\.0 in backend\/requirements\.txt/);
  } finally { await srv.close(); }
  const many = tmp('swg-many-');
  for (let i = 0; i < 25; i++) write(many, `svc${String(i).padStart(2, '0')}/requirements.txt`, 'flask==2.0.0\n');
  const srv2 = await fakeOsv();
  try {
    const r = await watch.runWatch(many, { base: srv2.base });
    assert.strictEqual(r.lockfiles.length, watch.MAX_LOCKFILES);
    assert.strictEqual(r.more, 5);
    const text = watch.renderReport(r);
    assertVoice(text);
    assert.match(text, /warning: found 5 more lockfiles past the limit of 20\. they were not read/);
  } finally { await srv2.close(); }
});

// ---------------------------------------------------------------- 7. major jumps

test('gap 7: a fix that jumps a major version is flagged and needs --allow-major to apply', async () => {
  assert.strictEqual(watch.isMajorJump('3.25.0', '4.0.0'), true);
  assert.strictEqual(watch.isMajorJump('10.4.5', '14.0.0'), true);
  assert.strictEqual(watch.isMajorJump('0.3.1', '0.4.0'), true);
  assert.strictEqual(watch.isMajorJump('8.3.0', '8.3.3'), false);
  const osv = { vulns: { 'GHSA-zd00-0000-0009': vuln('GHSA-zd00-0000-0009', 'zod', '4.0.0') }, byPackage: { 'npm:zod@3.22.0': ['GHSA-zd00-0000-0009'] } };
  const srv = await fakeOsv(osv);
  const restoreEnv = withGitEnv();
  const pkg = { name: 'api', dependencies: { e2b: '^1.0.0', undici: '^5.0.0' } };
  const root = gitRepo({ 'package.json': pkg, 'package-lock.json': NPM_LOCK() });
  const calls = [];
  const run = fakeTools({ npm(args, cwd) { write(cwd, 'package-lock.json', NPM_LOCK('4.0.0')); } }, calls);
  const env = { ...process.env, HOME: tmp('swg-h-') };
  try {
    const result = await watch.runWatch(root, { base: srv.base });
    const report = watch.renderReport(result);
    assertVoice(report);
    assert.match(report, /zod 3\.22\.0 in package-lock\.json: security hole\. fixed in 4\.0\.0\. that is a new major version\. check your code before you take it/);
    assert.match(report, /1 of those fixes only in a new major version\. --fix leaves it for a person unless you add --allow-major/);
    assert.match(watch.toEvents(result, { repo: 'api' })[0].detail, /That is a new major version\. Check your code before you take it\./);

    const held = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env }));
    assert.strictEqual(calls.length, 0, 'npm never ran');
    assert.match(held.out, /zod 3\.22\.0 to 4\.0\.0 in package-lock\.json: 4\.0\.0 is a new major version\. check your code then rerun with --allow-major/);
    assert.strictEqual(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

    const ok = await capture(() => powers.watchCommand([root, '--fix', '--allow-major', '--no-upload'], { osvBase: srv.base, run, env }));
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(readJson(path.join(root, 'package.json')).overrides, { 'e2b@1.0.0': { zod: '^4.0.0' } });
    assert.match(ok.out, /on a new branch: sentinel\/fix-dependencies-/);
    assert.ok(!/left for you/.test(ok.out));
  } finally { restoreEnv(); await srv.close(); }
});

// ---------------------------------------------------------------- 8. default branch

test('gap 8: a fix on a side branch is not sent as resolved until it reaches the default branch', async () => {
  const srv = await fakeOsv({ vulns: { 'PYSEC-2026-0002': vuln('PYSEC-2026-0002', 'requests', '2.20.0', 'PyPI') }, byPackage: { 'PyPI:requests@2.19.0': ['PYSEC-2026-0002'] } });
  const env = { ...process.env, HOME: tmp('swg-h-') };
  const root = gitRepo({ 'requirements.txt': 'requests==2.19.0\n' });
  const deps = { token: 'tok', base: srv.api, osvBase: srv.base, env };
  try {
    const first = await capture(() => powers.watchCommand([root], deps));
    assert.strictEqual(first.code, 1, 'a high threat still fails the run');
    const opened = srv.sent();
    assert.deepStrictEqual(opened.map((e) => e.status), ['open']);

    sh(root, 'checkout', '-qb', 'fix-deps');
    write(root, 'requirements.txt', 'requests==2.20.0\n');
    sh(root, 'commit', '-qam', 'fix');
    srv.calls.length = 0;
    const side = await capture(() => powers.watchCommand([root], deps));
    assertVoice(side.out);
    assert.ok(!srv.sent().some((e) => e.status === 'resolved'), 'nothing resolved from a side branch');
    assert.match(side.out, /fixed on this branch, not yet live: 1 threat\. it stays open on your dashboard until the fix is merged into main/);
    assert.ok(!/marked 1 as fixed/.test(side.out));

    // Still held on the next side-branch run: the state kept it open.
    srv.calls.length = 0;
    await capture(() => powers.watchCommand([root], deps));
    assert.ok(!srv.sent().some((e) => e.status === 'resolved'));

    // Merged into main: the same side-branch run now resolves it.
    sh(root, 'checkout', '-q', 'main');
    sh(root, 'merge', '-q', '--ff-only', 'fix-deps');
    sh(root, 'checkout', '-q', 'fix-deps');
    srv.calls.length = 0;
    const merged = await capture(() => powers.watchCommand([root], deps));
    assert.deepStrictEqual(srv.sent().map((e) => [e.fingerprint, e.status]), [[opened[0].fingerprint, 'resolved']]);
    assert.match(merged.out, /marked 1 as fixed/);
  } finally { await srv.close(); }
});

test('gap 8: on the default branch a fix resolves right away', async () => {
  const srv = await fakeOsv({ vulns: { 'PYSEC-2026-0002': vuln('PYSEC-2026-0002', 'requests', '2.20.0', 'PyPI') }, byPackage: { 'PyPI:requests@2.19.0': ['PYSEC-2026-0002'] } });
  const env = { ...process.env, HOME: tmp('swg-h-') };
  const root = gitRepo({ 'requirements.txt': 'requests==2.19.0\n' });
  const deps = { token: 'tok', base: srv.api, osvBase: srv.base, env };
  try {
    await capture(() => powers.watchCommand([root], deps));
    write(root, 'requirements.txt', 'requests==2.20.0\n');
    sh(root, 'commit', '-qam', 'fix');
    srv.calls.length = 0;
    const r = await capture(() => powers.watchCommand([root], deps));
    assert.deepStrictEqual(srv.sent().map((e) => e.status), ['resolved']);
    assert.ok(!/not yet live/.test(r.out));
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- review fixes

test('review 1: a lockfile naming a folder outside the repo is refused before any tool runs', async () => {
  const srv = await fakeOsv(API_OSV);
  const restoreEnv = withGitEnv();
  const outer = tmp('swg-outer-');
  const other = path.join(outer, 'other-project');
  write(other, 'package.json', { name: 'other', dependencies: { undici: '^5.0.0' } });
  const otherBefore = fs.readFileSync(path.join(other, 'package.json'), 'utf8');
  const repo = path.join(outer, 'a', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const lock = NPM_LOCK();
  lock.packages['../../other-project'] = { name: 'other', dependencies: { undici: '^5.0.0' } };
  write(repo, 'package.json', API_PKG);
  write(repo, 'package-lock.json', lock);
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init');
  const calls = [];
  const run = fakeTools({ npm(args, cwd) { write(other, 'package.json', { name: 'other', dependencies: { undici: '^5.28.4' } }); } }, calls);
  try {
    const r = await capture(() => powers.watchCommand([repo, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assertVoice(r.out);
    assert.strictEqual(calls.length, 0, 'npm never ran');
    assert.strictEqual(fs.readFileSync(path.join(other, 'package.json'), 'utf8'), otherBefore);
    assert.match(r.out, /package-lock\.json would write through a symlink or outside this repo \(\.\.\/\.\.\/other-project\)\. nothing was changed/);
    assert.strictEqual(sh(repo, 'status', '--porcelain'), '');
  } finally { restoreEnv(); await srv.close(); }
});

test('review 1: a workspace behind a symlink is refused and a stray file the tool writes is undone', async () => {
  const srv = await fakeOsv(API_OSV);
  const restoreEnv = withGitEnv();
  const away = tmp('swg-away-');
  write(away, 'package.json', { name: 'away' });
  const lock = NPM_LOCK();
  lock.packages['packages/linked'] = { name: 'away' };
  const root = gitRepo({ 'package.json': API_PKG, 'package-lock.json': lock });
  fs.mkdirSync(path.join(root, 'packages'));
  fs.symlinkSync(away, path.join(root, 'packages', 'linked'));
  sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'link');
  const calls = [];
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run: fakeTools({ npm() {} }, calls), env: { ...process.env, HOME: tmp('swg-h-') } }));
    assert.strictEqual(calls.length, 0);
    assert.match(r.out, /would write through a symlink or outside this repo \(packages\/linked\)/);
  } finally { srv.close(); }

  const srv2 = await fakeOsv(MINIMATCH);
  const root2 = gitRepo({ 'package.json': SCOPED_PKG, 'package-lock.json': scopedLock(), 'README.md': 'hello\n' });
  const run = fakeTools({ npm(args, cwd) { write(cwd, 'package-lock.json', scopedLock({ globMinimatch: '9.0.5' })); write(cwd, 'README.md', 'changed\n'); write(cwd, 'extra.txt', 'new\n'); } });
  try {
    const r = await capture(() => powers.watchCommand([root2, '--fix', '--no-upload'], { osvBase: srv2.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assert.match(r.out, /minimatch 9\.0\.3 to 9\.0\.5 in package-lock\.json: npm also changed (?:README\.md|extra\.txt) and 1 more\. it was undone/);
    assert.strictEqual(fs.readFileSync(path.join(root2, 'README.md'), 'utf8'), 'hello\n');
    assert.ok(!fs.existsSync(path.join(root2, 'extra.txt')));
    assert.strictEqual(readJson(path.join(root2, 'package-lock.json')).packages['node_modules/glob/node_modules/minimatch'].version, '9.0.3');
    assert.strictEqual(sh(root2, 'status', '--porcelain'), '');
  } finally { restoreEnv(); await srv2.close(); }
});

test('review 2 + 5: a vulnerable lockfile pushed past the cap or over the size limit stays open', async () => {
  const osv = { vulns: { 'PYSEC-2026-0002': vuln('PYSEC-2026-0002', 'requests', '2.20.0', 'PyPI', 'MODERATE') }, byPackage: { 'PyPI:requests@2.19.0': ['PYSEC-2026-0002'] } };
  const srv = await fakeOsv(osv);
  const env = { ...process.env, HOME: tmp('swg-h-') };
  const root = tmp('swg-cap-');
  write(root, 'zz/requirements.txt', 'requests==2.19.0\n');
  const deps = { token: 'tok', base: srv.api, osvBase: srv.base, env };
  try {
    await capture(() => powers.watchCommand([root], deps));
    const opened = srv.sent();
    assert.deepStrictEqual(opened.map((e) => e.status), ['open']);
    for (let i = 0; i < 20; i++) write(root, `a${String(i).padStart(2, '0')}/requirements.txt`, 'flask==2.0.0\n');
    srv.calls.length = 0;
    const capped = await capture(() => powers.watchCommand([root], deps));
    assertVoice(capped.out);
    assert.ok(!srv.sent().some((e) => e.status === 'resolved'), 'nothing resolved from a capped scan');
    assert.match(capped.out, /1 earlier threat was in a lockfile this check did not read\. it stays open on your dashboard/);
    for (let i = 0; i < 20; i++) fs.rmSync(path.join(root, `a${String(i).padStart(2, '0')}`), { recursive: true });

    // Over the byte limit: skipped with a warning and still held open.
    write(root, 'zz/requirements.txt', `requests==2.19.0\n${'# pad\n'.repeat(50)}`);
    srv.calls.length = 0;
    const big = await capture(() => powers.watchCommand([root], { ...deps, maxLockfileBytes: 100 }));
    assert.match(big.out, /warning: skipped zz\/requirements\.txt: it is larger than 0 MB/);
    assert.ok(!srv.sent().some((e) => e.status === 'resolved'));
    assert.match(big.out, /in a lockfile this check did not read\. it stays open/);
    const direct = await watch.runWatch(root, { base: srv.base, maxBytes: 100 });
    assert.strictEqual(direct.incomplete, true);
    assert.deepStrictEqual(direct.tooBig, ['zz/requirements.txt']);

    // A full scan that no longer finds it resolves it.
    write(root, 'zz/requirements.txt', 'requests==2.20.0\n');
    srv.calls.length = 0;
    await capture(() => powers.watchCommand([root], deps));
    assert.deepStrictEqual(srv.sent().map((e) => [e.fingerprint, e.status]), [[opened[0].fingerprint, 'resolved']]);
  } finally { await srv.close(); }
});

test('review 3: any change outside the affected copies undoes that lockfile', async () => {
  const srv = await fakeOsv(MINIMATCH);
  const restoreEnv = withGitEnv();
  const root = gitRepo({ 'package.json': SCOPED_PKG, 'package-lock.json': scopedLock() });
  const lockBefore = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
  const run = fakeTools({ npm(args, cwd) { const l = scopedLock({ globMinimatch: '9.0.5' }); l.packages['node_modules/eslint'].version = '8.57.1'; write(cwd, 'package-lock.json', l); } });
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assert.match(r.out, /the update also changed more than the affected copy: eslint 8\.57\.0 at node_modules\/eslint changed\..* it was undone/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), lockBefore);
  } finally { restoreEnv(); await srv.close(); }

  const srv2 = await fakeOsv(API_OSV);
  const restore2 = withGitEnv();
  const root2 = gitRepo({ 'package.json': API_PKG, 'pnpm-lock.yaml': PNPM_LOCK() });
  const pnpmBefore = PNPM_LOCK();
  const run2 = fakeTools({ pnpm(args, cwd) { write(cwd, 'pnpm-lock.yaml', PNPM_LOCK('3.22.3', '5.28.4').replace('  e2b@1.0.0:\n    resolution', '  left-pad@1.3.0:\n    resolution: {integrity: z}\n\n  e2b@1.0.0:\n    resolution')); } });
  try {
    const r = await capture(() => powers.watchCommand([root2, '--fix', '--no-upload'], { osvBase: srv2.base, run: run2, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assert.match(r.out, /left-pad 1\.3\.0 is new/);
    assert.strictEqual(fs.readFileSync(path.join(root2, 'pnpm-lock.yaml'), 'utf8'), pnpmBefore);
  } finally { restore2(); await srv2.close(); }
});

test('review 4: an open range becomes ^fixed and a tool that crosses a major anyway is refused', async () => {
  const srv = await fakeOsv(API_OSV);
  const restoreEnv = withGitEnv();
  const pkg = { name: 'api', dependencies: { e2b: '^1.0.0', undici: '>=5.0.0' } };
  const lock = NPM_LOCK();
  lock.packages[''].dependencies.undici = '>=5.0.0';
  const root = gitRepo({ 'package.json': pkg, 'package-lock.json': lock });
  const seen = [];
  const run = fakeTools({ npm(args, cwd) { seen.push(readJson(path.join(cwd, 'package.json'))); const l = NPM_LOCK('3.22.3', '6.0.0'); l.packages[''].dependencies.undici = '>=5.0.0'; write(cwd, 'package-lock.json', l); } });
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assert.strictEqual(seen[0].dependencies.undici, '^5.28.4', 'never >=');
    assert.match(r.out, /undici went to 6\.0\.0\. that is not a fixed version on the line this fix allows/);
    assert.strictEqual(readJson(path.join(root, 'package.json')).dependencies.undici, '>=5.0.0', 'put back');
  } finally { restoreEnv(); await srv.close(); }
});

// ---------------------------------------------------------------- round three

test('round 3: a package.json symlinked to an outside file is never written', async () => {
  const srv = await fakeOsv(MINIMATCH);
  const restoreEnv = withGitEnv();
  const away = tmp('swg-away-');
  const outsidePkg = write(away, 'package.json', SCOPED_PKG);
  const outsideBefore = fs.readFileSync(outsidePkg, 'utf8');
  const root = gitRepo({ 'package-lock.json': scopedLock() });
  fs.symlinkSync(outsidePkg, path.join(root, 'package.json'));
  sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'link');
  const calls = [];
  const run = fakeTools({ npm(args, cwd) { write(cwd, 'package-lock.json', scopedLock({ globMinimatch: '9.0.5' })); } }, calls);
  try {
    const r = await capture(() => powers.watchCommand([root, '--fix', '--no-upload'], { osvBase: srv.base, run, env: { ...process.env, HOME: tmp('swg-h-') } }));
    assertVoice(r.out);
    assert.strictEqual(calls.length, 0, 'npm never ran');
    assert.strictEqual(fs.readFileSync(outsidePkg, 'utf8'), outsideBefore, 'the outside file was never written');
    assert.ok(fs.lstatSync(path.join(root, 'package.json')).isSymbolicLink(), 'the link itself is untouched');
    assert.match(r.out, /package-lock\.json would write through a symlink or outside this repo \(package\.json\)\. nothing was changed/);
  } finally { restoreEnv(); await srv.close(); }

  // A symlinked folder above the lockfile is refused the same way.
  const srv2 = await fakeOsv(MINIMATCH);
  const restore2 = withGitEnv();
  const realDir = tmp('swg-realdir-');
  write(realDir, 'package.json', SCOPED_PKG);
  write(realDir, 'package-lock.json', scopedLock());
  const root2 = gitRepo({ 'README.md': 'x\n' });
  fs.symlinkSync(realDir, path.join(root2, 'web'));
  sh(root2, 'add', '.'); sh(root2, 'commit', '-qm', 'link');
  const lockBefore = fs.readFileSync(path.join(realDir, 'package-lock.json'), 'utf8');
  try {
    const result = await watch.runWatch(root2, { base: srv2.base });
    result.affected = result.affected.length ? result.affected : [{ name: 'minimatch', version: '9.0.3', ecosystem: 'npm', lockfile: 'web/package-lock.json', fixed: '9.0.5', advisories: ['x'], severity: 'high' }];
    const fix = watch.applyFix(root2, result, { run: fakeTools({ npm() { throw new Error('must not run'); } }) });
    assert.match(fix.manual.map((m) => m.why).join('\n'), /would write through a symlink or outside this repo \(web/);
    assert.strictEqual(fs.readFileSync(path.join(realDir, 'package-lock.json'), 'utf8'), lockBefore);
  } finally { restore2(); await srv2.close(); }
});

test('round 3: a reported lockfile moved below the depth limit stays open', async () => {
  const osv = { vulns: { 'PYSEC-2026-0002': vuln('PYSEC-2026-0002', 'requests', '2.20.0', 'PyPI', 'MODERATE') }, byPackage: { 'PyPI:requests@2.19.0': ['PYSEC-2026-0002'] } };
  const srv = await fakeOsv(osv);
  const env = { ...process.env, HOME: tmp('swg-h-') };
  const root = tmp('swg-depth-');
  write(root, 'svc/requirements.txt', 'requests==2.19.0\n');
  write(root, 'other/requirements.txt', 'flask==2.0.0\n');
  const deps = { token: 'tok', base: srv.api, osvBase: srv.base, env };
  try {
    await capture(() => powers.watchCommand([root], deps));
    const opened = srv.sent();
    assert.deepStrictEqual(opened.map((e) => e.status), ['open']);
    const deep = 'svc/a/b/c/d/e/f/requirements.txt';
    write(root, deep, 'requests==2.19.0\n');
    fs.rmSync(path.join(root, 'svc/requirements.txt'));
    srv.calls.length = 0;
    const moved = await capture(() => powers.watchCommand([root], deps));
    assertVoice(moved.out);
    assert.ok(!moved.out.includes(deep), 'the deep copy is below the depth limit');
    assert.ok(!srv.sent().some((e) => e.status === 'resolved'), 'nothing resolved for a lockfile that was not read');
    assert.match(moved.out, /1 earlier threat was in a lockfile this check did not read\. it stays open on your dashboard/);

    // Deleted: still open. Back and fixed: resolved.
    fs.rmSync(path.join(root, 'svc/a'), { recursive: true });
    srv.calls.length = 0;
    await capture(() => powers.watchCommand([root], deps));
    assert.ok(!srv.sent().some((e) => e.status === 'resolved'));
    write(root, 'svc/requirements.txt', 'requests==2.20.0\n');
    srv.calls.length = 0;
    await capture(() => powers.watchCommand([root], deps));
    assert.deepStrictEqual(srv.sent().map((e) => [e.fingerprint, e.status]), [[opened[0].fingerprint, 'resolved']]);
  } finally { await srv.close(); }
});
