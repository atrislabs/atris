'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkedCodeSha, runVerifyAtJobCode } = require('../lib/job-code-verify');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-code-verify-test-'));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgsign=false', '-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid', ...args], {
      cwd: repo, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'fixture');
  return { repo: fs.realpathSync(repo), sha: git('rev-parse', 'HEAD') };
}

test('checkedCodeSha falls back to checkout when no distinct work commit exists', (t) => {
  const { repo, sha } = fixture(t);
  assert.strictEqual(checkedCodeSha(null, repo), sha);
  assert.strictEqual(checkedCodeSha({ workspace_root: repo }, repo), sha);
  assert.strictEqual(checkedCodeSha({ workspace_root: repo,
    metadata: { start_commit: sha, work_commit: sha } }, repo), sha);
  assert.strictEqual(checkedCodeSha({ workspace_root: repo,
    metadata: { work_commit: 'invalid' } }, repo), sha);
});

test('missing work commit is reported without executing the verification command', (t) => {
  const { repo } = fixture(t);
  const missing = 'a'.repeat(40);
  const task = { id: 'missing-job', workspace_root: repo,
    metadata: { work_commit: ` ${missing} ` } };
  assert.strictEqual(checkedCodeSha(task, repo), missing);
  assert.deepStrictEqual(runVerifyAtJobCode('this-command-must-never-run', task, { root: repo }), {
    ok: false,
    reason: 'verify_unrunnable',
    unrunnable_cause: 'job_code_missing',
    alarm: true,
    detail: `the job's commit ${missing.slice(0, 10)} is not in this repo; fetch it or record the job's commit again`,
    code_sha: missing,
    code_source: 'work_commit',
  });
});

test('queued commit takes precedence over a missing recorded work commit', (t) => {
  const { repo, sha } = fixture(t);
  const state = path.join(repo, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'autoland-queue.json'), JSON.stringify({ entries: {
    unrelated: { task_ids: ['another-job'], pushed: 'b'.repeat(40) },
    matching: { task_ids: ['queued-job'], pushed: sha },
  } }));
  assert.strictEqual(checkedCodeSha({ id: 'queued-job', workspace_root: repo,
    metadata: { work_commit: 'a'.repeat(40) } }, repo), sha);
});
