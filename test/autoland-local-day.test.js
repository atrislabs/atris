'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// 10:30 pm on Oct 22 in Los Angeles is already Oct 23 in UTC.
const FAKE_CLOCK = `
const RealDate = Date;
const FIXED = RealDate.parse('2026-10-23T05:30:00Z');
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
  static now() { return FIXED; }
}
global.Date = FakeDate;
`;

function runInLosAngelesEvening(body, cwd = ROOT) {
  const res = spawnSync(process.execPath, ['-e', FAKE_CLOCK + body], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles', ROOT, ATRIS_SKIP_UPDATE_CHECK: '1', CI: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-local-day-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the daily digest day is the local day', () => {
  const out = runInLosAngelesEvening(`
    const { localDay } = require(process.env.ROOT + '/lib/local-day');
    console.log(localDay());
  `);
  assert.equal(out, '2026-10-22');
  const src = fs.readFileSync(path.join(ROOT, 'commands', 'autoland.js'), 'utf8');
  const block = src.slice(src.indexOf('// 4. daily digest at the configured hour'));
  const todayLine = block.split('\n').find((line) => line.includes('const today ='));
  // The digest hour is read with getHours(), local; the day it compares must be local too.
  assert.match(todayLine, /localDay\(\)/);
});

test('the upgrade from UTC stamps neither repeats nor skips a digest', () => {
  const out = runInLosAngelesEvening(`
    const { digestSentToday } = require(process.env.ROOT + '/commands/autoland');
    const now = new Date();
    console.log(JSON.stringify([
      // sent tonight under the old UTC stamp: already sent, no second digest
      digestSentToday({ last_digest_date: '2026-10-23' }, now),
      // sent yesterday under the old stamp: due
      digestSentToday({ last_digest_date: '2026-10-22' }, now),
      // sent tonight under the new local stamp: already sent
      digestSentToday({ last_digest_date: '2026-10-22', last_digest_local: true }, now),
      // a local stamp from two days back: due
      digestSentToday({ last_digest_date: '2026-10-21', last_digest_local: true }, now),
      digestSentToday({}, now),
    ]));
  `);
  assert.deepEqual(JSON.parse(out), [true, false, true, false, false]);
});
