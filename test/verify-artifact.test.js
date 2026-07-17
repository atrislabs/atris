'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyArtifact } = require('../commands/verify');
const { parseVerifyCommand } = require('../lib/auto-accept-certified');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-artifact-'));
}

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return rel;
}

function silence(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

const REAL_BODY = Array.from({ length: 12 }, (_, i) => `The concept covers point ${i} in a full sentence about the restaurant.`).join('\n');

test('artifact verifier rejects missing, empty, and skeleton files that test -s allows', () => {
  const dir = tempDir();
  try {
    assert.equal(silence(() => verifyArtifact('ghost.md', { cwd: dir })), 1);
    const empty = write(dir, 'empty.md', '');
    assert.equal(silence(() => verifyArtifact(empty, { cwd: dir })), 1);
    // Headings and dividers only: non-empty (passes test -s) but no substance.
    const skeleton = write(dir, 'skeleton.md', '# Title\n\n## Section\n\n---\n\n## Another\n');
    assert.equal(silence(() => verifyArtifact(skeleton, { cwd: dir })), 1);
    const real = write(dir, 'real.md', `# Report\n\n${REAL_BODY}\n`);
    assert.equal(silence(() => verifyArtifact(real, { cwd: dir })), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact verifier rejects placeholder-dominated content', () => {
  const dir = tempDir();
  try {
    const stub = write(dir, 'stub.md', Array.from({ length: 12 }, (_, i) => `- TODO: fill in section ${i}`).join('\n'));
    assert.equal(silence(() => verifyArtifact(stub, { cwd: dir })), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('objective coverage passes on-topic artifacts and fails off-topic ones', () => {
  const dir = tempDir();
  const objective = 'Research SF restaurant locations with outdoor seating and sunset light for the orange concept';
  try {
    const onTopic = write(dir, 'on.md', `${REAL_BODY}\nSF restaurant locations with outdoor seating, sunset light, orange concept research.\n`);
    assert.equal(silence(() => verifyArtifact(onTopic, { cwd: dir, objective })), 0);
    const offTopic = write(dir, 'off.md', REAL_BODY);
    assert.equal(silence(() => verifyArtifact(offTopic, { cwd: dir, objective })), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('freshness window fails artifacts older than the mission window', () => {
  const dir = tempDir();
  try {
    const stale = write(dir, 'stale.md', REAL_BODY);
    const old = Date.now() / 1000 - 48 * 3600;
    fs.utimesSync(path.join(dir, stale), old, old);
    assert.equal(silence(() => verifyArtifact(stale, { cwd: dir, maxAgeHours: 24 })), 1);
    assert.equal(silence(() => verifyArtifact(stale, { cwd: dir, maxAgeHours: 96 })), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict verify allowlist accepts the artifact form with numeric flags only', () => {
  assert.equal(parseVerifyCommand('node bin/atris.js verify artifact atris/runs/week-one.md --min-lines 10 --json').ok, true);
  assert.equal(parseVerifyCommand('atris verify artifact atris/runs/week-one.md').ok, true);
  assert.equal(parseVerifyCommand('node bin/atris.js verify artifact /etc/passwd').ok, false);
  assert.equal(parseVerifyCommand('node bin/atris.js verify artifact ../outside.md').ok, false);
  assert.equal(parseVerifyCommand('node bin/atris.js verify artifact a.md --objective evil').ok, false);
  assert.equal(parseVerifyCommand('node bin/atris.js verify artifact a.md --min-lines ten').ok, false);
});

test('CLI form runs end to end with json output', () => {
  const dir = tempDir();
  try {
    const rel = write(dir, 'artifact.md', REAL_BODY);
    const result = spawnSync(process.execPath, [cliPath, 'verify', 'artifact', rel, '--json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.checks.some((check) => check.name === 'substance' && check.passed));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
