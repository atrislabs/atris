'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const [run] = Object.values(require('../commands/zen'));

test('non-calm mode does not pause between output lines', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-test-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const savedHome = process.env.HOME;
  process.env.HOME = tmpDir;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  const savedCI = process.env.CI;
  const savedTTY = process.stdout.isTTY;
  process.env.CI = '1';
  process.stdout.isTTY = false;
  t.after(() => {
    if (savedCI === undefined) delete process.env.CI;
    else process.env.CI = savedCI;
    process.stdout.isTTY = savedTTY;
  });

  let pauseCount = 0;
  const origWait = Atomics.wait;
  Atomics.wait = () => {
    pauseCount += 1;
    return 'ok';
  };
  t.after(() => {
    Atomics.wait = origWait;
  });

  const origLog = console.log;
  const origWrite = process.stdout.write;
  console.log = () => {};
  process.stdout.write = () => {};
  t.after(() => {
    console.log = origLog;
    process.stdout.write = origWrite;
  });

  execSync('git init -q', { cwd: tmpDir });

  run(['--no-fetch'], tmpDir);

  assert.strictEqual(pauseCount, 0);
});
