require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

test('an interactive font selection overrides the default font', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'font-choice-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const createInterface = readline.createInterface;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  try {
    process.chdir(dir);
    process.env.HOME = dir;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    readline.createInterface = () => ({
      question(prompt, answer) {
        answer(/pick 1-3/.test(prompt) ? '2' : '');
      },
      close() {},
    });
    const command = require('../commands/theme');
    await command.run(['create', 'selected']);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'theme.json'), 'utf8'));
    assert.strictEqual(saved.themes.selected.fonts.display, 'Space Grotesk');
  } finally {
    readline.createInterface = createInterface;
    console.log = log;
    console.error = error;
    process.exit = exit;
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    process.chdir(cwd);
  }
});
