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

test('a scorecard closed in the evening is dated today', (t) => {
  const atrisDir = path.join(tempDir(t), 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  const file = runInLosAngelesEvening(`
    const { writeScorecard, getScorecardsPath } = require(process.env.ROOT + '/lib/scorecard');
    writeScorecard(${JSON.stringify(atrisDir)}, { slug: 'evening-endgame' });
    console.log(getScorecardsPath(${JSON.stringify(atrisDir)}));
  `);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\[2026-10-22\] evening-endgame/);
});

test("scorecard data counts tonight's journal and dates the end today", (t) => {
  const dir = path.join(tempDir(t), 'atris');
  fs.mkdirSync(path.join(dir, 'logs', '2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'TODO.md'), '# TODO\n\n## Backlog\n\n## In Progress\n\n## Completed\n');
  fs.writeFileSync(path.join(dir, 'lessons.md'), '# lessons\n\n- **[2026-10-22] tonight** - pass - learned\n');
  const out = runInLosAngelesEvening(`
    const { buildScorecardData } = require(process.env.ROOT + '/lib/scorecard');
    const data = buildScorecardData(${JSON.stringify(dir)}, { slug: 'x', pickedAt: '2026-10-22 21:00' });
    console.log(JSON.stringify(data));
  `);
  const data = JSON.parse(out);
  assert.equal(data.startDate, '2026-10-22');
  assert.equal(data.endDate, '2026-10-22');
  assert.equal(data.lessonsGenerated, 1);
});
