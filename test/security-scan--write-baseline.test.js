'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeBaseline, loadBaseline, findingFingerprint, DEFAULT_BASELINE,
} = require('../lib/security-scan');

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atris-sec-baseline-${tag}-`));
}

test('writeBaseline writes sorted, de-duplicated fingerprints to the default file', () => {
  const root = tmpRoot('normal');
  try {
    const findings = [
      { rule: 'github-token', cat: 'secret', file: 'b.js', snippet: 'token = "x"', sev: 'critical', fingerprint: 'fp-b' },
      { rule: 'aws-access-key-id', cat: 'secret', file: 'a.js', snippet: 'k = "y"', sev: 'critical', fingerprint: 'fp-a' },
      { rule: 'github-token', cat: 'secret', file: 'c.js', snippet: 'z', sev: 'critical', fingerprint: 'fp-b' },
    ];

    const result = writeBaseline(root, findings);

    assert.equal(result.file, path.join(root, DEFAULT_BASELINE));
    assert.deepEqual(result.fingerprints, ['fp-a', 'fp-b']);

    const raw = fs.readFileSync(result.file, 'utf8');
    assert.ok(raw.endsWith('}\n'), 'file ends with a closing brace and newline');
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed), ['generated_at', 'fingerprints']);
    assert.deepEqual(parsed.fingerprints, ['fp-a', 'fp-b']);
    assert.equal(raw, JSON.stringify(parsed, null, 2) + '\n', 'two-space json with trailing newline');

    // generated_at is a real ISO timestamp; checked by shape, never by the clock.
    assert.equal(new Date(parsed.generated_at).toISOString(), parsed.generated_at);

    // Round-trip: what writeBaseline writes, loadBaseline reads back.
    assert.deepEqual(loadBaseline(root).fingerprints, ['fp-a', 'fp-b']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeBaseline computes a fingerprint for findings that lack one, and handles empty input', () => {
  const root = tmpRoot('edge');
  try {
    const bare = { rule: 'aws-access-key-id', cat: 'secret', file: 'src/x.js', snippet: 'const k = "AKIA"', sev: 'critical' };
    const expected = findingFingerprint(bare);

    const withComputed = writeBaseline(root, [bare]);
    assert.deepEqual(withComputed.fingerprints, [expected]);
    assert.match(expected, /^[0-9a-f]{64}$/, 'fingerprint is a sha256 hex digest');

    // Empty list (and the default argument) writes a valid empty baseline.
    const empty = writeBaseline(root, []);
    assert.deepEqual(empty.fingerprints, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(empty.file, 'utf8')).fingerprints, []);

    const noArgs = writeBaseline(root);
    assert.deepEqual(noArgs.fingerprints, []);
    assert.equal(noArgs.file, path.join(root, DEFAULT_BASELINE));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeBaseline honours an absolute baseline path outside the root', () => {
  const root = tmpRoot('abs-root');
  const elsewhere = tmpRoot('abs-target');
  try {
    const target = path.join(elsewhere, 'custom.baseline.json');
    const result = writeBaseline(root, [{ fingerprint: 'fp-only' }], target);

    assert.equal(result.file, target);
    assert.equal(fs.existsSync(path.join(root, DEFAULT_BASELINE)), false, 'root default file not created');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).fingerprints, ['fp-only']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('writeBaseline throws when the target directory does not exist', () => {
  const root = tmpRoot('missing');
  try {
    const missingDir = path.join(root, 'no-such-dir');
    assert.throws(
      () => writeBaseline(missingDir, [{ fingerprint: 'fp' }]),
      (err) => err && err.code === 'ENOENT',
    );
    assert.equal(fs.existsSync(missingDir), false, 'nothing created for the missing directory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
