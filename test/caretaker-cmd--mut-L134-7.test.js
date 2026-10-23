'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('scan honors a change request submitted after the latest commit', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caretaker-review-date-'));
  const cwd = process.cwd();
  const oldPath = process.env.PATH;
  t.after(() => {
    process.chdir(cwd);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pr = {
    number: 12,
    title: 'revised change',
    headRefOid: 'abc123',
    reviewDecision: '',
    commits: [{ committedDate: '2020-01-02T12:00:00Z', oid: 'abc123' }],
    reviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2020-01-03T12:00:00Z' }],
    latestReviews: [],
    statusCheckRollup: [{
      __typename: 'CheckRun', name: 'test', status: 'COMPLETED',
      conclusion: 'SUCCESS', startedAt: '2020-01-02T12:01:00Z',
      completedAt: '2020-01-02T12:05:00Z',
    }],
  };
  fs.mkdirSync(path.join(dir, 'atris'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
const pr = ${JSON.stringify(pr)};
if (args[0] === '--version' || args[0] === 'auth') process.exit(0);
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify([{ number: pr.number, title: pr.title, headRefOid: pr.headRefOid }]));
} else if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify(pr));
} else process.exit(2);
`, { mode: 0o755 });
  process.chdir(dir);
  process.env.PATH = bin;
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args));
  assert.equal(caretakerCommand(['scan']), 0);
  assert.deepEqual(output, [[
    'pr 12 "revised change" is changes-requested because a review asked for changes after the last push.',
  ]]);
});
