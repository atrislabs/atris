'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const securityReview = path.join(__dirname, '..', 'commands', 'security-review.js');

// 05:30 UTC on Oct 23 is still the evening of Oct 22 in Los Angeles.
const FAKE_CLOCK = "const FIXED = Date.parse('2026-10-23T05:30:00Z'); const R = Date;"
  + ' global.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };';

test('security landing shows the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-security-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n', 'utf8');
  const code = `${FAKE_CLOCK} const { securityReviewCommand } = require(${JSON.stringify(securityReview)});`
    + " securityReviewCommand(['--land', '--no-record']);";
  const res = spawnSync(process.execPath, ['-e', code], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /security landing, 2026-10-22/);
});
