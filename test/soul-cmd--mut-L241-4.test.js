'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { soul } = require('../commands/soul');

test('distill leaves the persona alone when there is nothing learned to distill', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-soul-mut-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  const personaPath = path.join(atrisDir, 'PERSONA.md');
  const persona = '# Persona\n\nSpeak plainly.\n';
  fs.writeFileSync(personaPath, persona);
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# Lessons\n\nplain line only\n');

  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevLog = console.log;
  console.log = () => {};
  process.env.HOME = root;
  process.chdir(root);
  t.after(() => {
    console.log = prevLog;
    process.env.HOME = prevHome;
    process.chdir(prevCwd);
  });

  await soul(['distill']);

  assert.strictEqual(fs.readFileSync(personaPath, 'utf8'), persona);
  assert.ok(!fs.existsSync(path.join(atrisDir, 'persona-history')));
});
