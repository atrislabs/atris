'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('caretaker reports the specific failing check name', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caretaker-check-name-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gh = path.join(root, 'gh');
  fs.writeFileSync(gh, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version' || (args[0] === 'auth' && args[1] === 'status')) {
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify([{ number: 42, title: 'Fix parser', headRefOid: 'abc' }]));
} else if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({
    number: 42,
    title: 'Fix parser',
    headRefOid: 'abc',
    statusCheckRollup: [{ name: 'parser tests', status: 'COMPLETED', conclusion: 'FAILURE' }]
  }));
} else {
  process.exit(1);
}
`, { mode: 0o755 });

  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (...args) => stdout.push(args));
  t.mock.method(console, 'error', (...args) => stderr.push(args));

  assert.equal(caretakerCommand(['scan'], {
    cwd: root,
    env: { PATH: root },
    now: new Date('2024-01-01T00:00:00.000Z'),
  }), 0);
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, [
    ['pr 42 "fix parser" is ci-red because the latest parser tests check failed.'],
  ]);
});
