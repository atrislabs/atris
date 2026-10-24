'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('a completed check without a conclusion keeps an approved pull request waiting', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caretaker-untyped-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  process.env.HOME = root;
  process.chdir(root);
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit ${code}`); });
  fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('gh version 2.74.0');
}
else if (args[0] === 'auth') {
  console.log('logged into github.com');
} else if (args[0] === 'pr') {
  console.log(JSON.stringify(args[1] === 'list' ? [{number: 17, title: 'update docs', headRefOid: 'abc123'}] : {number: 17, title: 'update docs', headRefOid: 'abc123', commits: [{oid: 'abc123', committedDate: '2024-01-14T12:00:00Z'}], reviewDecision: 'APPROVED', reviews: [{state: 'APPROVED', submittedAt: '2024-01-14T13:00:00Z'}], latestReviews: [], statusCheckRollup: [{name: 'test', status: 'COMPLETED'}]}));
}
else process.exitCode = 1;
`, { mode: 0o755 });
  caretakerCommand(['scan'], {
    cwd: root,
    env: { HOME: root, PATH: root },
    now: new Date('2024-01-15T12:00:00.000Z'),
  });
  assert.equal(lines.some((line) => /is waiting/i.test(line)), true, lines.join("\n"));
});
