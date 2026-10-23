'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { landStaleGreenBranches } = require('../lib/land-green');

test('a failed flag reports the error message without its error type', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-error-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: '2001-01-01T12:00:00Z',
    GIT_COMMITTER_DATE: '2001-01-01T12:00:00Z',
  };
  function git(args) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  try {
    git(['init', '-q', '-b', 'master']);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    git(['checkout', '-q', '-b', 'member/failing']);
    fs.writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'feature']);
    git(['checkout', '-q', 'master']);

    const failure = new Error('flag storage unavailable');
    const result = landStaleGreenBranches(root, {
      now: Date.parse('2001-01-04T12:00:00Z'),
      push: false,
      verifyCommand: 'node --test',
      runVerifyFn: () => ({ status: 1, failing: ['feature check'], command: 'node --test', duration_ms: 0, timed_out: false, tail: 'not ok feature check' }),
      runCli: () => { throw failure; },
    });
    const verdict = result.verdicts.find((item) => item.branch === 'member/failing');
    assert.equal(verdict.flag.out, failure.message);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
