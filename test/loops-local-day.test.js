'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 05:30 UTC on Oct 23 is 22:30 on Oct 22 in Los Angeles: the evening, when
// the UTC day is already tomorrow.
const FAKE_NOW = '2026-10-23T05:30:00Z';

function runInLosAngelesEvening(body) {
  const clock = `
const RealDate = Date;
const FIXED = RealDate.parse(${JSON.stringify(FAKE_NOW)});
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED])); }
  static now() { return FIXED; }
};
`;
  const res = spawnSync(process.execPath, ['-e', clock + body], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles', ATRIS_SKIP_UPDATE_CHECK: '1', CI: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

const mod = path.join(__dirname, '..', 'commands', 'loops.js');

test('loops init in the evening dates the first receipt with the local day', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loops-day-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  runInLosAngelesEvening(`
console.log = () => {};
process.chdir(${JSON.stringify(ws)});
require(${JSON.stringify(mod)}).loopsCommand('init');
`);
  const quality = fs.readFileSync(path.join(ws, 'atris', 'loops', 'quality.md'), 'utf8');
  assert.match(quality, /- 2026-10-22: TODO: first loop scaffold created/);
});

test('loops stop in the evening records the local day it was stopped', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loops-day-hb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
    jobs: [{ id: 'demo-loop', purpose: 'demo', command: 'true', cadence_minutes: 15, enabled: true }],
  }));
  runInLosAngelesEvening(`
console.log = () => {};
process.env.ATRIS_HEARTBEAT_DIR = ${JSON.stringify(dir)};
require(${JSON.stringify(mod)}).loopsCommand('stop', 'demo-loop');
`);
  const registry = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  assert.equal(registry.jobs[0].disabled_reason, 'stopped via atris loops 2026-10-22');
});
