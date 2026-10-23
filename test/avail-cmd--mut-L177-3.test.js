'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Fresh home so a dry-run preview cannot touch this machine.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-cmd-mut-L177-3-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { availCommand } = require('../commands/avail');

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function run(argv) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  let code;
  try {
    code = await availCommand(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('availCommand set preview lists Sunday when Sunday is the only open day', async () => {
  const res = await run(['set', '--wake', '9am', '--sleep', '5pm', '--tz', 'UTC', '--days', 'sun']);
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  assert.equal(res.stdout, [
    '\u{1F4C5} Availability preview',
    '',
    '  timezone: UTC',
    '  awake: 9am \u2192 5pm (sun)',
    '',
    '  weekly windows:',
    '  Mon: off',
    '  Tue: off',
    '  Wed: off',
    '  Thu: off',
    '  Fri: off',
    '  Sat: off',
    '  Sun: 9am\u20135pm',
    '',
    '  Dry run, add --apply to push to your profile.',
  ].join('\n'));
});
