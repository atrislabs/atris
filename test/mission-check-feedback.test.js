'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson } = require('./helpers/mission-json');
const {
  buildTickPrompt,
  extractCheckFeedback,
} = require('../commands/mission');

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-feedback-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  return { base, repo };
}

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
}

function writeCheck(repo, passes) {
  const source = passes
    ? "process.stdout.write('check passed\\n');\n"
    : [
      "process.stdout.write('setup context\\n');",
      "process.stderr.write('test/example.test.js:17:3 AssertionError: expected true\\n');",
      'process.exitCode = 1;',
      '',
    ].join('\n');
  fs.writeFileSync(path.join(repo, 'check.js'), source, 'utf8');
}

function tickPrompt(lastCheckFeedback) {
  return buildTickPrompt(
    {
      id: 'mission-feedback',
      objective: 'show failed checks to the next worker',
      owner: 'alice',
      cadence: 'manual',
      status: 'running',
      last_check_feedback: lastCheckFeedback,
    },
    2,
    4,
    { lane: 'code', verifier: 'node check.js' },
  );
}

test('extractCheckFeedback returns nothing for a pass or empty failed output', () => {
  assert.equal(extractCheckFeedback({ passed: true, stderr: 'Error: stale output' }), '');
  assert.equal(extractCheckFeedback({ passed: false, stdout: '', stderr: '' }), '');
  assert.equal(extractCheckFeedback(null), '');
});

test('extractCheckFeedback puts useful lines first without reordering their source order', () => {
  const feedback = extractCheckFeedback({
    passed: false,
    output: [
      'starting check',
      'test/one.test.js:12:4 expected 2 but received 3',
      'ordinary context',
      'AssertionError: values differ',
      'last detail',
    ].join('\n'),
  });

  assert.deepEqual(feedback.split('\n'), [
    'test/one.test.js:12:4 expected 2 but received 3',
    'AssertionError: values differ',
    'starting check',
    'ordinary context',
    'last detail',
  ]);
});

test('extractCheckFeedback caps long output and marks the trim', () => {
  const feedback = extractCheckFeedback({
    passed: false,
    stderr: Array.from({ length: 80 }, (_, index) => `Error ${index}: ${'x'.repeat(40)}`).join('\n'),
  });

  assert.ok(feedback.length <= 1500);
  assert.match(feedback, /output trimmed$/);
});

test('failed check feedback is set, cleared, and preserved across both tick save paths', () => {
  const { base, repo } = makeRepo();
  try {
    writeCheck(repo, false);
    const started = runCli([
      'mission', 'start', 'check feedback persistence',
      '--owner', 'alice',
      '--runner', 'claude',
      '--verify', 'node check.js',
      '--json',
    ], repo);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const automated = runCli([
      'mission', 'run', mission.id,
      '--no-claude',
      '--max-ticks', '1',
      '--json',
    ], repo);
    assert.equal(automated.status, 0, automated.stderr || automated.stdout);
    const automatedMission = JSON.parse(automated.stdout).mission;
    assert.match(automatedMission.last_check_feedback, /test\/example\.test\.js:17:3 AssertionError: expected true/);

    writeCheck(repo, true);
    const passing = runCli(['mission', 'tick', mission.id, '--verify', '--json'], repo);
    assert.equal(passing.status, 0, passing.stderr || passing.stdout);
    assert.equal(JSON.parse(passing.stdout).mission.last_check_feedback, '');

    writeCheck(repo, false);
    const failing = runCli(['mission', 'tick', mission.id, '--verify', '--json'], repo);
    assert.equal(failing.status, 0, failing.stderr || failing.stdout);
    const failedFeedback = JSON.parse(failing.stdout).mission.last_check_feedback;
    assert.match(failedFeedback, /AssertionError: expected true/);

    const unverified = runCli(['mission', 'tick', mission.id, '--json'], repo);
    assert.equal(unverified.status, 0, unverified.stderr || unverified.stdout);
    assert.equal(JSON.parse(unverified.stdout).mission.last_check_feedback, failedFeedback);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('buildTickPrompt includes failed check feedback only when it exists', () => {
  const present = tickPrompt('test/example.test.js:17:3 AssertionError: expected true');
  assert.match(present, /## errors from the last check/);
  assert.match(present, /the last check failed\. these are the real errors\. fix these first\./);
  assert.match(present, /test\/example\.test\.js:17:3 AssertionError: expected true/);

  const absent = tickPrompt('');
  assert.doesNotMatch(absent, /## errors from the last check/);
  assert.doesNotMatch(absent, /the last check failed/);
});
