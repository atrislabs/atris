'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialCliCommand } = require('../lib/official-cli-integration');

test('detects installed binary when running doctor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bin-'));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;

  const script = path.join(dir, 'fake-bin');
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const command = createOfficialCliCommand({
    name: 'sample',
    binary: script,
  });

  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = () => {};

  try {
    const status = command(['doctor']);
    assert.strictEqual(status, 0);
    assert.strictEqual(lines.some((l) => l.includes('binary: found')), true);
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.env.HOME = savedHome || os.tmpdir();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
