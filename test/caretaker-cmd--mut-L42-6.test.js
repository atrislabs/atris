'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('scan succeeds when gh is installed and there are no open pull requests', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-gh-scan-'));
  const cwd = process.cwd();
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  t.after(() => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  fs.mkdirSync(path.join(dir, 'atris'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('gh version 2.74.0\\n');
} else if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(0);
} else if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write('[]');
} else {
  process.exit(2);
}
`, { mode: 0o755 });
  process.env.HOME = dir;
  process.env.PATH = dir;
  process.chdir(dir);
  t.mock.method(console, 'log', () => {});
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(process, 'exit', (code) => { throw new Error('unexpected exit: ' + code); });

  let result;
  try {
    result = await caretakerCommand(['scan']);
  } catch (error) {
    result = error;
  }
  assert.strictEqual(result, 0, errors.join('\n'));
});
