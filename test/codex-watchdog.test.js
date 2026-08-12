'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WATCHDOG = path.join(__dirname, '..', 'scripts', 'det', 'codex-watchdog.js');

function fixture(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watchdog-'));
  const child = path.join(dir, 'child.js');
  fs.writeFileSync(child, source);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { child, dir };
}

function runWatchdog(dir, child, childArgs = [], options = {}) {
  return spawnSync(process.execPath, [
    WATCHDOG,
    '--startup-deadline', options.startupDeadline || '1',
    '--max-runtime', options.maxRuntime || '6',
    ...(options.receipt ? ['--receipt', options.receipt] : []),
    '--',
    process.execPath,
    child,
    ...childArgs,
  ], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 8000,
  });
}

test('passes through output and a fast child exit code', (t) => {
  const { child, dir } = fixture(t, `
process.stdout.write('fast stdout\\n');
process.stderr.write('fast stderr\\n');
process.exitCode = 7;
`);

  const result = runWatchdog(dir, child);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'fast stdout\n');
  assert.equal(result.stderr, 'fast stderr\n');
});

test('kills and retries two silent starts before exiting 124', (t) => {
  const { child, dir } = fixture(t, 'setInterval(() => {}, 1000);\n');

  const result = runWatchdog(dir, child);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 124);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'watchdog: silent start after 1s, retrying once\n' +
      'watchdog: silent start twice, giving up\n'
  );
});

test('returns success when the retry produces output and exits zero', (t) => {
  const { child, dir } = fixture(t, `
const fs = require('node:fs');
const marker = process.argv[2];
if (fs.existsSync(marker)) {
  process.stdout.write('retry succeeded\\n');
} else {
  fs.writeFileSync(marker, 'started');
  setInterval(() => {}, 1000);
}
`);
  const marker = path.join(dir, 'first-run.marker');

  const result = runWatchdog(dir, child, [marker]);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'retry succeeded\n');
  assert.equal(result.stderr, 'watchdog: silent start after 1s, retrying once\n');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'started');
});

test('kills a live child at the maximum runtime and exits 125', (t) => {
  const { child, dir } = fixture(t, `
process.stdout.write('started\\n');
setInterval(() => {}, 1000);
`);

  const receiptPath = path.join(dir, 'watchdog-timeout.json');
  const result = runWatchdog(dir, child, [], { maxRuntime: '0.5', receipt: receiptPath });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 125);
  assert.equal(result.stdout, 'started\n');
  assert.equal(result.stderr, 'watchdog: max runtime of 0.5s exceeded\n');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.schema, 'atris.codex_watchdog_receipt.v1');
  assert.equal(receipt.status, 'timed_out');
  assert.equal(receipt.reason, 'max_runtime');
  assert.equal(receipt.exit_code, 125);
  assert.equal(Number.isInteger(receipt.pid), true);
  assert.match(receipt.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(receipt.finished_at, /^\d{4}-\d{2}-\d{2}T/);
});
