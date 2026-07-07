// test/det.test.js — gate the deterministic task scripts under `node --test`.
// The real suite lives at scripts/det/test.js (self-contained, zero-dep) and is
// the source of truth. This wrapper runs it as a subprocess so the whole det
// library can't silently rot in CI: if any det check fails, this fails too.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const detSuite = path.join(repoRoot, 'scripts', 'det', 'test.js');

test('deterministic task scripts (scripts/det) pass their self-test', () => {
  const res = spawnSync(process.execPath, [detSuite], { encoding: 'utf8' });
  assert.equal(res.status, 0, `det self-test failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /checks passed/, 'expected the det suite to report passing checks');
});
