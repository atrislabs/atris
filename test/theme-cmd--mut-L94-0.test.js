const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const theme = require('../commands/theme');
const { loadProjectThemes } = require('../lib/theme');

test('interactive edit keeps a saved font choice when accepting defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-font-default-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const createInterface = readline.createInterface;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    await theme.run(['create', 'brand', '--mood', 'technical', '--fonts', 'mono-forward', '--yes']);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    readline.createInterface = () => ({
      question(prompt, callback) { callback(''); },
      close() {},
    });
    await theme.run(['edit', 'brand']);
    assert.strictEqual(loadProjectThemes(dir).brand.fonts.body, 'IBM Plex Mono');
  } finally {
    readline.createInterface = createInterface;
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
    process.exit = exit;
    console.log = log;
    console.error = error;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
