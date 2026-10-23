'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { soul } = require('../commands/soul');

test('distill carries a policy rule into the persona', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-distill-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'PERSONA.md'), '# Persona\n\nSpeak plainly.\n');
    fs.mkdirSync(path.join(root, 'atris', 'policies'));
    fs.writeFileSync(path.join(root, 'atris', 'policies', 'safety.md'), '# Safety\n\n- Confirm the backup before deleting old records.\n');
    console.log = () => {};
    await soul(['distill']);
    assert.match(fs.readFileSync(path.join(root, 'atris', 'PERSONA.md'), 'utf8'), /Confirm the backup before deleting old records\./);
  } finally {
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
