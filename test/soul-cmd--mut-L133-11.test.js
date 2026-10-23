'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { soul } = require('../commands/soul');

test('soul status truncates a long persona preview to 34 characters and an ellipsis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-soul-preview-'));
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const output = [];

  try {
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(atrisDir);
    fs.writeFileSync(path.join(atrisDir, 'PERSONA.md'), '# Persona\n\n' + 'a'.repeat(34) + 'BCDE\n');
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));

    await soul(['status']);

    assert.deepEqual(
      output.filter(line => line.includes('persona:')),
      ['  │   persona: ' + 'a'.repeat(34) + '… │']
    );
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
