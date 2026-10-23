'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { securityReviewCommand } = require('../commands/security-review');

function capture(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args) => { errs.push(args.map(String).join(' ')); };
  try {
    const code = fn();
    return { code, stdout: logs.join('\n'), stderr: errs.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-review-cmd-'));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = dir;
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('help and rules print the real command text and return 0', () => {
  const help = capture(() => securityReviewCommand(['--help']));
  assert.strictEqual(help.code, 0);
  assert.match(help.stdout, /atris security-review, deterministic secrets/);
  assert.match(help.stdout, /security-review --json/);
  assert.match(help.stdout, /exit 0 = clean, 1 = found/);

  const shortHelp = capture(() => securityReviewCommand(['-h']));
  assert.strictEqual(shortHelp.code, 0);
  assert.match(shortHelp.stdout, /security-review hook/);

  const namedHelp = capture(() => securityReviewCommand(['help']));
  assert.strictEqual(namedHelp.code, 0);
  assert.match(namedHelp.stdout, /--no-baseline/);

  const rules = capture(() => securityReviewCommand(['rules']));
  assert.strictEqual(rules.code, 0);
  assert.match(rules.stdout, /deterministic rules/);
  assert.match(rules.stdout, /CRITICAL\s+secret\s+github-token/);
  assert.match(rules.stdout, /atris-allow-secret/);
});

test('bad flags exit 2 and name the usage error', () => {
  const unknown = capture(() => securityReviewCommand(['--nope']));
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.stderr, /security-review: unknown flag: --nope/);

  const missing = capture(() => securityReviewCommand(['--baseline']));
  assert.strictEqual(missing.code, 2);
  assert.match(missing.stderr, /security-review: --baseline requires a path/);

  const clash = capture(() => securityReviewCommand(['--update-baseline', '--no-baseline']));
  assert.strictEqual(clash.code, 2);
  assert.match(clash.stderr, /security-review: --update-baseline cannot be combined with --no-baseline/);
});

test('json scan fails on a real key and passes when that file is clean', () => {
  withTempHome((dir) => {
    fs.writeFileSync(path.join(dir, 'leak.js'), 'const k = "AKIA4F7D9Q2L8W6R3P5S";\n');
    const bad = capture(() => securityReviewCommand(['.', '--json', '--no-record']));
    assert.strictEqual(bad.code, 1, bad.stderr);
    const report = JSON.parse(bad.stdout);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.generated_for, 'soc2-evidence');
    assert.strictEqual(report.fail_threshold, 'high');
    assert.strictEqual(report.scanned, 1);
    assert.ok(report.score >= 100);
    const hit = report.findings.find((f) => f.rule === 'aws-access-key-id');
    assert.ok(hit);
    assert.strictEqual(hit.sev, 'critical');
    assert.strictEqual(hit.file, 'leak.js');
    assert.strictEqual(hit.line, 1);

    fs.writeFileSync(path.join(dir, 'leak.js'), 'module.exports = 42;\n');
    const good = capture(() => securityReviewCommand(['.', '--json', '--no-record']));
    assert.strictEqual(good.code, 0, good.stderr);
    const clean = JSON.parse(good.stdout);
    assert.strictEqual(clean.ok, true);
    assert.deepStrictEqual(clean.findings, []);
    assert.strictEqual(clean.scanned, 1);
    assert.strictEqual(clean.score, 0);
  });
});

test('hook writes a pre-commit gate inside the temp dir and does not install twice', () => {
  withTempHome((dir) => {
    const installed = capture(() => securityReviewCommand(['hook']));
    assert.strictEqual(installed.code, 0);
    assert.match(installed.stdout, /security pre-commit gate installed/);
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    const hook = fs.readFileSync(hookPath, 'utf8');
    assert.match(hook, /# atris security gate/);
    assert.match(hook, /atris security-review --staged --quiet \|\| exit 1/);
    assert.strictEqual(fs.statSync(hookPath).mode & 0o111, 0o111);

    const again = capture(() => securityReviewCommand(['hook']));
    assert.strictEqual(again.code, 0);
    assert.match(again.stdout, /already installed/);
  });
});
