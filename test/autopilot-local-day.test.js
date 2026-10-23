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

test('a lesson attempted in the evening is stamped with the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autopilot-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mod = path.join(__dirname, '..', 'commands', 'autopilot.js');
  runInLosAngelesEvening(`require(${JSON.stringify(mod)}).markLessonAttempted(${JSON.stringify(root)}, 'evening-lesson', 'tried');`);
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'lessons.json'), 'utf8'));
  assert.equal(meta['evening-lesson'].last_attempt, '2026-10-22');
});
