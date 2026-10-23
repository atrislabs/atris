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

test('a stale wiki page reports the source change on the local day', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'src.txt'), 'changed\n');
  const changedAt = new Date('2026-10-23T05:30:00Z');
  fs.utimesSync(path.join(dir, 'src.txt'), changedAt, changedAt);
  const page = path.join(dir, 'page.md');
  fs.writeFileSync(page, '---\nlast_compiled: 2026-10-20\nsources:\n  - src.txt\n---\n\n# Page\n');
  const out = runInLosAngelesEvening(`
    const { checkPageStaleness } = require(process.env.ROOT + '/commands/clean');
    const res = checkPageStaleness(${JSON.stringify(dir)}, ${JSON.stringify(page)});
    console.log(res && res.sourceDate);
  `);
  assert.equal(out, '2026-10-22');
});
