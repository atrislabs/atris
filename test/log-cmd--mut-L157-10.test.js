const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { logsDigest } = require('../commands/log');

test('digest without a date uses the current calendar month', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-month-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const output = [];

  // June has zero-based month 5: the correct month is 06, not 04.
  t.mock.method(Date.prototype, 'getFullYear', () => 2032);
  t.mock.method(Date.prototype, 'getMonth', () => 5);
  t.mock.method(Date.prototype, 'getDate', () => 15);
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(process, 'exit', (code) => {
    throw new Error(`unexpected exit: ${code}`);
  });

  try {
    process.env.HOME = root;
    process.chdir(root);
    logsDigest(['--json'], { cwd: root });
    assert.equal(JSON.parse(output.join('\n')).date.split('-')[1], '06');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    t.mock.restoreAll();
  }
});
