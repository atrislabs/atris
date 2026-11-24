'use strict';

// A brand new person's first sentinel run: which AI tool it uses, what it
// says when none is ready, the progress lines, the landing and the help.
// No real AI tool and no network: tools are fake scripts or injected.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const cloud = require('../lib/sentinel-cloud');
const fix = require('../lib/sentinel-fix');
const review = require('../commands/security-review');

const made = [];
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
const priorAuditHome = process.env.ATRIS_SECURITY_AUDIT_HOME;
const auditHome = tmp('sentinel-first-run-home-');
process.env.ATRIS_SECURITY_AUDIT_HOME = auditHome;
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  if (priorAuditHome === undefined) delete process.env.ATRIS_SECURITY_AUDIT_HOME;
  else process.env.ATRIS_SECURITY_AUDIT_HOME = priorAuditHome;
});

// A PATH holding only the named fake tools (and nothing else).
function pathWith(...names) {
  const bin = tmp('sentinel-first-run-bin-');
  for (const n of names) {
    fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, n), 0o755);
  }
  return { PATH: bin };
}

function makeRepo() {
  const root = tmp('sentinel-first-run-repo-');
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'files.js'), "const fs = require('fs');\nmodule.exports = (req) => fs.readFileSync('uploads/' + req.query.name);\n");
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: root });
  return root;
}

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

test('which tool runs: both, one, or none installed', () => {
  assert.deepStrictEqual(cloud.resolveEngines({ token: '', env: pathWith('codex', 'claude') }), { mode: 'local', hunter: null, verifier: null, chosen: 'default' });
  // Only Claude Code: it looks and double-checks, instead of calling a missing codex.
  assert.deepStrictEqual(cloud.resolveEngines({ token: '', env: pathWith('claude') }), { mode: 'local', hunter: 'claude', verifier: 'claude', chosen: 'only_one_local', only: 'claude' });
  assert.strictEqual(cloud.resolveEngines({ token: '', env: pathWith('codex') }).hunter, 'codex');
  assert.strictEqual(cloud.resolveEngines({ token: '', env: pathWith() }).chosen, 'none_installed');
  assert.strictEqual(cloud.resolveEngines({ engine: 'local', token: 'tok', env: pathWith() }).chosen, 'none_installed');
  assert.strictEqual(cloud.resolveEngines({ token: 'tok', env: pathWith() }).mode, 'atris');
});

test('with no AI tool, the review stops at once, says what to install, and writes no review', async () => {
  const root = makeRepo();
  const r = await capture(() => review.auditCommand([], { root, token: '', env: pathWith(), quiet: true }));
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /needs Claude Code or Codex on this computer/);
  assert.match(r.err, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(r.err, /npm install -g @openai\/codex/);
  assert.match(r.err, /atris login, then atris sentinel --engine atris/);
  assert.match(r.err, /costs atris credits, shows the price first, and sends the files it reads/);
  assert.strictEqual(require('../lib/security-audit').latestRun(root), null, 'no review folder, so nothing looks like a clean review');
});

test('a signed-out tool stops before any wait, or hands its part to the signed-in one', () => {
  const env = pathWith('codex', 'claude');
  const roles = { hunter: 'codex', verifier: 'claude' };
  const both = cloud.resolveEngines({ token: '', env });
  // Claude signed out, codex signed in: codex does all of it, and says so.
  const one = review.enginePreflight(both, { roles, env, signedIn: (n) => n === 'codex' });
  assert.deepStrictEqual(one.roles, { hunter: 'codex', verifier: 'codex' });
  assert.match(one.note, /claude is installed but not signed in, so codex does all of it/);
  assert.match(one.note, /claude auth login/);
  // Both signed out: stop with how to sign in.
  const none = review.enginePreflight(both, { roles, env, signedIn: () => false });
  assert.match(none.stop, /codex is installed but not signed in/);
  assert.match(none.stop, /sign in once with: codex login, then claude auth login/);
  assert.match(none.stop, /nothing was reviewed/);
  // Named tools are never swapped.
  const named = cloud.resolveEngines({ hunter: 'codex', verifier: 'claude', token: '', env });
  assert.ok(review.enginePreflight(named, { roles, env, signedIn: (n) => n === 'codex' }).stop);
  // A named tool that is not installed.
  const missing = review.enginePreflight(cloud.resolveEngines({ hunter: 'codex', verifier: 'claude', env: pathWith('claude') }), { roles, env: pathWith('claude'), signedIn: () => true });
  assert.match(missing.stop, /codex is not installed on this computer/);
  // Unknown sign-in never stops a review.
  assert.deepStrictEqual(review.enginePreflight(both, { roles, env, signedIn: () => null }), {});
});

test('the sign-in check reads each tool\'s own status answer, and unclear answers stay unknown', () => {
  const env = { PATH: '/nowhere' };
  const answer = (status, stdout) => () => ({ status, stdout, stderr: '' });
  assert.strictEqual(cloud.engineSignedIn('claude', { env, spawnSync: answer(1, '{\n  "loggedIn": false,\n  "authMethod": "none"\n}') }), false);
  assert.strictEqual(cloud.engineSignedIn('claude', { env, spawnSync: answer(0, '{ "loggedIn": true }') }), true);
  assert.strictEqual(cloud.engineSignedIn('codex', { env, spawnSync: answer(1, 'Not logged in') }), false);
  assert.strictEqual(cloud.engineSignedIn('codex', { env, spawnSync: answer(0, 'Logged in using ChatGPT') }), true);
  assert.strictEqual(cloud.engineSignedIn('codex', { env, spawnSync: () => ({ error: new Error('ENOENT') }) }), null);
  assert.strictEqual(cloud.engineSignedIn('claude', { env, spawnSync: answer(0, 'unknown command auth') }), null);
  assert.strictEqual(cloud.engineSignedIn('codex', { env, spawnSync: () => ({ status: null, signal: 'SIGTERM' }) }), null);
  // A key in the environment means the tool may work without a login.
  assert.strictEqual(cloud.engineSignedIn('claude', { env: { ANTHROPIC_API_KEY: 'x' }, spawnSync: answer(1, '{"loggedIn": false}') }), null);
  // The check runs from an empty folder of its own, never the project.
  let cwd = null;
  cloud.engineSignedIn('codex', { env, spawnSync: (cmd, args, o) => { cwd = o.cwd; return { status: 0, stdout: 'Logged in' }; } });
  assert.ok(cwd && cwd.includes('atris-sentinel-signin-') && !fs.existsSync(cwd));
});

test('a review that read nothing says so and does not exit clean', async () => {
  const root = makeRepo();
  const runJobs = async (jobs) => jobs.map(() => ({ ok: false, stdout: '', reason: 'spawn_error' }));
  const r = await capture(() => review.auditCommand(['--quick', '--no-upload'], { root, token: '', env: pathWith('codex', 'claude'), runJobs, quiet: true }));
  assert.strictEqual(r.code, 1, r.out + r.err);
  assert.match(r.out, /nothing was read, so this review says nothing about your code/);
  assert.match(r.out, /codex did not answer\. check that it works and is signed in/);
  assert.doesNotMatch(r.out, /no problems found/);
});

test('the landing leads with the outcome in plain words and never calls the code safe', () => {
  const base = { repo: 'shop', profile: 'standard', scope_paths: [], budget: 20, engines: { hunter: 'codex', verifier: 'claude' }, invocations: { used: 9 }, counts: { severity: { high: 1 } }, run_status: 'complete' };
  const confirmed = { verdict: 'confirmed', title: 'Anyone can read any invoice', severity: { overall: 'high' }, trace: [{ file: 'app/main.py', line: 34 }] };
  const found = review.renderAuditLanding({ dir: '/tmp/r/run-1', meta: { ...base, coverage: { in_scope: 4, fresh: 4, carried: 0, deferred: 0 } }, records: [confirmed] });
  assert.match(found, /1 confirmed \(1 high\)\. each one was found, then double-checked/);
  assert.match(found, /high\s+Anyone can read any invoice \(app\/main\.py:34\)/);
  assert.match(found, /next: atris sentinel fix/);
  assert.match(found, /codex looked, claude double-checked · 9 of 20 AI tool calls/);
  const clean = review.renderAuditLanding({ dir: '/tmp/r/run-2', meta: { ...base, counts: { severity: {} }, coverage: { in_scope: 4, fresh: 2, carried: 0, deferred: 2 } }, records: [] });
  assert.match(clean, /no problems found in the parts that were read/);
  assert.match(clean, /that does not prove there are none/);
  assert.match(clean, /read 2 of 4 parts of your code\. run atris sentinel again to read the other 2/);
  for (const text of [found, clean]) {
    assert.doesNotMatch(text, /\bsecure\b|\bcompliant\b|\bsafe\b/i);
    assert.doesNotMatch(text, /hunter|wave|candidate|engine calls|carried unchanged/);
  }
  const same = review.renderAuditLanding({ dir: '/tmp/r/run-3', meta: { ...base, engines: { hunter: 'claude', verifier: 'claude' }, counts: { severity: {} }, coverage: { in_scope: 1, fresh: 1, carried: 0 } }, records: [] });
  assert.match(same, /claude looked and double-checked, in separate sessions/);
});

test('progress is plain words, with a line every minute so a wait is never silent', () => {
  assert.strictEqual(review.plainProgress('mapping shop'), 'looking over shop');
  assert.strictEqual(review.plainProgress('wave 1: 8 hunters on 8 areas (codex)'), 'codex is reading 8 parts of your code, looking for ways in');
  assert.strictEqual(review.plainProgress('wave 2: 1 hunter on 1 areas (codex)'), 'codex is reading 1 part of your code more');
  assert.strictEqual(review.plainProgress('verifying 6 candidates with claude'), 'claude is double-checking 6 possible problems');
  assert.strictEqual(review.plainProgress('verifying 0 candidates with claude'), 'no possible problems to double-check');
  assert.strictEqual(review.plainProgress('critic final: 0 gaps'), null);
  assert.strictEqual(review.plainProgress('something new'), 'something new');

  const lines = [];
  let clock = 0;
  const realSet = global.setInterval;
  let tick = null;
  global.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  try {
    const p = review.reviewProgress({ say: (m) => lines.push(m), now: () => clock });
    assert.match(lines[0], /takes a few minutes/);
    assert.match(lines[1], /it only reads\. nothing in your project changes/);
    p.log('wave 1: 2 hunters on 2 areas (claude)');
    clock = 3 * 60000;
    tick();
    p.stop();
    assert.ok(lines.includes('  · claude is reading 2 parts of your code, looking for ways in'));
    assert.ok(lines.includes('  · still working, 3 min so far'));
  } finally { global.setInterval = realSet; }
});

test('help: a short first screen with the path to a fix, every command one step away', async () => {
  const short = await capture(() => review.auditCommand(['--help']));
  assert.strictEqual(short.code, 0);
  assert.ok(short.out.split('\n').length <= 30, `short help is ${short.out.split('\n').length} lines`);
  assert.match(short.out, /atris sentinel fix <id>/);
  assert.match(short.out, /you need Claude Code or Codex installed and signed in/);
  assert.match(short.out, /atris does not see it/);
  assert.match(short.out, /cannot prove there are none/);
  assert.doesNotMatch(short.out, /security-review audit|hunter|verifier|wave|coverage ledger/);
  const all = await capture(() => review.auditCommand(['help', 'all']));
  assert.match(all.out, /atris sentinel schedule --every day/);
  assert.match(all.out, /atris sentinel record export/);
  // A subcommand with its own help answers it; the rest list every command and never run.
  const fixHelp = await capture(() => review.auditCommand(['fix', '--help']));
  assert.match(fixHelp.out, /a reviewed fix for a confirmed finding/);
  const scheduleHelp = await capture(() => review.auditCommand(['schedule', '--help']));
  assert.strictEqual(scheduleHelp.code, 0);
  assert.match(scheduleHelp.out, /every command/);
});

test('a fix with only one tool ready: it builds and checks in a fresh session, and says so', () => {
  assert.deepStrictEqual(fix.resolveFixEngines({ available: (n) => n === 'claude' }), { builder: 'claude', verifier: 'claude', same: true });
  // Both installed, claude signed out: codex does both.
  assert.deepStrictEqual(fix.resolveFixEngines({ available: () => true, signedIn: (n) => n === 'codex' }), { builder: 'codex', verifier: 'codex', same: true });
  assert.deepStrictEqual(fix.resolveFixEngines({ available: () => true, signedIn: () => true }), { builder: 'codex', verifier: 'claude' });
  // Named tools keep the old rules.
  assert.throws(() => fix.resolveFixEngines({ builder: 'claude', verifier: 'claude', available: () => true }), /different engine/);
  assert.throws(() => fix.resolveFixEngines({ builder: 'claude', available: (n) => n === 'claude' }), /second tool besides claude/);
  assert.throws(() => fix.resolveFixEngines({ builder: 'codex', verifier: 'claude', available: () => true, signedIn: (n) => n !== 'claude' }), /claude is installed but not signed in.*claude auth login/);
  assert.throws(() => fix.resolveFixEngines({ available: () => false }), /needs Claude Code or Codex/);
});

test('a small python app with pytest in its requirements gets pytest; no test command names one that fits', async () => {
  const py = tmp('sentinel-first-run-py-');
  fs.writeFileSync(path.join(py, 'requirements.txt'), 'fastapi==0.115.0\npytest==8.3.3\n');
  assert.strictEqual(fix.detectTestCommand(py), 'pytest');
  const bare = tmp('sentinel-first-run-bare-');
  fs.writeFileSync(path.join(bare, 'requirements.txt'), 'fastapi==0.115.0\npytest-asyncio==0.1\n');
  assert.strictEqual(fix.detectTestCommand(bare), null, 'a pytest plugin alone is not pytest');

  const { fixCommand } = require('../commands/sentinel-fix');
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'pkg'], { cwd: root });
  const record = { verdict: 'confirmed', fingerprint: 'path-traversal/lib/files.js/read', title: 'Any file can be read', severity: { overall: 'high' }, trace: [{ file: 'lib/files.js', line: 2 }] };
  const dir = path.join(auditHome, require('../lib/security-audit').historyFolder(root), 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ profile: 'quick', run_status: 'complete', finished_at: '2026-11-24T00:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify([record]));
  const r = await capture(() => fixCommand([fix.shortId(record.fingerprint)], { root, env: process.env, available: () => true }));
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /a fix is kept only when a new test proves the hole is closed/);
  assert.match(r.err, new RegExp(`atris sentinel fix ${fix.shortId(record.fingerprint)} --verify "node --test"`));
});

test('the fix list puts the worst problem first and says nothing changes until you merge', async () => {
  const { fixCommand } = require('../commands/sentinel-fix');
  const root = makeRepo();
  const rec = (sev, name) => ({ verdict: 'confirmed', fingerprint: `x/${name}`, title: `${sev} problem`, severity: { overall: sev }, trace: [{ file: 'lib/files.js', line: 2 }] });
  const dir = path.join(auditHome, require('../lib/security-audit').historyFolder(root), 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ profile: 'quick', run_status: 'complete', finished_at: '2026-11-24T00:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify([rec('medium', 'a'), rec('critical', 'b'), rec('high', 'c')]));
  const r = await capture(() => fixCommand([], { root, env: process.env }));
  const order = r.out.split('\n').filter((l) => / problem$/.test(l)).map((l) => l.trim().split(/\s+/)[1]);
  assert.deepStrictEqual(order, ['critical', 'high', 'medium']);
  assert.match(r.out, new RegExp(`fix one with: atris sentinel fix ${fix.shortId('x/b')}`));
  assert.match(r.out, /nothing goes into your code until you merge that branch/);

  // A problem that already has a fix ready is not suggested again.
  execFileSync('git', ['branch', fix.branchFor(rec('critical', 'b'))], { cwd: root });
  const again = await capture(() => fixCommand([], { root, env: process.env }));
  assert.match(again.out, new RegExp(`\\(fix ready: ${fix.branchFor(rec('critical', 'b'))}\\)`));
  assert.match(again.out, new RegExp(`fix one with: atris sentinel fix ${fix.shortId('x/c')}`));
  for (const n of ['a', 'c']) execFileSync('git', ['branch', fix.branchFor(rec('high', n))], { cwd: root });
  const done = await capture(() => fixCommand([], { root, env: process.env }));
  assert.match(done.out, /every problem here has a fix ready/);
  assert.ok(!/fix one with/.test(done.out));
});

test('a review writes nothing inside a project that is not an Atris workspace', () => {
  const env = {};
  const plain = makeRepo();
  fs.mkdirSync(path.join(plain, 'src'));
  assert.strictEqual(cloud.keepProjectClean(path.join(plain, 'src'), env), true);
  assert.strictEqual(env.ATRIS_ENGINE_RESOURCE_LOG, 'off');
  const workspace = makeRepo();
  fs.mkdirSync(path.join(workspace, '.atris'));
  const env2 = {};
  assert.strictEqual(cloud.keepProjectClean(workspace, env2), false);
  assert.strictEqual(env2.ATRIS_ENGINE_RESOURCE_LOG, undefined);
  // With the switch off, the AI tool resource log writes no file.
  const { recordEngineResource } = require('../lib/engine-resource');
  const prior = process.env.ATRIS_ENGINE_RESOURCE_LOG;
  process.env.ATRIS_ENGINE_RESOURCE_LOG = 'off';
  try {
    try { recordEngineResource(plain, { phase: 'start', engine: 'codex', task: 't' }); } catch {}
    assert.ok(!fs.existsSync(path.join(plain, '.atris')), 'no .atris folder was made in the project');
  } finally {
    if (prior === undefined) delete process.env.ATRIS_ENGINE_RESOURCE_LOG; else process.env.ATRIS_ENGINE_RESOURCE_LOG = prior;
  }
});

test('fix with nothing confirmed says why, instead of asking for a review that already ran', async () => {
  const { fixCommand } = require('../commands/sentinel-fix');
  const root = makeRepo();
  const none = await capture(() => fixCommand([], { root, env: process.env }));
  assert.match(none.out, /no review of this project yet\. run atris sentinel first/);
  const dir = path.join(auditHome, require('../lib/security-audit').historyFolder(root), 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ profile: 'quick', run_status: 'complete', finished_at: '2026-11-24T00:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, 'findings.json'), '[]');
  const empty = await capture(() => fixCommand([], { root, env: process.env }));
  assert.match(empty.out, /the last review has no confirmed problems, so there is nothing to fix/);
});
