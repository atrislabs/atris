'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const member = path.join(__dirname, '..', 'commands', 'member.js');

// A log with no date in its name is dated by its last write, on the local day
// like the journal names next to it. 05:30 UTC on Oct 23 is still the evening
// of Oct 22 in Los Angeles.
test('an undated log is dated by the local day of its last write', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-log-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'goals.md');
  fs.writeFileSync(file, '# goals\n', 'utf8');
  const written = new Date('2026-10-23T05:30:00Z');
  fs.utimesSync(file, written, written);
  const code = `const { logDateForScan } = require(${JSON.stringify(member)});`
    + ` process.stdout.write(String(logDateForScan('atris/team/ada/goals.md', ${JSON.stringify(file)})));`;
  const res = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '2026-10-22');
});
