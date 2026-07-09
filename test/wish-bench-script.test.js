const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

test('wish-bench runs and holds the score floor', () => {
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'wish-bench.mjs'), '--json'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', PATH: systemPath },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const report = JSON.parse(res.stdout);
  assert.equal(report.schema, 'atris.wish_bench.v1');
  assert.ok(report.cases >= 30);
  // Ratchet floor: 100% measured 2026-07-08. Raise this when the score
  // improves; never lower it.
  assert.ok(report.pct >= 95, `wish-bench regressed: ${report.pct}% is below the 95% floor`);
});

test('wish-bench can load an external JSON case array', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-bench-cases-'));
  try {
    const casesPath = path.join(dir, 'cases.json');
    fs.writeFileSync(casesPath, JSON.stringify([
      { id: 'X1', wish: 'hook up search and make it fast', expect: { parts: null } },
      { id: 'X2', wish: 'smoke test the publish flow before the tag', expect: { testCmd: true } },
    ], null, 2), 'utf8');
    const res = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'wish-bench.mjs'),
      '--json',
      '--cases',
      casesPath,
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const report = JSON.parse(res.stdout);
    assert.equal(report.schema, 'atris.wish_bench.v1');
    assert.equal(report.cases, 2);
    assert.equal(report.pass, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
