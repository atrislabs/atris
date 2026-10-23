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

test('orb scorecard counts picks by local day in the evening', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'now.md'), [
    '# Now',
    'orb: first day of the window · 2026-10-15',
    'orb: picked tonight · 2026-10-22',
    '',
  ].join('\n'), 'utf8');
  const mod = path.join(__dirname, '..', 'lib', 'orb-scorecard.js');
  const out = runInLosAngelesEvening(`
const card = require(${JSON.stringify(mod)}).readOrbScorecard(${JSON.stringify(root)}, { days: 7, now: Date.now() });
process.stdout.write(String(card.picks));
`);
  assert.equal(out, '2');
});
