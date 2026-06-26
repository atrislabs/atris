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
  assert.deepEqual(sevs(scanLine('const k = "AKIA1234567890ABCDEF";')), ['aws-access-key-id']);
  assert.equal(scanLine('token = "ghp_' + 'a'.repeat(36) + '"')[0].rule, 'github-token');
  assert.equal(scanLine('OPENAI="sk-' + 'a'.repeat(24) + '"')[0].rule, 'openai-key');
  assert.equal(scanLine('-----BEGIN RSA PRIVATE KEY-----')[0].sev, 'high');
  assert.equal(scanLine('const password = "hunter2hunter2";')[0].rule, 'assigned-secret');
});

test('scanLine ignores placeholders and env reads (no false-positive secrets)', () => {
  assert.deepEqual(scanLine('const apiKey = process.env.API_KEY;'), []);
  assert.deepEqual(scanLine('password: "your-password-here"'), []);
  assert.deepEqual(scanLine('// example: api_key = "xxxxxxxxxxxx"'), []);
  assert.deepEqual(scanLine('token = "<your-token>"'), []);
});

test('scanLine respects an inline suppression marker', () => {
  assert.deepEqual(scanLine('const k = "AKIA1234567890ABCDEF"; // atris-allow-secret'), []);
});

test('scanLine flags personal home paths but not CI/system paths', () => {
  assert.equal(scanLine('cwd: /Users/keshavrao/arena/atris-cli')[0].rule, 'home-path');
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
    fs.writeFileSync(path.join(dir, 'app.js'), 'const k = "AKIA1234567890ABCDEF";\nconst safe = process.env.TOKEN;\n');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=abc123\n');
    fs.writeFileSync(path.join(dir, 'clean.js'), 'module.exports = 1;\n');
    const { findings, counts } = runScan({ root: dir });
    const rules = new Set(findings.map((f) => f.rule));
    assert.ok(rules.has('aws-access-key-id'), 'should find the AWS key');
    assert.ok(rules.has('tracked-sensitive-file'), 'should flag the tracked .env');
    assert.ok(counts.high >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits 1 on a high finding and 0 when clean (--json)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'leak.js'), 'const k = "AKIA1234567890ABCDEF";\n');
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
