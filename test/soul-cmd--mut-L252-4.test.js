'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { soul } = require('../commands/soul');

test('distilling without lessons or policy rules leaves the persona alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-distill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    console.log = previousLog;
    process.exit = previousExit;
  });
  process.env.HOME = root;
  process.chdir(root);
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir);
  const personaPath = path.join(atrisDir, 'PERSONA.md');
  fs.writeFileSync(personaPath, '# Persona\n\nSpeak plainly.\n');

  await soul(['distill']);

  assert.strictEqual(fs.readFileSync(personaPath, 'utf8').includes('<!-- Distilled'), false);
});
