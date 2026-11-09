'use strict';

// atris sentinel fix, against real temp git repos with fake builder and
// checker engines. No real engine, no network, no real repo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const spawnGit = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const fix = require('../lib/sentinel-fix');
const audit = require('../lib/security-audit');
const { fixCommand } = require('../commands/sentinel-fix');
const { auditCommand } = require('../commands/security-review');

const made = [];
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
const priorAuditHome = process.env.ATRIS_SECURITY_AUDIT_HOME;
const auditHome = tmp('sentinel-fix-audit-');
process.env.ATRIS_SECURITY_AUDIT_HOME = auditHome;
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  if (priorAuditHome === undefined) delete process.env.ATRIS_SECURITY_AUDIT_HOME;
  else process.env.ATRIS_SECURITY_AUDIT_HOME = priorAuditHome;
});

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function sh(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

const VULNERABLE = "'use strict';\nfunction safeName(name) {\n  return typeof name === 'string';\n}\nmodule.exports = { safeName };\n";
const FIXED = "'use strict';\nfunction safeName(name) {\n  return typeof name === 'string' && /^[a-z0-9-]+$/.test(name);\n}\nmodule.exports = { safeName };\n";
const BROKEN = "'use strict';\nfunction safeName(name) {\n  return false;\n}\nmodule.exports = { safeName };\n";
const BASE_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { safeName } = require('../lib/run');\ntest('plain names pass', () => { assert.strictEqual(safeName('ok-1'), true); });\n";
const REGRESSION = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { safeName } = require('../lib/run');\ntest('a shell separator in the name is refused', () => { assert.strictEqual(safeName('x;rm -rf ~'), false); });\n";
const WEAK_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('always passes', () => { assert.ok(true); });\n";

const RECORD = {
  verdict: 'confirmed',
  fingerprint: 'command-injection/lib/run.js/safeName',
  title: 'Shell command built from the branch name',
  attack_class: 'command-injection',
  coverage_ids: [],
  description: 'safeName accepts shell separators.',
  root_cause: 'no character check',
  intended_behavior: 'only plain names pass',
  attacker: 'someone who names a branch',
  impact: 'runs commands as the user',
  trace: [{ kind: 'sink', file: 'lib/run.js', line: 3, description: 'accepts any string', code: "return typeof name === 'string';" }],
  conditions: [],
  severity: { likelihood: { score: 'medium', reason: 'r' }, impact: { score: 'high', reason: 'r' }, overall: 'high' },
  remediation: { strategy: 'allow only [a-z0-9-] in safeName', summary: 'Allow only plain characters', regression_test: 'safeName with a semicolon returns false' },
};

// A real git repo with a passing suite, a pre-commit hook and one confirmed
// finding in the audit home.
function makeRepo({ branch = 'main', remote = null } = {}) {
  const root = tmp('sentinel-fix-repo-');
  sh(root, 'init', '-q', '-b', branch);
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  sh(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test test/*.test.js' } }, null, 2));
  write(root, 'lib/run.js', VULNERABLE);
  write(root, 'test/base.test.js', BASE_TEST);
  // The hook proves fix commits run hooks (no --no-verify).
  const hookLog = path.join(root, '..', `${path.basename(root)}-hook.log`);
  made.push(hookLog);
  write(root, '.git/hooks/pre-commit', `#!/bin/sh\necho ran >> "${hookLog}"\n`);
  fs.chmodSync(path.join(root, '.git/hooks/pre-commit'), 0o755);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init');
  fs.rmSync(hookLog, { force: true });
  if (remote) sh(root, 'remote', 'add', 'origin', remote);
  const dir = path.join(auditHome, audit.repoName(root), 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ profile: 'quick' }));
  fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify([RECORD, { verdict: 'rejected', fingerprint: 'other/x', title: 'not real', reason: 'no' }]));
  return { root, hookLog };
}

function builderWriting(files, { summary = 'Allow only plain characters in names', tests = ['test/fix.test.js'] } = {}) {
  const calls = [];
  const run = async (job) => {
    calls.push(job);
    for (const [rel, text] of Object.entries(files)) write(job.root, rel, text);
    return { ok: true, stdout: `done\n${JSON.stringify({ summary, test_files: tests })}` };
  };
  run.calls = calls;
  return run;
}

function checkerSaying(verdict) {
  const calls = [];
  const run = async (job) => {
    calls.push(job);
    return { ok: true, stdout: JSON.stringify({ verdict, reason: verdict === 'fixed' ? 'the name check now refuses separators' : 'another caller skips the check' }) };
  };
  run.calls = calls;
  return run;
}

function baseDeps(root, extra = {}) {
  const home = tmp('sentinel-fix-home-');
  return { root, token: '', env: { ...process.env, HOME: home }, available: () => true, log: () => {}, ...extra };
}

// Fake codex (builder) and claude (checker) binaries on PATH.
function fakeEngines() {
  const bin = tmp('sentinel-fix-bin-');
  const argLog = path.join(bin, 'args.jsonl');
  const codex = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ engine: 'codex', cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_FIX_PLAN, 'utf8'));
for (const [rel, text] of Object.entries(plan)) { fs.mkdirSync(path.dirname(rel), { recursive: true }); fs.writeFileSync(rel, text); }
console.log(JSON.stringify({ summary: 'Allow only plain characters in names', test_files: ['test/fix.test.js'] }));
`;
  const claude = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ engine: 'claude', cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
console.log('read the change');
console.log(JSON.stringify({ verdict: process.env.FAKE_VERDICT || 'fixed', reason: 'the name check now refuses separators' }));
`;
  write(bin, 'codex', codex);
  write(bin, 'claude', claude);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const plan = path.join(bin, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ 'lib/run.js': FIXED, 'test/fix.test.js': REGRESSION }));
  return { bin, argLog, plan };
}

function fakeEventsServer() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, json: body ? JSON.parse(body) : null });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ saved: 1 }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}/api` })));
}

const short = fix.shortId(RECORD.fingerprint);
const BRANCH = `sentinel/fix-${short}`;

test('happy path: real codex and claude processes, commit on the new branch with the test, main untouched', async () => {
  const { root, hookLog } = makeRepo();
  const mainBefore = sh(root, 'rev-parse', 'main');
  const engines = fakeEngines();
  const srv = await fakeEventsServer();
  try {
    const deps = baseDeps(root, { token: 'test-token', base: srv.base });
    deps.env = { ...deps.env, PATH: `${engines.bin}${path.delimiter}${process.env.PATH}`, FAKE_FIX_PLAN: engines.plan };
    delete deps.available;
    const r = await capture(() => auditCommand(['fix', short], deps));
    assert.strictEqual(r.code, 0, r.out + r.err);
    assert.match(r.out, /prepared a fix on a new branch: sentinel\/fix-/);
    assert.match(r.out, new RegExp(`review it with: git diff main\\.\\.\\.${BRANCH.replace('/', '\\/')}`));
    assert.match(r.out, /nothing was pushed/);
    assert.match(r.out, /tests: npm test/);
    // Still on main, main did not move, tree clean.
    assert.strictEqual(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.strictEqual(sh(root, 'rev-parse', 'main'), mainBefore);
    assert.strictEqual(sh(root, 'status', '--porcelain'), '');
    // One commit on the fix branch, holding the fix and the test.
    assert.strictEqual(sh(root, 'rev-list', '--count', `main..${BRANCH}`), '1');
    const files = sh(root, 'diff', '--name-only', `main...${BRANCH}`).split('\n').sort();
    assert.deepStrictEqual(files, ['lib/run.js', 'test/fix.test.js']);
    const msg = sh(root, 'log', '-1', '--format=%B', BRANCH);
    assert.match(msg, /^Fix: Shell command built from the branch name/);
    assert.ok(msg.includes(RECORD.fingerprint));
    assert.ok(msg.trim().endsWith('Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>'));
    assert.ok(fs.existsSync(hookLog), 'the pre-commit hook ran');
    // Builder ran with write access limited to the repo, checker read-only.
    const calls = fs.readFileSync(engines.argLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const codex = calls.find((c) => c.engine === 'codex');
    const claude = calls.find((c) => c.engine === 'claude');
    assert.notStrictEqual(codex.cwd, root, 'the builder runs in a temp worktree, not your checkout');
    assert.match(codex.cwd, /atris-sentinel-fix-/);
    assert.strictEqual(fs.existsSync(codex.cwd), false, 'the temp worktree is removed');
    assert.strictEqual(sh(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
    assert.strictEqual(spawnGit(root, ['config', '--get', 'extensions.worktreeConfig']).status, 1, 'the worktree config switch is turned back off');
    assert.ok(codex.args.join(' ').includes('--sandbox workspace-write'));
    assert.ok(claude.args.join(' ').includes('--permission-mode plan'));
    assert.ok(claude.args.some((a) => a.includes('```diff') && a.includes('/^[a-z0-9-]+$/')), 'the checker sees the diff');
    // One scan_finished event with the plain title.
    const evs = srv.calls.filter((c) => c.url === '/api/sentinel/events').flatMap((c) => c.json.events);
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].kind, 'scan_finished');
    assert.strictEqual(evs[0].title, 'Prepared a fix for shell command built from the branch name on a new branch.');
  } finally {
    srv.server.close();
  }
});

test('a test that does not fail on the original code is rejected and nothing is committed', async () => {
  const { root } = makeRepo();
  const mainBefore = sh(root, 'rev-parse', 'main');
  const runBuilder = builderWriting({ 'lib/run.js': FIXED, 'test/fix.test.js': WEAK_TEST });
  const runChecker = checkerSaying('fixed');
  const deps = baseDeps(root, { runBuilder, runChecker });
  const r = await capture(() => fixCommand([short], deps));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /no fix was committed: the new test also passes on the original code and does not catch this problem/);
  assert.strictEqual(runChecker.calls.length, 0, 'the checker is not asked when the test proves nothing');
  assert.strictEqual(fix.branchExists(root, BRANCH), false);
  assert.strictEqual(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.strictEqual(sh(root, 'rev-parse', 'main'), mainBefore);
  assert.strictEqual(sh(root, 'status', '--porcelain'), '');
  const patch = path.join(deps.env.HOME, '.atris', 'sentinel', 'fixes');
  const saved = fs.readdirSync(patch);
  assert.strictEqual(saved.length, 1);
  assert.match(fs.readFileSync(path.join(patch, saved[0], 'attempt.patch'), 'utf8'), /always passes/);
});

test('a failing test suite leaves no commit and restores the branch', async () => {
  const { root } = makeRepo({ branch: 'work' });
  const before = sh(root, 'rev-parse', 'work');
  const runBuilder = builderWriting({ 'lib/run.js': BROKEN, 'test/fix.test.js': REGRESSION });
  const deps = baseDeps(root, { runBuilder, runChecker: checkerSaying('fixed') });
  const r = await capture(() => fixCommand([short, '--verify', 'node --test test/*.test.js'], deps));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /no fix was committed: the test suite fails with the fix in place/);
  assert.match(r.out, /you are on work/);
  assert.strictEqual(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'work');
  assert.strictEqual(sh(root, 'rev-parse', 'work'), before);
  assert.strictEqual(fs.readFileSync(path.join(root, 'lib/run.js'), 'utf8'), VULNERABLE);
  assert.strictEqual(fs.existsSync(path.join(root, 'test/fix.test.js')), false);
  assert.strictEqual(fix.branchExists(root, BRANCH), false);
  assert.strictEqual(sh(root, 'branch', '--list', 'sentinel/*'), '');
});

test('the checker saying the attack still works blocks the commit', async () => {
  const { root } = makeRepo();
  const runBuilder = builderWriting({ 'lib/run.js': FIXED, 'test/fix.test.js': REGRESSION });
  const runChecker = checkerSaying('not_fixed');
  const deps = baseDeps(root, { runBuilder, runChecker, available: (n) => n === 'claude' || n === 'codex' });
  const r = await capture(() => fixCommand([short, '--builder', 'claude', '--verify', 'node --test test/*.test.js'], deps));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /no fix was committed: codex says the attack still works: another caller skips the check/);
  assert.strictEqual(runBuilder.calls[0].engine, 'claude');
  assert.strictEqual(runChecker.calls[0].engine, 'codex');
  assert.strictEqual(fix.branchExists(root, BRANCH), false);
  assert.strictEqual(sh(root, 'status', '--porcelain'), '');
});

test('a dirty working tree is refused before any engine runs', async () => {
  const { root } = makeRepo();
  write(root, 'notes.txt', 'mine');
  const runBuilder = builderWriting({ 'lib/run.js': FIXED });
  const r = await capture(() => fixCommand([short], baseDeps(root, { runBuilder, runChecker: checkerSaying('fixed') })));
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /uncommitted changes/);
  assert.strictEqual(runBuilder.calls.length, 0);
  assert.strictEqual(fix.branchExists(root, BRANCH), false);
  assert.strictEqual(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'mine');
});

test('the same engine cannot build and check', async () => {
  const { root } = makeRepo();
  const runBuilder = builderWriting({ 'lib/run.js': FIXED });
  const r = await capture(() => fixCommand([short, '--builder', 'codex', '--verifier', 'codex'], baseDeps(root, { runBuilder })));
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /different engine than the builder/);
  assert.strictEqual(runBuilder.calls.length, 0);
});

test('--pr pushes the fix branch and calls gh pr create with the right args, never merge', async () => {
  const { root } = makeRepo({ remote: 'https://github.com/acme/demo.git' });
  const calls = [];
  const run = (cmd, args, o) => { calls.push({ cmd, args, cwd: o.cwd }); return { code: 0, stdout: cmd === 'gh' ? 'https://github.com/acme/demo/pull/7\n' : '', stderr: '' }; };
  const deps = baseDeps(root, { run, runBuilder: builderWriting({ 'lib/run.js': FIXED, 'test/fix.test.js': REGRESSION }), runChecker: checkerSaying('fixed') });
  const r = await capture(() => fixCommand([short, '--pr', '--verify', 'node --test test/*.test.js'], deps));
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /opened a pull request: https:\/\/github.com\/acme\/demo\/pull\/7. nothing was merged/);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual([calls[0].cmd, ...calls[0].args], ['git', 'push', '-u', 'origin', BRANCH]);
  const gh = calls[1];
  assert.strictEqual(gh.cmd, 'gh');
  assert.deepStrictEqual(gh.args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', BRANCH, '--title', 'Fix: Shell command built from the branch name']);
  assert.strictEqual(gh.args[8], '--body');
  assert.match(gh.args[9], /the new test fails on the old code/);
  assert.ok(!calls.some((c) => c.args.includes('merge')));
  assert.strictEqual(sh(root, 'rev-list', '--count', `main..${BRANCH}`), '1');
});

test('--pr with no github remote opens nothing and pushes nothing', async () => {
  const { root } = makeRepo({ remote: 'https://gitlab.com/acme/demo.git' });
  const calls = [];
  const deps = baseDeps(root, { run: (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; }, runBuilder: builderWriting({ 'lib/run.js': FIXED, 'test/fix.test.js': REGRESSION }), runChecker: checkerSaying('fixed') });
  const r = await capture(() => fixCommand([short, '--pr', '--verify', 'node --test test/*.test.js'], deps));
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /no pull request was opened: this repository has no github remote named origin. nothing was pushed/);
  assert.strictEqual(calls.length, 0);
});

test('atris models show a price first and spend nothing without a yes', async () => {
  const { root } = makeRepo();
  let quoted = null;
  const cloud = {
    ...require('../lib/sentinel-cloud'),
    quoteEstimate: async (est) => { quoted = est; return { rows: est.calls.map((r) => ({ ...r, credits_per_call: 2, credits: 2 * r.calls })), credits: 4, limits: {} }; },
  };
  let ran = 0;
  const deps = baseDeps(root, { cloud, token: 'test-token', hostedRun: async () => { ran += 1; return [{ ok: false }]; } });
  const r = await capture(() => fixCommand([short, '--engine', 'atris', '--verify', 'node --test test/*.test.js'], deps));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /this fix runs on atris models and costs at most 4 credits/);
  assert.match(r.out, /1 fix call on atris:fast/);
  assert.match(r.err, /nothing was spent/);
  assert.deepStrictEqual(quoted.calls.map((c) => c.role), ['builder', 'verifier']);
  assert.strictEqual(ran, 0);
  assert.strictEqual(fix.branchExists(root, BRANCH), false);
});

test('a hosted builder may not write outside the repo or into git', () => {
  const { root } = makeRepo();
  const allowed = new Set(['lib/run.js']);
  assert.strictEqual(fix.hostedWritable(root, 'lib/run.js', allowed), true);
  assert.strictEqual(fix.hostedWritable(root, 'test/new.test.js', allowed), true);
  assert.strictEqual(fix.hostedWritable(root, '../escape.js', allowed), false);
  assert.strictEqual(fix.hostedWritable(root, '.git/hooks/pre-commit', allowed), false);
  assert.strictEqual(fix.hostedWritable(root, '.env', allowed), false);
  assert.strictEqual(fix.hostedWritable(root, 'test/base.test.js', allowed), false);
});

test('with no id it lists confirmed findings only', async () => {
  const { root } = makeRepo();
  const r = await capture(() => fixCommand([], baseDeps(root)));
  assert.strictEqual(r.code, 0);
  assert.match(r.out, new RegExp(`${short}\\s+high\\s+Shell command built from the branch name`));
  assert.doesNotMatch(r.out, /not real/);
  assert.match(r.out, new RegExp(`fix one with: atris sentinel fix ${short}`));
});

test('test command detection', () => {
  const root = tmp('sentinel-fix-detect-');
  assert.strictEqual(fix.detectTestCommand(root), null);
  write(root, 'go.mod', 'module x\n');
  assert.strictEqual(fix.detectTestCommand(root), 'go test ./...');
  const py = tmp('sentinel-fix-detect-');
  write(py, 'pyproject.toml', '[tool.pytest.ini_options]\n');
  assert.strictEqual(fix.detectTestCommand(py), 'pytest');
  const npmDefault = tmp('sentinel-fix-detect-');
  write(npmDefault, 'package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.strictEqual(fix.detectTestCommand(npmDefault), null);
});

test('a builder that rewrites the test command is rejected', async () => {
  const { root } = makeRepo();
  const pkg = JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'exit 0' } });
  const deps = baseDeps(root, { runBuilder: builderWriting({ 'lib/run.js': FIXED, 'test/fix.test.js': REGRESSION, 'package.json': pkg }), runChecker: checkerSaying('fixed') });
  const r = await capture(() => fixCommand([short], deps));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /no fix was committed: the builder changed the test command itself/);
  assert.strictEqual(fix.branchExists(root, BRANCH), false);
});

test('a builder that switches the temp copy to your branch cannot touch it', async () => {
  const { root } = makeRepo();
  const mainBefore = sh(root, 'rev-parse', 'main');
  const runBuilder = async (job) => {
    execFileSync('git', ['checkout', '-q', '--ignore-other-worktrees', 'main'], { cwd: job.root });
    write(job.root, 'lib/run.js', FIXED);
    write(job.root, 'test/fix.test.js', REGRESSION);
    return { ok: true, stdout: '{"summary":"x"}' };
  };
  const r = await capture(() => fixCommand([short, '--verify', 'node --test test/*.test.js'], baseDeps(root, { runBuilder, runChecker: checkerSaying('fixed') })));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /no fix was committed: the builder committed or switched branches on its own/);
  assert.strictEqual(sh(root, 'rev-parse', 'main'), mainBefore);
  assert.strictEqual(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.strictEqual(fs.readFileSync(path.join(root, 'lib/run.js'), 'utf8'), VULNERABLE);
  assert.strictEqual(sh(root, 'status', '--porcelain'), '');
  assert.strictEqual(fix.branchExists(root, BRANCH), false);
});

test('a generated test that switches branches cannot get a commit onto your branch', async () => {
  const { root } = makeRepo();
  const mainBefore = sh(root, 'rev-parse', 'main');
  const sneaky = REGRESSION + "test('switch', () => { require('child_process').execFileSync('git', ['checkout', '-q', '--ignore-other-worktrees', 'main']); });\n";
  const deps = baseDeps(root, { runBuilder: builderWriting({ 'lib/run.js': FIXED, 'test/fix.test.js': sneaky }), runChecker: checkerSaying('fixed') });
  const r = await capture(() => fixCommand([short, '--verify', 'node --test test/*.test.js'], deps));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /a test committed or switched branches while it ran/);
  assert.strictEqual(sh(root, 'rev-parse', 'main'), mainBefore);
  assert.strictEqual(fix.branchExists(root, BRANCH), false);
});

test('files you create or edit in your checkout while the fix runs survive', async () => {
  for (const outcome of ['fails', 'lands']) {
    const { root } = makeRepo();
    const runBuilder = async (job) => {
      write(root, 'mine.txt', 'my notes');
      write(root, 'lib/run.js', `${VULNERABLE}// my edit\n`);
      write(job.root, 'lib/run.js', FIXED);
      write(job.root, 'test/fix.test.js', outcome === 'fails' ? WEAK_TEST : REGRESSION);
      return { ok: true, stdout: '{"summary":"x"}' };
    };
    const r = await capture(() => fixCommand([short, '--verify', 'node --test test/*.test.js'], baseDeps(root, { runBuilder, runChecker: checkerSaying('fixed') })));
    assert.strictEqual(r.code, outcome === 'fails' ? 1 : 0, r.out + r.err);
    assert.strictEqual(fs.readFileSync(path.join(root, 'mine.txt'), 'utf8'), 'my notes');
    assert.strictEqual(fs.readFileSync(path.join(root, 'lib/run.js'), 'utf8'), `${VULNERABLE}// my edit\n`);
    if (outcome === 'lands') {
      assert.strictEqual(sh(root, 'rev-list', '--count', `main..${BRANCH}`), '1');
      assert.strictEqual(sh(root, 'show', `${BRANCH}:lib/run.js`), FIXED.trim());
      assert.deepStrictEqual(sh(root, 'diff', '--name-only', `main...${BRANCH}`).split('\n').sort(), ['lib/run.js', 'test/fix.test.js']);
    }
  }
});

test('engines off the allow-list are refused, composer included', async () => {
  const { root } = makeRepo();
  const runBuilder = builderWriting({ 'lib/run.js': FIXED });
  for (const args of [['--verifier', 'composer'], ['--engine', 'local', '--verifier', 'composer'], ['--builder', 'cursor'], ['--verifier', 'atris-fast']]) {
    const r = await capture(() => fixCommand([short, ...args], baseDeps(root, { runBuilder })));
    assert.strictEqual(r.code, 2, args.join(' '));
    assert.match(r.err, /is not allowed. use codex, claude or an atris model/);
  }
  assert.strictEqual(runBuilder.calls.length, 0);
  assert.deepStrictEqual(fix.resolveFixEngines({ builder: 'codex', verifier: 'atris:pro', available: () => true }), { builder: 'codex', verifier: 'atris:pro' });
});

test('a test that fails on the old code only from a missing import is not proof', async () => {
  const withHelper = "'use strict';\nfunction isPlainName(n) { return /^[a-z0-9-]+$/.test(n); }\nfunction safeName(name) {\n  return typeof name === 'string' && isPlainName(name);\n}\nmodule.exports = { safeName, isPlainName };\n";
  const importsHelper = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { isPlainName } = require('../lib/run');\ntest('separator refused', () => { assert.strictEqual(isPlainName('x;rm'), false); });\n";
  const missingModule = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { check } = require('../lib/name-check');\ntest('separator refused', () => { assert.strictEqual(check('x;rm'), false); });\n";
  const cases = [
    { 'lib/run.js': withHelper, 'test/fix.test.js': importsHelper },
    { 'lib/run.js': FIXED, 'lib/name-check.js': "module.exports = { check: (n) => /^[a-z0-9-]+$/.test(n) };\n", 'test/fix.test.js': missingModule },
  ];
  for (const files of cases) {
    const { root } = makeRepo();
    const runChecker = checkerSaying('fixed');
    const r = await capture(() => fixCommand([short, '--verify', 'node --test test/*.test.js'], baseDeps(root, { runBuilder: builderWriting(files), runChecker })));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /the new test fails on the original code only because something is missing, broken or slow and not because a check failed/);
    assert.strictEqual(runChecker.calls.length, 0);
    assert.strictEqual(fix.branchExists(root, BRANCH), false);
  }
});

test('proof reading per runner', () => {
  assert.strictEqual(fix.realFailure('node', { code: 1, output: 'AssertionError [ERR_ASSERTION]: false !== true' }), true);
  assert.strictEqual(fix.realFailure('node', { code: 1, output: "Error: Cannot find module '../lib/x'" }), false);
  assert.strictEqual(fix.realFailure('node', { code: 1, output: 'AssertionError but also SyntaxError' }), false);
  assert.strictEqual(fix.realFailure('node', { code: 1, timedOut: true, output: 'AssertionError' }), false);
  assert.strictEqual(fix.realFailure('pytest', { code: 1, output: 'E       assert True is False\n1 failed' }), true);
  assert.strictEqual(fix.realFailure('pytest', { code: 2, output: 'E   ModuleNotFoundError: No module named x' }), false);
  assert.strictEqual(fix.realFailure('pytest', { code: 1, output: 'E   ImportError: cannot import name' }), false);
  assert.strictEqual(fix.realFailure('go', { code: 1, output: '--- FAIL: TestX (0.00s)\n    x_test.go:9: got true\nFAIL' }), true);
  assert.strictEqual(fix.realFailure('go', { code: 1, output: './x_test.go:5:2: undefined: IsPlain\nFAIL\tdemo [build failed]' }), false);
  assert.strictEqual(fix.realFailure('go', { code: 1, output: 'panic: test timed out after 10m0s' }), false);
  assert.strictEqual(fix.realFailure('node', { code: 1, output: 'something odd' }), false);
});

test('a push from a generated test fails and the test sees no credentials', async () => {
  const bare = tmp('sentinel-fix-bare-');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const { root } = makeRepo({ remote: bare });
  sh(root, 'push', '-q', 'origin', 'main');
  const record = path.join(tmp('sentinel-fix-rec-'), 'push.jsonl');
  const pusher = REGRESSION + `test('try to push', () => {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const a = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/leak'], { encoding: 'utf8' });
  const b = spawnSync('git', ['push', ${JSON.stringify(bare)}, 'HEAD:refs/heads/leak2'], { encoding: 'utf8' });
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ a: a.status, b: b.status, gh: process.env.GH_TOKEN || null, atris: process.env.ATRIS_TOKEN || null, aws: process.env.AWS_SECRET_ACCESS_KEY || null, db: process.env.DATABASE_URL || null, foo: process.env.FOO_URL || null, keys: Object.keys(process.env).sort(), home: process.env.HOME, prompt: process.env.GIT_TERMINAL_PROMPT }) + '\\n');
});
`;
  const deps = baseDeps(root, { runBuilder: builderWriting({ 'lib/run.js': FIXED, 'test/fix.test.js': pusher }), runChecker: checkerSaying('fixed') });
  deps.env = { ...deps.env, GH_TOKEN: 'fake-gh', ATRIS_TOKEN: 'fake-atris', AWS_SECRET_ACCESS_KEY: 'fake-aws', DATABASE_URL: 'postgres://app:hunter2@db.internal/prod', FOO_URL: 'https://someone:pw123@example.com/x', PIP_INDEX_URL: 'https://u:p@pypi.internal/simple' };
  const r = await capture(() => fixCommand([short, '--verify', 'node --test test/*.test.js'], deps));
  assert.strictEqual(r.code, 0, r.out + r.err);
  const rows = fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.notStrictEqual(row.a, 0, 'push to origin failed');
    assert.notStrictEqual(row.b, 0, 'push to a folder path failed');
    assert.strictEqual(row.gh, null);
    assert.strictEqual(row.atris, null);
    assert.strictEqual(row.aws, null);
    assert.notStrictEqual(row.home, deps.env.HOME);
    assert.strictEqual(row.prompt, '0');
    assert.strictEqual(row.db, null);
    assert.strictEqual(row.foo, null);
    assert.ok(!row.keys.includes('PIP_INDEX_URL'));
    const allowed = /^(?:PATH|TERM|LANG|LANGUAGE|LC_[A-Z_]+|VIRTUAL_ENV|HOME|USERPROFILE|TMPDIR|TMP|TEMP|CI|NODE_ENV|PYTHONDONTWRITEBYTECODE|GOPATH|GOCACHE|GIT_TERMINAL_PROMPT|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|NODE_TEST_CONTEXT|NODE_UNIQUE_ID|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PWD|OLDPWD|SHLVL|_|__CF_USER_TEXT_ENCODING)$/; // the last five are set by sh and macOS itself
    assert.deepStrictEqual(row.keys.filter((k) => !allowed.test(k)), [], 'only allow-listed names reach the test');
  }
  assert.strictEqual(spawnGit(bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/leak']).status, 1);
  assert.strictEqual(spawnGit(bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/leak2']).status, 1);
  assert.strictEqual(spawnGit(root, ['config', '--get', 'remote.origin.pushurl']).status, 1, 'your own push settings are unchanged');
});
