'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gameCommand } = require('../commands/game');

test('terminal dashboard honors NO_COLOR', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-game-no-color-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const noColor = process.env.NO_COLOR;
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const log = console.log;
  const output = [];

  try {
    process.env.HOME = root;
    process.env.NO_COLOR = '1';
    process.chdir(root);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    console.log = value => output.push(String(value));

    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'game_state_sync.py'), '');
    // A bounded publisher executable keeps this test independent of Python.
    fs.writeFileSync(path.join(root, 'venv', 'bin', 'python'),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({
        storyline: { name: 'Color preference' },
      }))});\n`, { mode: 0o755 });

    assert.equal(await gameCommand(), true);
    const dashboard = output.join('\n');
    assert.match(dashboard, /Color preference/);
    assert.doesNotMatch(dashboard, /\u001b/, 'NO_COLOR must suppress terminal escape characters');
  } finally {
    console.log = log;
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else delete process.stdout.isTTY;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
    process.chdir(cwd);
  }
});
