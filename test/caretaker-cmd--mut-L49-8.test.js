'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('scan proceeds after successful github authentication', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caretaker-auth-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  t.after(() => {
    process.chdir(previousCwd);
    process.exit = previousExit;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  process.env.HOME = root;
  process.chdir(root);
  process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
  fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('gh version 2.60.0');
else if (args[0] === 'auth' && args[1] === 'status') console.log('Logged in to github.com');
else if (args[0] === 'pr' && args[1] === 'list') console.log('[]');
else process.exitCode = 1;
`, { mode: 0o755 });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});

  const result = caretakerCommand(['scan'], {
    cwd: root,
    env: { HOME: root, PATH: root },
    now: new Date('2024-01-15T12:00:00.000Z'),
  });

  assert.equal(result, 0);
  assert.equal(lines.some((line) => /no open pull requests/i.test(line)), true);
});
