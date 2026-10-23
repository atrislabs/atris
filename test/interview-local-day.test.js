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

test('an evening interview reads today and yesterday from the local journal', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-interview-day-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ws = path.join(base, 'ws');
  const bin = path.join(base, 'bin');
  const promptFile = path.join(base, 'prompt.txt');
  fs.mkdirSync(path.join(ws, 'atris', 'logs', '2026'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'atris', 'logs', '2026', '2026-10-22.md'), '# today\n');
  fs.writeFileSync(path.join(ws, 'atris', 'logs', '2026', '2026-10-21.md'), '# yesterday\n');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(promptFile)}\n`, { mode: 0o755 });
  const mod = path.join(__dirname, '..', 'commands', 'interview.js');
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; });
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  runInLosAngelesEvening(`
console.log = () => {};
require(${JSON.stringify(mod)}).interviewCommand(['me', '--yes'], ${JSON.stringify(ws)}).then((code) => process.exit(code));
`);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /2026-10-22\.md/);
  assert.match(prompt, /2026-10-21\.md/);
});
