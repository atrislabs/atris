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

test('soul distill stamps the persona with the local day', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), '# lessons\n\n- keep replies short\n');
  runInLosAngelesEvening(`
    const { soul } = require(process.env.ROOT + '/commands/soul');
    soul(['distill']);
  `, dir);
  const persona = fs.readFileSync(path.join(dir, 'atris', 'PERSONA.md'), 'utf8');
  assert.match(persona, /<!-- Distilled 2026-10-22 \|/);
});
