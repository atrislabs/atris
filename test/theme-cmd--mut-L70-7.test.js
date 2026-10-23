const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const theme = require('../commands/theme');
const { loadThemeRecipe } = require('../lib/theme');

test('interactive creation saves the selected nondefault mood', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-mood-choice-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const createInterface = readline.createInterface;
  const log = console.log;
  const answers = ['', '2', '', '', '', ''];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    readline.createInterface = () => ({
      question(_prompt, answer) { answer(answers.shift()); },
      close() {},
    });
    console.log = () => {};
    await theme.run(['create', 'chosen']);
    assert.strictEqual(loadThemeRecipe('chosen', dir).mood, 'technical');
  } finally {
    console.log = log;
    readline.createInterface = createInterface;
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
