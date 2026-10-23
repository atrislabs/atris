'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { soul } = require('../commands/soul');

test('soul status truncates a long persona preview to fit the display', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-preview-'));
  const cwd = process.cwd();
  const log = console.log;
  const output = [];
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'PERSONA.md'),
      '# Persona\n\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij\n');
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));

    await soul(['status']);

    assert.deepEqual(output.filter(line => line.startsWith('  │   persona: ')), [
      '  │   persona: ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567… │',
    ]);
  } finally {
    console.log = log;
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
