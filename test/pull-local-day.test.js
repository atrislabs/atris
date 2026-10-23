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

test('an evening pull asks for the last three local journal days', () => {
  const api = path.join(__dirname, '..', 'utils', 'api.js');
  const mod = path.join(__dirname, '..', 'commands', 'pull.js');
  const out = runInLosAngelesEvening(`
const seen = [];
console.log = () => {};
require(${JSON.stringify(api)}).apiRequestJson = async (p) => { seen.push(p); return { ok: false }; };
require(${JSON.stringify(mod)}).pullGeneralJournal('token', 'agent-1').then(() => {
  process.stdout.write(JSON.stringify(seen));
});
`);
  assert.deepEqual(JSON.parse(out), [
    '/agents/agent-1/journal/2026-10-22',
    '/agents/agent-1/journal/2026-10-21',
    '/agents/agent-1/journal/2026-10-20',
  ]);
});
