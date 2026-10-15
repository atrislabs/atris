'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function workspace(t, verdict = 'VERDICT: PASS') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-default-referee-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const binDir = path.join(base, 'bin');
  const reviewMark = path.join(base, 'reviewed');
  const reviewPrompt = path.join(base, 'review-prompt.txt');
  const tasksDb = path.join(base, 'tasks.db');
  fs.mkdirSync(path.join(root, 'atris', 'team', 'executor'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'executor', 'MEMBER.md'), '---\nname: executor\nrole: Test Member\n---\n\n# executor\n', 'utf8');
  // The builder is claude and writes the work; the reviewer is codex and leaves a mark.
  fs.writeFileSync(path.join(binDir, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    'echo "done" > work.txt',
    'echo \'{"type":"result","is_error":false,"result":"wrote work.txt"}\'',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(binDir, 'codex'), `#!/bin/sh\ntouch "${reviewMark}"\nprintf '%s\\n' "$@" >> "${reviewPrompt}"\necho "${verdict}"\n`, 'utf8');
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  fs.chmodSync(path.join(binDir, 'codex'), 0o755);
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  const env = { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: tasksDb, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` };
  const run = (extra) => spawnSync(process.execPath, [
    cliPath, 'member', 'run', 'executor', 'Write work.txt',
    '--engine', 'claude', '--referee-engine', 'codex', '--shared-checkout',
    '--ignite', '--verify', 'test -s work.txt', '--json', ...extra,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env,
  });
  return { run, reviewMark, reviewPrompt, root, env };
}

test('an ignited member run gets a second-engine review without asking for one', (t) => {
  const { run, reviewMark } = workspace(t);
  const res = run([]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.ok(fs.existsSync(reviewMark), 'the reviewer engine should have run');
  assert.equal(payload.ticks[0].referee_result.passed, true);
  assert.equal(payload.ticks[0].referee_result.engine, 'codex');
});

test('--no-referee skips the second-engine review on an ignited run', (t) => {
  const { run, reviewMark } = workspace(t);
  const res = run(['--no-referee']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.ok(!fs.existsSync(reviewMark), 'the reviewer engine should not have run');
  assert.ok(!payload.ticks[0].referee_result, 'no review verdict should be recorded');
});

test('only an ignited run defaults the review on, and an explicit choice wins', () => {
  const { memberRunWantsReferee } = require('../commands/member');
  assert.equal(memberRunWantsReferee([], true), true);
  assert.equal(memberRunWantsReferee(['--no-referee'], true), false);
  assert.equal(memberRunWantsReferee(['--referee'], true), false, 'already present, no duplicate');
  assert.equal(memberRunWantsReferee([], false), false);
});

test('naming the builder as its own reviewer still gets a different engine', () => {
  const mission = require('../commands/mission');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-referee-pick-'));
  try {
    for (const runner of ['claude', 'codex']) {
      assert.notEqual(mission.pickCrossEngineVerifier({ runner }, base, runner), runner);
      assert.notEqual(mission.pickCrossEngineVerifier({ runner, referee_engine: runner }, base), runner);
    }
    assert.equal(mission.pickCrossEngineVerifier({ runner: 'claude' }, base, 'codex'), 'codex', 'a different named reviewer is kept');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the default reviewer is never the builder engine, even when the usual pick is down', () => {
  const mission = require('../commands/mission');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-referee-pick-'));
  try {
    for (const runner of ['claude', 'codex', 'fable', 'cursor']) {
      const picked = mission.pickCrossEngineVerifier({ runner }, base);
      assert.notEqual(picked, runner, `${runner} must not review its own work`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('work the reviewer turns down says so with its reason, not that the check failed', (t) => {
  const { run } = workspace(t, 'VERDICT: FAIL; the new file is empty on a second run');
  const res = run([]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.error, 'turned down in review: the new file is empty on a second run');
});

test('the reviewer checks every part of done-looks-like and turns down work that does only some', (t) => {
  const { run, root, env, reviewPrompt } = workspace(t, 'VERDICT: FAIL; missing: notes.txt lists what changed');
  const made = spawnSync(process.execPath, [
    cliPath, 'task', 'new', 'Write work.txt',
    '--done-looks-like', 'work.txt says done, and notes.txt lists what changed', '--json',
  ], { cwd: root, encoding: 'utf8', env });
  assert.equal(made.status, 0, made.stderr || made.stdout);
  const res = run([]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const prompt = fs.readFileSync(reviewPrompt, 'utf8');
  assert.match(prompt, /The job says done looks like: work\.txt says done, and notes\.txt lists what changed/);
  assert.match(prompt, /Split that line into each separate thing it promises and check every one/);
  assert.match(prompt, /Work that does only some of the parts is not done/);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.error, 'turned down in review: missing: notes.txt lists what changed');
});
