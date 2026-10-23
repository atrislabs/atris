'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gameCommand } = require('../commands/game');

test('missing publisher script reports unavailable game state even with an interpreter installed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'game-incomplete-install-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true });
    // Match the bounded interpreter fixture used by the command tests.
    // Its valid payload makes an incorrectly attempted publication observable.
    fs.writeFileSync(path.join(root, 'venv', 'bin', 'python'),
      `#!${process.execPath}\n` +
      `process.stdout.write(JSON.stringify({storyline: {name: 'Incomplete installation'}}));\n`,
      { mode: 0o755 });
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    let result;
    let failure;
    try {
      result = await gameCommand([]);
    } catch (err) {
      failure = err;
    }
    assert.match(output.join('\n'), /no game state in this workspace/);
    assert.doesNotMatch(output.join('\n'), /Incomplete installation/);
    assert.equal(result, false);
    assert.equal(failure, undefined);
  } finally {
    console.log = log;
    console.error = error;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
