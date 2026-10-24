'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('scan runs gh in the explicitly selected repository', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-directory-'));
  const selected = path.join(home, 'selected');
  const observed = path.join(home, 'observed.json');
  fs.mkdirSync(selected);
  fs.mkdirSync(path.join(selected, 'atris'));
  fs.writeFileSync(path.join(home, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ cwd: process.cwd() }));
if (process.argv[2] === 'pr' && process.argv[3] === 'list') {
  process.stdout.write('[]');
}
`, { mode: 0o755 });
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  try {
    process.env.HOME = home;
    process.chdir(home);
    caretakerCommand(['scan'], {
      cwd: selected,
      env: { HOME: home, PATH: home },
      now: new Date('2026-01-15T12:00:00Z'),
    });
    assert.equal(JSON.parse(fs.readFileSync(observed, 'utf8')).cwd,
      fs.realpathSync(selected));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
