'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('scan keeps the last check when duplicate names have equal timestamps', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caretaker-tied-checks-'));
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'atris'));
  const pr = {
    number: 11,
    title: 'equal timestamp retry',
    headRefOid: 'aaa111',
    reviewDecision: 'APPROVED',
    commits: [{ committedDate: '2026-08-10T10:00:00Z', oid: 'aaa111' }],
    reviews: [{ state: 'APPROVED', submittedAt: '2026-08-10T10:30:00Z' }],
    latestReviews: [],
    statusCheckRollup: ['FAILURE', 'SUCCESS'].map((conclusion) => ({
      __typename: 'CheckRun',
      name: 'test',
      status: 'COMPLETED',
      conclusion,
      startedAt: '2026-08-10T10:01:00Z',
      completedAt: '2026-08-10T10:05:00Z',
    })),
  };
  // Supply gh locally so the exported command runs without network or credentials.
  fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === 'auth') process.exit(0);
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([${JSON.stringify({ number: pr.number, title: pr.title, headRefOid: pr.headRefOid })}]));
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify(${JSON.stringify(pr)}));
} else {
  process.stderr.write('unexpected gh arguments: ' + JSON.stringify(args));
  process.exit(2);
}
`, { mode: 0o755 });
  process.chdir(dir);
  process.env.PATH = dir;
  const errors = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', (...args) => errors.push(args));

  assert.equal(await caretakerCommand(['scan']), 0, JSON.stringify(errors));
  const receipt = JSON.parse(fs.readFileSync(
    path.join(dir, '.atris', 'state', 'caretaker.scan.latest.json'), 'utf8',
  ));
  assert.deepEqual(receipt.prs.map(({ number, state }) => ({ number, state })), [
    { number: 11, state: 'green-mergeable' },
  ]);
});
