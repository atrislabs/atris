'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const land = path.join(__dirname, '..', 'commands', 'land.js');

// 05:30 UTC on Oct 23 is still the evening of Oct 22 in Los Angeles.
const FAKE_CLOCK = "const FIXED = Date.parse('2026-10-23T05:30:00Z'); const R = Date;"
  + ' global.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };';

test('reap backups go under the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const code = `${FAKE_CLOCK} const { salvageDir } = require(${JSON.stringify(land)});`
    + ` process.stdout.write(salvageDir(${JSON.stringify(root)}));`;
  const res = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, path.join(root, '.atris', 'salvage', '2026-10-22'));
  assert.ok(fs.existsSync(res.stdout));
});
