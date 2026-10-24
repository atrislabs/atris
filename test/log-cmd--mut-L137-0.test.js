const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { PassThrough } = require('node:stream');
const { logAtris } = require('../commands/log');

test('typing exit in the interactive journal confirms the log was saved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-exit-'));
  const cwd = process.cwd();
  const argv = process.argv;
  const env = { ...process.env };
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const originalLog = console.log;
  const originalExit = process.exit;
  const createInterface = readline.createInterface;
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const stopped = new Error('intercepted exit');
  let rl;
  try {
    process.env.HOME = root;
    process.env.ATRIS_NONINTERACTIVE = '0';
    process.env.ATRIS_NO_INTERACTIVE = '0';
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    process.argv = [process.execPath, 'atris', 'log', '--repl'];
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    console.log = (...args) => messages.push(args.join(' '));
    process.exit = () => { throw stopped; };
    readline.createInterface = () => {
      rl = createInterface({ input, output, terminal: false });
      return rl;
    };
    logAtris();
    try {
      input.write('  ExIt  \n');
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.ok(messages.some((message) => /\bsaved\b/i.test(message)));
  } finally {
    if (rl) {
      rl.removeAllListeners('close');
      rl.close();
    }
    input.destroy();
    output.destroy();
    readline.createInterface = createInterface;
    process.exit = originalExit;
    console.log = originalLog;
    process.argv = argv;
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  }
});
