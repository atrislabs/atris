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

test('the daily experiment counts an evening run as today', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'experiments-daily.json'), JSON.stringify({ last_run_date: '2026-10-22', history: [] }));
  const out = runInLosAngelesEvening(`
    const { runDaily } = require(process.env.ROOT + '/lib/experiments/daily');
    runDaily(${JSON.stringify(dir)}, ['--json']);
  `);
  assert.equal(JSON.parse(out).reason, 'already_ran_today');
});
