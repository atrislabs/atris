'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { soul } = require('../commands/soul');

test('soul previews persona prose after skipping headings and blank lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-soul-preview-'));
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const output = [];

  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(
      path.join(root, 'atris', 'PERSONA.md'),
      '# Persona\n\nSpeak plainly.\n'
    );
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));

    soul([]);

    assert.deepStrictEqual(
      output.filter(line => line.includes('persona:')),
      ['  │   persona: Speak plainly.                      │']
    );
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
