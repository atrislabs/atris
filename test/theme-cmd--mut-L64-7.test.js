require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const theme = require('../commands/theme');

test('interactive creation saves the name entered by the user', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-custom-name-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const createInterface = readline.createInterface;
  const log = console.log;
  const exit = process.exit;
  try {
    process.chdir(dir);
    process.env.HOME = dir;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    readline.createInterface = () => ({
      question(prompt, answer) {
        answer(prompt.includes('name it') ? '  ocean-studio  ' : '');
      },
      close() {},
    });
    console.log = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    await theme.run(['create']);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'theme.json'), 'utf8'));
    assert.equal(Object.hasOwn(saved.themes, 'ocean-studio'), true);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
    readline.createInterface = createInterface;
    console.log = log;
    process.exit = exit;
  }
});
