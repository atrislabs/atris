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

test('an x search saved in the evening is dated with the local day', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-xsearch-day-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const mod = path.join(__dirname, '..', 'commands', 'x-search.js');
  const out = runInLosAngelesEvening(`
const xs = require(${JSON.stringify(mod)});
console.log = () => {};
const code = xs.xSearchCommand(['agent memory', '--save'], {
  cwd: ${JSON.stringify(cwd)},
  output: () => {},
  ensureValidCredentials: async () => ({ credentials: { token: 't', agent_token: 't', agent_token_scopes: ['x-search', 'youtube'], agent_token_expires_at: '2099-01-01T00:00:00Z' } }),
  apiRequestJson: async () => ({
    ok: true,
    status: 200,
    data: { status: 'success', credits_used: 5, credits_remaining: 995, data: { content: '37signals has 80 people and uses the omakase model', citations: ['https://x.com/levelsio/status/1'] } },
  }),
});
Promise.resolve(code).then(() => process.stdout.write(xs.xSearchBriefRel('agent memory')));
`);
  const rel = out.trim();
  assert.match(fs.readFileSync(path.join(cwd, rel), 'utf8'), /^date: 2026-10-22$/m);
  assert.ok(fs.existsSync(path.join(cwd, 'atris', 'logs', '2026', '2026-10-22.md')));
});
