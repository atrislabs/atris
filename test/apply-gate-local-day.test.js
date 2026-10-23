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

test('an apply note filed in the evening lands in the local day journal', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-day-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki', 'briefs'), { recursive: true });
  const mod = path.join(__dirname, '..', 'lib', 'apply-gate.js');
  runInLosAngelesEvening(`
require(${JSON.stringify(mod)}).ensureApply({
  cwd: ${JSON.stringify(cwd)},
  source: 'https://youtu.be/evening01',
  rel: 'atris/wiki/briefs/youtube-evening01.apply.md',
  output: () => {},
  incompleteMessage: 'next: apply it',
  required: false,
  change: 'apply atris/experiments/notes-evening01',
  receipt: 'keep only if measure.py moves 0 to 1',
});
`);
  const logs = fs.readdirSync(path.join(cwd, 'atris', 'logs', '2026'));
  assert.deepEqual(logs, ['2026-10-22.md']);
});
