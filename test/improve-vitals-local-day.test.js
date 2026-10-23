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

test('vitals page lists loops closed earlier in the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-vitals-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const close = path.join(__dirname, '..', 'commands', 'close.js');
  const vitals = path.join(__dirname, '..', 'lib', 'improve-vitals-html.js');
  const html = runInLosAngelesEvening(`
const close = require(${JSON.stringify(close)});
const cwd = ${JSON.stringify(root)};
const quiet = console.log; console.log = () => {};
// 13:00 in Los Angeles on Oct 22, the same local day as the fake evening clock.
close.run(['add', 'Approve payroll', '--owner', 'you', '--ttl', '3'], { cwd, now: '2026-10-22T19:00:00Z' });
close.run(['done', close.closeIdForWhat('Approve payroll')], { cwd, now: '2026-10-22T20:00:00Z' });
console.log = quiet;
process.stdout.write(require(${JSON.stringify(vitals)}).renderVitalsHtml(cwd, { collectImproveVitals: () => ({}) }));
`);
  assert.match(html, /<li class="done"><span class="lane">closed<\/span>Approve payroll<\/li>/);
});
