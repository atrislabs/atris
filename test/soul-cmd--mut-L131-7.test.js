'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { soul } = require('../commands/soul');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-soul-mut-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function captureStatus(t, root) {
  const prevCwd = process.cwd();
  const prevLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  process.chdir(root);
  t.after(() => {
    console.log = prevLog;
    process.chdir(prevCwd);
  });
  await soul(['status']);
  return lines;
}

test('soul status shows the first non-header PERSONA.md line as the preview', async (t) => {
  const root = makeRoot(t);
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(
    path.join(atrisDir, 'PERSONA.md'),
    '# Persona\n\nSpeak plainly and name the file.\n'
  );

  const lines = await captureStatus(t, root);

  const personaLine = lines.find((l) => l.includes('persona:'));
  assert.ok(personaLine, 'expected a persona preview line in soul status output');
  assert.ok(
    personaLine.includes('Speak plainly and name the file.'),
    'persona preview should show the first non-header line, got: ' + personaLine
  );
});

test('soul status renders a blank preview instead of throwing when PERSONA.md has only headers', async (t) => {
  const root = makeRoot(t);
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'PERSONA.md'), '# Persona\n## Voice\n');

  const lines = await captureStatus(t, root);

  const personaLine = lines.find((l) => l.includes('persona:'));
  assert.ok(personaLine, 'expected a persona preview line even with no non-header text');
});
