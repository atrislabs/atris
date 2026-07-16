const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveDefaultVerifier } = require('../lib/default-verifier');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-default-verifier-'));
}

// Proven footgun (2026-07-16): a broad suite auto-selected as a mission's
// default verifier (`npm test`, which here runs backend/scripts/test_fast.sh)
// fails without its env and killed missions after two ticks. Callers that
// FREEZE a mission default must opt out of broad-suite detection.
test('mission-lane default (allowBroadSuite:false) never freezes a broad suite', () => {
  const root = tmpRepo();
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'bash scripts/test_fast.sh' } }),
    );
    fs.mkdirSync(path.join(root, 'test'));
    // With broad suites allowed (fleet/wish default) it would pick npm test...
    assert.equal(resolveDefaultVerifier(root), 'npm test');
    // ...but the mission lane must fall back to the always-safe check.
    assert.equal(resolveDefaultVerifier(root, { allowBroadSuite: false }), 'git diff --check');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Default behavior (no opts) is unchanged so fleet/wish keep the suite.
test('default behavior still prefers a declared test suite', () => {
  const root = tmpRepo();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    assert.equal(resolveDefaultVerifier(root), 'npm test');
    fs.rmSync(path.join(root, 'package.json'));
    fs.mkdirSync(path.join(root, 'test'));
    assert.equal(resolveDefaultVerifier(root), 'node --test');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A repo with no suite always lands on the safe baseline, both modes.
test('no suite present yields git diff --check in both modes', () => {
  const root = tmpRepo();
  try {
    assert.equal(resolveDefaultVerifier(root), 'git diff --check');
    assert.equal(resolveDefaultVerifier(root, { allowBroadSuite: false }), 'git diff --check');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
