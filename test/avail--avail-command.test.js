'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert');

// Point HOME at a throwaway dir and drop ATRIS_* so nothing reads this machine.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-command-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { availCommand } = require('../commands/avail');

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Only the dry-run, help, and argument-error paths are covered here. Anything
// that reaches getToken() or apiRequestJson() would need the network.
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

test('availCommand --help prints usage and returns 2 without touching the network', async () => {
  const res = await run(['--help']);
  assert.strictEqual(res.code, 2);
  assert.match(res.stdout, /Usage: atris avail \[show \| set \| slots\]/);
  assert.strictEqual(res.stderr, '');
});

test('availCommand set --json without --apply is a dry run that returns the payload', async () => {
  const res = await run([
    'set', '--wake', '2:30pm', '--sleep', '9pm', '--where', 'Ibiza', '--days', 'mon,wed', '--json',
  ]);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.stderr, '');
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.preview, true);
  assert.deepStrictEqual(parsed.payload, {
    timezone: 'Europe/Madrid',
    available_hours: {
      '0': [[14.5, 21]],
      '1': [],
      '2': [[14.5, 21]],
      '3': [],
      '4': [],
      '5': [],
      '6': [],
    },
  });
});

test('availCommand set without --apply prints a readable preview and says it did not save', async () => {
  const res = await run(['set', '--wake', '9am', '--sleep', '5pm', '--tz', 'UTC', '--days', 'weekdays']);
  assert.strictEqual(res.code, 0);
  assert.match(res.stdout, /timezone: UTC/);
  assert.match(res.stdout, /Mon: 9am/);
  assert.match(res.stdout, /Sat: off/);
  assert.match(res.stdout, /Dry run, add --apply to push to your profile\./);
});

test('availCommand set rejects a wake time that is not before sleep', async () => {
  const res = await run(['set', '--wake', '9pm', '--sleep', '9am', '--tz', 'UTC']);
  assert.strictEqual(res.code, 1);
  assert.match(res.stderr, /wake must be before sleep on the same calendar day/);
  assert.strictEqual(res.stdout, '');
});

test('availCommand set with no --wake or --sleep returns 1 and names both flags', async () => {
  const res = await run(['set', '--wake', '9am']);
  assert.strictEqual(res.code, 1);
  assert.match(res.stderr, /--wake and --sleep are required/);
});

test('availCommand set with an unknown --where city returns 1 and suggests --tz', async () => {
  const res = await run(['set', '--wake', '9am', '--sleep', '5pm', '--where', 'Narnia']);
  assert.strictEqual(res.code, 1);
  assert.match(res.stderr, /unknown --where "Narnia"; use --tz IANA\/Zone instead/);
});

test('availCommand set with an out-of-range --slot-minutes returns 1 before any request', async () => {
  const res = await run(['set', '--wake', '9am', '--sleep', '5pm', '--tz', 'UTC', '--slot-minutes', '4']);
  assert.strictEqual(res.code, 1);
  assert.match(res.stderr, /--slot-minutes needs a whole number from 5 to 480, got: 4/);
});

test('availCommand with an unknown subcommand returns 1 and lists the valid ones', async () => {
  const res = await run(['frobnicate']);
  assert.strictEqual(res.code, 1);
  assert.match(res.stderr, /atris avail does not know "frobnicate"\. Use show, set, or slots\./);
  assert.match(res.stdout, /Usage: atris avail/);
});

test('availCommand slots with a non-numeric --days returns 1 before any request', async () => {
  const res = await run(['slots', '--days', 'soon']);
  assert.strictEqual(res.code, 1);
  assert.match(res.stderr, /--days needs a whole number from 1 to 365, got: soon/);
});

test('availCommand slots with a missing --days value returns 1 and says nothing was given', async () => {
  const res = await run(['slots', '--days']);
  assert.strictEqual(res.code, 1);
  assert.match(res.stderr, /got: nothing/);
});
