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

test('an evening sweep escalates a late loop under the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mod = path.join(__dirname, '..', 'commands', 'close.js');
  const out = runInLosAngelesEvening(`
const close = require(${JSON.stringify(mod)});
const cwd = ${JSON.stringify(root)};
const quiet = console.log; console.log = () => {};
close.run(['add', 'Approve payroll', '--owner', 'you', '--ttl', '1', '--when', 'payroll is approved'], { cwd, now: '2026-10-20T05:30:00Z' });
console.log = quiet;
close.sweepState(cwd, new Date());
const days = close.foldEvents(close.readEvents(cwd), { now: new Date() }).map((f) => f.escalated_days);
process.stdout.write(JSON.stringify(days));
`);
  assert.deepEqual(JSON.parse(out), [['2026-10-22']]);
});
