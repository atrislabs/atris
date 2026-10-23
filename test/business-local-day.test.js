'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const business = path.join(__dirname, '..', 'commands', 'business.js');

// 05:30 UTC on Oct 23 is still the evening of Oct 22 in Los Angeles.
const FAKE_CLOCK = "const FIXED = Date.parse('2026-10-23T05:30:00Z'); const R = Date;"
  + ' global.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };';

function runAt(root, home, body) {
  return spawnSync(process.execPath, ['-e', `${FAKE_CLOCK} const b = require(${JSON.stringify(business)}); (async () => { ${body} })().catch((e) => { console.error(e); process.exit(1); });`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TZ: 'America/Los_Angeles', ATRIS_TOKEN: '', ATRIS_SKIP_UPDATE_CHECK: '1', CI: '1' },
  });
}

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-day-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(base, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return { home, root };
}

test('business share writes the handoff under the local day', (t) => {
  const { home, root } = workspace(t);
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ name: 'Evening Bakery', slug: 'evening-bakery' }), 'utf8');
  const res = runAt(root, home, "await b.shareBusinessWorkspace('--write', '--role', 'advisor');");
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(root, 'atris', 'reports', '2026-10-22-share-advisor.md')), res.stdout);
});

test('business onboard dates the starter brief by the local day', (t) => {
  const { home, root } = workspace(t);
  const res = runAt(root, home, "await b.onboardBusiness('--name', 'Evening Bakery');");
  assert.equal(res.status, 0, res.stderr);
  const brief = fs.readFileSync(path.join(root, 'atris', 'wiki', 'briefs', 'evening-bakery-starter-brief.md'), 'utf8');
  for (const field of ['last_compiled', 'created', 'updated']) {
    assert.match(brief, new RegExp(`\\n${field}: "?2026-10-22"?\\n`), brief);
  }
});
