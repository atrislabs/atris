'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runScan = Object.values(require('../commands/caretaker'))[0];

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-mut-'));
}

function writeGhShim(dir, prs) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const dataPath = path.join(dir, 'prs.json');
  fs.writeFileSync(dataPath, `${JSON.stringify(prs)}\n`, 'utf8');
  const scriptPath = path.join(binDir, 'gh');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const joined = args.join(' ');
if (joined === '--version') {
  process.stdout.write('gh version 2.74.0\\n');
  process.exit(0);
}
if (joined === 'auth status') {
  process.stdout.write('github.com\\n  Logged in\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  const all = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));
  const list = all.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headRefOid: pr.headRefOid,
  }));
  process.stdout.write(JSON.stringify(list) + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const number = Number(args[2]);
  const all = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));
  const pr = all.find((item) => Number(item.number) === number);
  if (!pr) {
    process.stderr.write('pull request not found\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(pr) + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + joined + '\\n');
process.exit(2);
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);
  return binDir;
}

test('scan flags a finished check with a stale conclusion as ci-red', (t) => {
  const dir = makeTempDir();
  const prevCwd = process.cwd();
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  const prevExit = process.exit;
  const stdout = [];
  t.mock.method(console, 'log', (...args) => stdout.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const binDir = writeGhShim(dir, [
      {
        number: 21,
        title: 'build went stale',
        headRefOid: 'eee555',
        reviewDecision: '',
        commits: [{ committedDate: '2026-08-10T10:00:00Z', oid: 'eee555' }],
        reviews: [],
        latestReviews: [],
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'build',
            status: 'COMPLETED',
            conclusion: 'STALE',
            completedAt: '2026-08-10T10:05:00Z',
            startedAt: '2026-08-10T10:01:00Z',
          },
        ],
      },
    ]);
    process.env.HOME = dir;
    process.env.PATH = `${binDir}${path.delimiter}${prevPath || ''}`;
    process.chdir(dir);
    process.exit = (code) => {
      throw new Error(`unexpected exit ${code}`);
    };

    const code = runScan(['scan']);

    assert.equal(code, 0);
    assert.ok(
      stdout.some((line) => line.includes('is ci-red')),
      `expected a ci-red line, got: ${stdout.join(' | ')}`,
    );
  } finally {
    process.exit = prevExit;
    process.chdir(prevCwd);
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
