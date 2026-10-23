const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialCliCommand } = require('../lib/official-cli-integration');

test('summary includes captured error lines from standard error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;

  const script = path.join(dir, 'runner.js');
  fs.writeFileSync(script, 'console.error("error: problem detected");\n');

  const command = createOfficialCliCommand({
    name: 'sample',
    binary: process.execPath,
    commands: [{
      match: ['run'],
      forward: [script],
      usage: 'run',
      description: 'run',
      summarize: true,
    }],
  });

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));

  try {
    command(['run']);
  } finally {
    console.log = originalLog;
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(output.some((line) => line.includes('error: problem detected')));
});
