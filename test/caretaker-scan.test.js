'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const RECEIPT = path.join('.atris', 'state', 'caretaker.scan.latest.json');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-caretaker-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeGhShim(dir, prs, { authOk = true } = {}) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const dataPath = path.join(dir, 'prs.json');
  fs.writeFileSync(dataPath, `${JSON.stringify(prs)}\n`, 'utf8');
  const scriptPath = path.join(binDir, 'gh');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2).join(' ');
if (args === '--version') {
  process.stdout.write('gh version 2.74.0\\n');
  process.exit(0);
}
if (args === 'auth status') {
  if (${authOk ? 'true' : 'false'}) {
    process.stdout.write('github.com\\n  ✓ Logged in\\n');
    process.exit(0);
  }
  process.stderr.write('not logged in\\n');
  process.exit(1);
}
if (args.startsWith('pr list')) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args + '\\n');
process.exit(2);
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);
  return binDir;
}

function samplePrs() {
  return [
    {
      number: 11,
      title: 'fix the build',
      headRefOid: 'aaa111',
      reviewDecision: '',
      commits: [{ committedDate: '2026-08-10T10:00:00Z', oid: 'aaa111' }],
      reviews: [],
      latestReviews: [],
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'test',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          completedAt: '2026-08-10T10:05:00Z',
          startedAt: '2026-08-10T10:01:00Z',
        },
      ],
    },
    {
      number: 12,
      title: 'needs a rewrite',
      headRefOid: 'bbb222',
      reviewDecision: 'CHANGES_REQUESTED',
      commits: [{ committedDate: '2026-08-10T09:00:00Z', oid: 'bbb222' }],
      reviews: [
        {
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-08-10T11:00:00Z',
        },
      ],
      latestReviews: [],
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'test',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          completedAt: '2026-08-10T09:05:00Z',
          startedAt: '2026-08-10T09:01:00Z',
        },
      ],
    },
    {
      number: 13,
      title: 'ready to land',
      headRefOid: 'ccc333',
      reviewDecision: 'APPROVED',
      commits: [{ committedDate: '2026-08-10T12:00:00Z', oid: 'ccc333' }],
      reviews: [
        {
          state: 'APPROVED',
          submittedAt: '2026-08-10T12:30:00Z',
        },
      ],
      latestReviews: [],
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'test',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          completedAt: '2026-08-10T12:05:00Z',
          startedAt: '2026-08-10T12:01:00Z',
        },
        {
          __typename: 'CheckRun',
          name: 'lint',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          completedAt: '2026-08-10T12:04:00Z',
          startedAt: '2026-08-10T12:01:00Z',
        },
      ],
    },
    {
      number: 14,
      title: 'still cooking',
      headRefOid: 'ddd444',
      reviewDecision: '',
      commits: [{ committedDate: '2026-08-10T13:00:00Z', oid: 'ddd444' }],
      reviews: [],
      latestReviews: [],
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'test',
          status: 'IN_PROGRESS',
          conclusion: '',
          completedAt: '',
          startedAt: '2026-08-10T13:01:00Z',
        },
      ],
    },
  ];
}

function runCaretaker(cwd, binDir) {
  return spawnSync(process.execPath, [cliPath, 'caretaker', 'scan'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      CI: 'true',
    },
  });
}

test('caretaker scan classifies four pr states and writes the receipt shape', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const binDir = writeGhShim(dir, samplePrs());
    const run = runCaretaker(dir, binDir);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const lines = run.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^pr 11 "fix the build" is ci-red because /);
    assert.match(lines[1], /^pr 12 "needs a rewrite" is changes-requested because /);
    assert.match(lines[2], /^pr 13 "ready to land" is green-mergeable because /);
    assert.match(lines[3], /^pr 14 "still cooking" is waiting because /);
    for (const line of lines) {
      assert.equal(line, line.toLowerCase());
      assert.equal(line.includes('\u2014'), false);
    }

    const receiptPath = path.join(dir, RECEIPT);
    assert.equal(fs.existsSync(receiptPath), true);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(typeof receipt.scanned_at, 'string');
    assert.ok(Date.parse(receipt.scanned_at));
    assert.equal(receipt.prs.length, 4);
    assert.deepEqual(
      receipt.prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        head_sha: pr.head_sha,
      })),
      [
        { number: 11, title: 'fix the build', state: 'ci-red', head_sha: 'aaa111' },
        { number: 12, title: 'needs a rewrite', state: 'changes-requested', head_sha: 'bbb222' },
        { number: 13, title: 'ready to land', state: 'green-mergeable', head_sha: 'ccc333' },
        { number: 14, title: 'still cooking', state: 'waiting', head_sha: 'ddd444' },
      ],
    );
    for (const pr of receipt.prs) {
      assert.equal(typeof pr.reason, 'string');
      assert.ok(pr.reason.length > 0);
      assert.equal(pr.scanned_at, receipt.scanned_at);
      assert.deepEqual(
        Object.keys(pr).sort(),
        ['head_sha', 'number', 'reason', 'scanned_at', 'state', 'title'],
      );
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('caretaker scan exits politely when gh is missing', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const emptyPath = path.join(dir, 'empty-bin');
    fs.mkdirSync(emptyPath);
    const run = spawnSync(process.execPath, [cliPath, 'caretaker', 'scan'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: emptyPath,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        CI: 'true',
      },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /gh is missing or not signed in/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('caretaker scan exits politely when gh is not authenticated', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const binDir = writeGhShim(dir, [], { authOk: false });
    const run = runCaretaker(dir, binDir);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /gh is missing or not signed in/i);
  } finally {
    cleanupTempDir(dir);
  }
});
