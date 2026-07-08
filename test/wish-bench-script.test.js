const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('wish-bench runs and holds the score floor', () => {
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'wish-bench.mjs'), '--json'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const report = JSON.parse(res.stdout);
  assert.equal(report.schema, 'atris.wish_bench.v1');
  assert.ok(report.cases >= 30);
  // Ratchet floor: 100% measured 2026-07-08. Raise this when the score
  // improves; never lower it.
  assert.ok(report.pct >= 95, `wish-bench regressed: ${report.pct}% is below the 95% floor`);
});
