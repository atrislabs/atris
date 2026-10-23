'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a nested working folder displays the parent project persona', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-parent-persona-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  const exitSignal = new Error('command exited');
  const persona = 'Speak with orchard wisdom';

  try {
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, 'atris'));
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'PERSONA.md'), persona);
    process.chdir(path.join(root, 'src', 'nested'));
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = () => { throw exitSignal; };
    const { soul } = require('../commands/soul');
    try {
      await soul([]);
    } catch (error) {
      if (error !== exitSignal) throw error;
    }

    assert.ok(lines.some(line => line.includes(persona)), 'the parent persona is displayed');
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
