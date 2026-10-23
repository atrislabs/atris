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

function findPicked(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.claude') {
      const hit = findPicked(full);
      if (hit) return hit;
    } else if (entry.isFile() && entry.name === 'TODO.md') {
      const match = fs.readFileSync(full, 'utf8').match(/\*\*Picked:\*\* (\S+)/);
      if (match) return match[1];
    }
  }
  return null;
}

test('a workspace set up in the evening stamps today with the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mod = path.join(__dirname, '..', 'commands', 'sync.js');
  runInLosAngelesEvening(`
console.log = () => {};
require(${JSON.stringify(mod)}).syncWorkspaceTemplate(${JSON.stringify(root)}, {
  name: 'Evening Co', slug: 'evening', business_id: 'biz-evening', workspace_id: 'ws-evening',
}, { templateName: 'business' });
`);
  assert.equal(findPicked(root), '2026-10-22');
});
