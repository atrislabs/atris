const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialCliCommand } = require('../lib/official-cli-integration');

test('a summarized item list preserves the item link from stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-item-summary-'));
  const binary = path.join(dir, 'items-cli');
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "items-cli 1.0.0"\nelse\n  echo "item: https://example.com/items/42"\nfi\n', { mode: 0o755 });
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const command = createOfficialCliCommand({
      name: 'items',
      binary,
      installHint: 'install items-cli',
      commands: [{ match: ['list'], forward: ['list'], usage: 'list', description: 'list items', summarize: true }],
    });
    command(['list']);
    assert.ok(output.some(line => line.includes('https://example.com/items/42')));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
