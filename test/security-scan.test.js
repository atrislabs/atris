'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { scanLine, scanText, sensitiveFileFindings, runScan } = require('../lib/security-scan');
const cli = path.join(__dirname, '..', 'bin', 'atris.js');

function sevs(findings) { return findings.map((f) => f.rule).sort(); }

test('scanLine flags real high-severity secrets', () => {
  assert.deepEqual(sevs(scanLine('const k = "AKIA4F7D9Q2L8W6R3P5S";')), ['aws-access-key-id']);
  assert.equal(scanLine('token = "ghp_Y7qP2mN8vR4tL6zX9cB3sD5fH1jK0wE2aG9R6tV5"')[0].rule, 'github-token');
  assert.equal(scanLine('OPENAI="sk-T7qP2mN8vR4tL6zX9cB3sD5fH1jK0wE2aG9R6tV5"')[0].rule, 'openai-key');
  assert.equal(scanLine('-----BEGIN RSA PRIVATE KEY-----')[0].sev, 'critical');
  assert.equal(scanLine('const clientSecret = "9qR4xZ7nP2mV8sT5kL0bC3dF6hJ1wE";')[0].rule, 'assigned-secret');
});

test('scanLine ignores placeholders and env reads (no false-positive secrets)', () => {
  assert.deepEqual(scanLine('const apiKey = process.env.API_KEY;'), []);
  assert.deepEqual(scanLine('password: "your-password-here"'), []);
  assert.deepEqual(scanLine('// example: api_key = "xxxxxxxxxxxx"'), []);
  assert.deepEqual(scanLine('token = "<your-token>"'), []);
  assert.deepEqual(scanLine('token = "xoxb-should-not-leak"'), []);
  assert.deepEqual(scanLine('token = "xoxb-fixture-token"'), []);
  assert.deepEqual(scanLine("clientSecret:'secret_yyy'"), []);
  // split so this test file does not itself contain a contiguous secret literal
  // (GitHub push protection scans source text; the runtime value is unchanged)
  assert.deepEqual(scanLine('STRIPE="sk_live_' + 'AbCdEf1234567890AbCdEf1234567890"'), []);
  assert.deepEqual(scanLine('OPENAI="sk-test1234567890abcdefghijklmno"'), []);
  assert.deepEqual(scanLine('const k = "AKIA1234567890ABCDEF";'), []);
  assert.deepEqual(scanLine('const password = "hunter2hunter2";'), []);
});

test('scanLine respects an inline suppression marker', () => {
  assert.deepEqual(scanLine('const k = "AKIA1234567890ABCDEF"; // atris-allow-secret'), []);
});

test('scanLine flags personal home paths but not CI/system paths', () => {
  assert.equal(scanLine('cwd: /Users/someuser/arena/some-project')[0].rule, 'home-path');
  assert.equal(scanLine('path = /home/jdoe/secret/app')[0].rule, 'home-path');
  assert.deepEqual(scanLine('runner at /home/runner/work/repo'), []);
  assert.deepEqual(scanLine('install to /Users/runner/app'), []);
});

test('email rule is low-severity and skips role addresses', () => {
  assert.equal(scanLine('contact: alice.personal@gmail.com')[0].sev, 'low');
  assert.deepEqual(scanLine('support@acme.com for help'), []);
  assert.deepEqual(scanLine('reach noreply@service.io'), []);
  assert.deepEqual(scanLine('user@example.com is a placeholder'), []);
});

test('sensitiveFileFindings flags tracked secret files but allows .env.example', () => {
  const f = sensitiveFileFindings(['.env', 'src/app.js', 'keys/id_rsa', 'config/.env.example', 'certs/server.pem']);
  assert.deepEqual(f.map((x) => x.file).sort(), ['.env', 'certs/server.pem', 'keys/id_rsa']);
  assert.ok(f.every((x) => x.sev === 'high'));
});

test('runScan over a temp tree finds planted secrets + sensitive files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const k = "AKIA4F7D9Q2L8W6R3P5S";\nconst safe = process.env.TOKEN;\n');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=abc123\n');
    fs.writeFileSync(path.join(dir, 'clean.js'), 'module.exports = 1;\n');
    const { findings, counts } = runScan({ root: dir });
    const rules = new Set(findings.map((f) => f.rule));
    assert.ok(rules.has('aws-access-key-id'), 'should find the AWS key');
    assert.ok(rules.has('tracked-sensitive-file'), 'should flag the tracked .env');
    assert.equal(counts.critical, 1);
    assert.equal(counts.high, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runScan skips fixture and snapshot directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-fixture-'));
  try {
    fs.mkdirSync(path.join(dir, 'fixtures'));
    fs.mkdirSync(path.join(dir, '__snapshots__'));
    fs.writeFileSync(path.join(dir, 'fixtures', 'leak.js'), 'const k = "AKIA4F7D9Q2L8W6R3P5S";\n');
    fs.writeFileSync(path.join(dir, '__snapshots__', 'leak.js'), 'const k = "AKIA4F7D9Q2L8W6R3P5S";\n');
    fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
    const { findings } = runScan({ root: dir });
    assert.deepEqual(findings.filter((f) => f.rule === 'aws-access-key-id'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits 1 on a high finding and 0 when clean (--json)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'leak.js'), 'const k = "AKIA4F7D9Q2L8W6R3P5S";\n');
    const bad = spawnSync(process.execPath, [cli, 'security-review', '.', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    const report = JSON.parse(bad.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((f) => f.rule === 'aws-access-key-id'));

    fs.writeFileSync(path.join(dir, 'leak.js'), 'module.exports = 42;\n');
    const good = spawnSync(process.execPath, [cli, 'security-review', '.', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.equal(JSON.parse(good.stdout).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('baseline update suppresses accepted fingerprints and --no-baseline ignores it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-baseline-'));
  try {
    fs.writeFileSync(path.join(dir, 'leak.js'), 'const clientSecret = "9qR4xZ7nP2mV8sT5kL0bC3dF6hJ1wE";\n');

    const bad = spawnSync(process.execPath, [cli, 'security-review', '.', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);

    const update = spawnSync(process.execPath, [cli, 'security-review', '.', '--update-baseline', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(update.status, 0, update.stdout + update.stderr);
    const updated = JSON.parse(update.stdout);
    assert.equal(updated.ok, true);
    assert.equal(updated.suppressed, 1);
    assert.equal(updated.baseline.updated, true);
    assert.ok(fs.existsSync(path.join(dir, '.security-review.baseline.json')));

    const rerun = spawnSync(process.execPath, [cli, 'security-review', '.', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).suppressed, 1);

    const noBaseline = spawnSync(process.execPath, [cli, 'security-review', '.', '--no-baseline', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(noBaseline.status, 1, noBaseline.stdout + noBaseline.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--deep prints the structured model-review framework with deterministic evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-deep-'));
  try {
    fs.writeFileSync(path.join(dir, 'clean.js'), 'module.exports = 1;\n');
    const res = spawnSync(process.execPath, [cli, 'security-review', '.', '--deep'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Atris Deep Security Review/);
    assert.match(res.stdout, /secrets & keys/);
    assert.match(res.stdout, /who-can-do-what/);
    assert.match(res.stdout, /PASS or CONCERN/);
    assert.match(res.stdout, /Deterministic evidence/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanLine flags code-execution risks but not prose mentions', () => {
  assert.equal(scanLine('const out = eval(userInput);')[0].rule, 'eval-call');
  assert.equal(scanLine('const out = eval(userInput);')[0].sev, 'medium');
  assert.equal(scanLine('const f = new Function("return 1");')[0].rule, 'new-function');
  assert.equal(scanLine('execSync(`git log ${ref}`)')[0].rule, 'shell-exec-interpolation');
  assert.equal(scanLine('spawn(cmd, args, { shell: true })')[0].rule, 'child-process-shell-true');
  // prose / safe usage must NOT trip the gate
  assert.deepEqual(scanLine('the held-out eval (generalization, not memorization)'), []);
  assert.deepEqual(scanLine('execFileSync("git", ["log", ref])'), []);
});

test('code-execution rules only apply to code files, not docs', () => {
  const { scanFile } = require('../lib/security-scan');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-code-'));
  try {
    fs.writeFileSync(path.join(dir, 'note.md'), 'You can use eval(x) to run code.\n');
    assert.deepEqual(scanFile(path.join(dir, 'note.md')), []);
    fs.writeFileSync(path.join(dir, 'run.js'), 'eval(x)\n');
    assert.equal(scanFile(path.join(dir, 'run.js'))[0].rule, 'eval-call');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('security landing: records runs and reports a clean, decision-ready summary', () => {
  const lib = require('../lib/security-scan');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-land-'));
  try {
    // run 1: a real finding is open -> HOLD, nothing fixed yet
    const open = { findings: [{ rule: 'aws-access-key-id', sev: 'critical', cat: 'secret', file: 'a.js', line: 1, why: 'x', fingerprint: 'fp1' }], counts: { critical: 1, high: 0, medium: 0, low: 0 }, scanned: 1, suppressed: 0 };
    let landing = lib.buildLanding(dir, open, { failOn: 'high' });
    assert.equal(landing.cleared, false);
    assert.equal(landing.open.length, 1);
    lib.recordRun(dir, open, { failOn: 'high' });

    // run 2: the finding is gone -> CLEARED, fixed 1
    const clean = { findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 }, scanned: 1, suppressed: 0 };
    landing = lib.buildLanding(dir, clean, { failOn: 'high' });
    assert.equal(landing.cleared, true);
    assert.equal(landing.fixed, 1);
    assert.equal(landing.appeared, 0);
    lib.recordRun(dir, clean, { failOn: 'high' });

    // ledger has both runs
    assert.equal(lib.loadLedger(dir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --land prints the landing report and gates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-land-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'leak.js'), 'const k = "' + 'AKIA' + 'ZX7QWP2KMR4VT9BH' + '";\n');
    const hold = spawnSync(process.execPath, [cli, 'security-review', '--land'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(hold.status, 1, hold.stdout + hold.stderr);
    assert.match(hold.stdout, /security landing/);
    assert.match(hold.stdout, /HOLD/);
    assert.match(hold.stdout, /needs you:/);

    fs.writeFileSync(path.join(dir, 'leak.js'), 'module.exports = 1;\n');
    const cleared = spawnSync(process.execPath, [cli, 'security-review', '--land'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
    assert.match(cleared.stdout, /CLEARED TO SHIP/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
