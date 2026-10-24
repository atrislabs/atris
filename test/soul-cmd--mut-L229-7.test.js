'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { soul } = require('../commands/soul');

test('distilling preserves a saved lesson in the persona', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-distill-lesson-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousExit = process.exit;
  try {
    process.env.HOME = root;
    process.chdir(root);
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(path.join(atrisDir, 'policies'), { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# Lessons\n\n- check the receipt before reporting success\n');
    fs.writeFileSync(path.join(atrisDir, 'policies', 'voice.md'), '# Voice\n\n- speak plainly\n');
    console.log = () => {};
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };

    await soul(['distill']);

    const persona = fs.readFileSync(path.join(atrisDir, 'PERSONA.md'), 'utf8');
    assert.ok(persona.split('\n').includes('- check the receipt before reporting success'));
  } finally {
    process.chdir(previousCwd);
    console.log = previousLog;
    process.exit = previousExit;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
