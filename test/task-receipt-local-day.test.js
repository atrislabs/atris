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

test('a task receipt written in the evening is named for the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-receipt-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const mod = path.join(__dirname, '..', 'lib', 'task-receipt.js');
  const out = runInLosAngelesEvening(`
const receipt = require(${JSON.stringify(mod)}).writeTaskReceipt({
  taskId: 'evening-check',
  command: 'true',
  root: ${JSON.stringify(root)},
  runner: () => ({ status: 0, stdout: '', stderr: '' }),
});
process.stdout.write(receipt.receiptPath);
`);
  assert.match(path.basename(out), /^2026-10-22-task-evening-check-/);
});
