'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('a failed commit status makes an approved pull request ci-red', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-status-context-'));
  const oldCwd = process.cwd();
  const oldHome = process.env.HOME;
  const pr = {
    number: 21,
    title: 'update documentation',
    headRefOid: 'abc123',
    reviewDecision: 'APPROVED',
    commits: [{ oid: 'abc123', committedDate: '2026-08-10T10:00:00Z' }],
    reviews: [{ state: 'APPROVED', submittedAt: '2026-08-10T10:30:00Z' }],
    latestReviews: [],
    statusCheckRollup: [{
      __typename: 'StatusContext',
      context: 'build',
      state: 'FAILURE',
      createdAt: '2026-08-10T10:05:00Z',
    }],
  };
  fs.mkdirSync(path.join(dir, 'atris'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
const pr = ${JSON.stringify(pr)};
if (args[0] === '--version') console.log('gh version 2.74.0');
else if (args[0] === 'auth') console.log('logged in');
else if (args[0] === 'pr' && args[1] === 'list') console.log(JSON.stringify([pr]));
else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify(pr));
else process.exit(2);
`, { mode: 0o755 });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit ${code}`); });
  try {
    process.chdir(dir);
    process.env.HOME = dir;
    caretakerCommand(['scan'], {
      cwd: dir,
      env: { ...process.env, HOME: dir, PATH: bin },
      now: '2026-08-10T12:00:00Z',
    });
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'caretaker.scan.latest.json'), 'utf8'));
    assert.equal(receipt.prs[0].state, 'ci-red');
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
