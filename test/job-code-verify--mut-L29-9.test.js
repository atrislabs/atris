'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runVerifyAtJobCode } = require('../lib/job-code-verify');

test('verifies a recorded commit in a newly created scratch checkout', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-command-'));
  const previousHome = process.env.HOME;
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  process.env.HOME = root;
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgsign=false', '-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid', ...args], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_DATE: '2024-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T12:00:00Z' },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  git('init', '--quiet');
  fs.writeFileSync(path.join(root, 'smoke.test.js'), `
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('checkout without dependencies has no dependency link', () => {
  assert.equal(fs.readdirSync('.').includes('node_modules'), false);
});
`);
  git('add', 'smoke.test.js');
  git('commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'later');
  const task = { workspace_root: root, metadata: { work_commit: sha } };
  const result = runVerifyAtJobCode('node --test smoke.test.js', task, { root });
  assert.equal(result.ok, true);
});
