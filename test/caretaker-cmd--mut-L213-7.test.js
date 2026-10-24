'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('scan preserves a pull request returned by gh', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caretaker-output-'));
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  const output = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const pr = {
    number: 37,
    title: 'preserve returned pull request',
    headRefOid: 'abc123',
    reviewDecision: '',
    commits: [],
    reviews: [],
    latestReviews: [],
    statusCheckRollup: [],
  };
  fs.mkdirSync(path.join(dir, 'atris'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version' || (args[0] === 'auth' && args[1] === 'status')) {
  process.stdout.write('gh available\\n');
} else if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([${JSON.stringify(pr)}]) + '\\n');
} else if (args[0] === 'pr' && args[1] === 'view' && args[2] === '37') {
  process.stdout.write(JSON.stringify(${JSON.stringify(pr)}) + '\\n');
} else {
  process.stderr.write('unexpected gh arguments: ' + args.join(' '));
  process.exitCode = 1;
}
`, { mode: 0o755 });
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    const status = caretakerCommand(['scan'], {
      cwd: dir,
      env: { HOME: dir, PATH: dir },
      now: new Date('2026-01-15T12:00:00Z'),
    });
    assert.match(output.join('\n'), /pr 37\b.*preserve returned pull request/i,
      errors.join('\n') || 'the returned pull request must appear in the scan');
    assert.equal(status, 0, errors.join('\n'));
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
