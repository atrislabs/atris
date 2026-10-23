'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-aeo-audit-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
delete process.env.ATRIS_BACKEND_ROOT;
delete process.env.ATRIS_BACKEND_DIR;
delete process.env.ATRIS_AEO_ROOT;

const { run } = require('../commands/aeo');

test('audit subcommand prints usage without arguments', async () => {
  const logs = [];
  const errors = [];
  let exitCode = null;
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;

  console.log = (...parts) => {
    logs.push(parts.map((p) => String(p)).join(' '));
  };
  console.error = (...parts) => {
    errors.push(parts.map((p) => String(p)).join(' '));
  };
  process.exit = (code) => {
    exitCode = code;
    const err = new Error(`exit:${code}`);
    err.exitCode = code;
    throw err;
  };

  try {
    await run(['audit']);
  } catch (err) {
    if (!err || typeof err.exitCode !== 'number') {
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  assert.strictEqual(exitCode, null);
  const output = logs.join('\n');
  assert.ok(output.includes('Usage: atris aeo audit'));
});
