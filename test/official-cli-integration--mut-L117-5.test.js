require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialCliCommand } = require('../lib/official-cli-integration');

test('a complete command without optional arguments reaches the cli', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-exact-command-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const log = path.join(dir, 'calls');
  const binary = path.join(dir, 'sample');
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "sample 1.0"\nelse\n  printf "%s\\n" "$*" >> "' + log + '"\n  echo "items available"\nfi\n', { mode: 0o755 });
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    const command = createOfficialCliCommand({
      name: 'sample',
      binary,
      installHint: 'install sample',
      commands: [{ match: ['items', 'list'], forward: ['list'], usage: 'items list', description: 'list items' }],
    });
    const result = command(['items', 'list']);
    assert.equal(result, 0);
    assert.equal(fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim(), 'list');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
  }
});
