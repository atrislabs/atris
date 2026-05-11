const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-code-review-test-'));
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

test('code-review --json missing engine returns JSON error', () => {
  const dir = makeTempDir();
  try {
    const result = runCli(['code-review', '--json'], dir);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      error: 'Review engine not found.',
      expected: 'atris/business/claude-code-review/workspace/review_engine.py',
      specialists: ['Security', 'Testing', 'Performance', 'Maintainability', 'Database', 'Async'],
      install: 'copy review_engine.py to your project',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review missing engine keeps human stderr', () => {
  const dir = makeTempDir();
  try {
    const result = runCli(['code-review', 'example.py'], dir);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Review engine not found/);
    assert.match(result.stderr, /copy review_engine\.py to your project/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review --all --json missing services returns JSON error', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'review_engine.py'), [
      '#!/usr/bin/env python3',
      'import json',
      'print(json.dumps({"findings": [], "quality_score": 10}))',
      '',
    ].join('\n'), { mode: 0o755 });

    const result = runCli(['code-review', '--all', '--json'], dir);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      error: 'No backend/services/ directory found.',
      expected: 'backend/services/',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review --all missing services keeps human stderr', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'review_engine.py'), [
      '#!/usr/bin/env python3',
      'import json',
      'print(json.dumps({"findings": [], "quality_score": 10}))',
      '',
    ].join('\n'), { mode: 0o755 });

    const result = runCli(['code-review', '--all'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Auditing all Python services/);
    assert.match(result.stderr, /No backend\/services\/ directory found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review --all --json returns audit summary JSON', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'review_engine.py'), [
      '#!/usr/bin/env python3',
      'import json',
      'print(json.dumps({"findings": [], "quality_score": 10}))',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'backend', 'services'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backend', 'services', 'demo.py'), 'print("ok")\n');

    const result = runCli(['code-review', '--all', '--json'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /AUDIT:/);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: 'code_review_all',
      services: 1,
      clean: 1,
      with_findings: 0,
      total_findings: 0,
      issues: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review --all keeps human audit summary', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'review_engine.py'), [
      '#!/usr/bin/env python3',
      'import json',
      'print(json.dumps({"findings": [], "quality_score": 10}))',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'backend', 'services'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backend', 'services', 'demo.py'), 'print("ok")\n');

    const result = runCli(['code-review', '--all'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Auditing all Python services/);
    assert.match(result.stdout, /AUDIT: 1 services/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
