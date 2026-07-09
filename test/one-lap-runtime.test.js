'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const ASK = 'fix the auth bug';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout || 45000,
  });
  if (result.error) throw result.error;
  return result;
}

function git(args, cwd, env) {
  const result = run('git', args, { cwd, env });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function cli(args, setup, timeout = 45000) {
  return run(process.execPath, [cliPath, ...args], { cwd: setup.workspace, env: setup.env, timeout });
}

function cliAsync(args, setup, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: setup.workspace,
      env: setup.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`one-lap child timed out after ${timeout}ms`));
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function waitForFile(file, timeout = 10000) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function json(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label} did not return one json object\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function fakeCodexScript() {
  return `#!/bin/sh
set -eu
count=0
if [ -f "$ATRIS_ENGINE_COUNT" ]; then count=$(cat "$ATRIS_ENGINE_COUNT"); fi
count=$((count + 1))
printf '%s\n' "$count" > "$ATRIS_ENGINE_COUNT"
printf 'mode=%s\n%s\n' "\${ATRIS_ENGINE_MODE:-pass}" "$*" > "$ATRIS_ENGINE_PROMPT"
if [ -n "\${ATRIS_ENGINE_DELAY:-}" ]; then sleep "$ATRIS_ENGINE_DELAY"; fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "restaff" ] && [ "$(basename "$0")" = "codex" ]; then
  printf 'usage limit reached\n' >&2
  exit 1
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "fail" ]; then
  printf 'wrong change\n' > wrong-change.txt
  git add wrong-change.txt
  git commit -m 'make the wrong lap change'
  printf 'committed wrong-change.txt\n'
  exit 0
fi
printf 'one lap\n' > lap-marker.txt
git add lap-marker.txt
git commit -m 'fix the lap marker test'
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "push" ]; then
  if git push origin HEAD:master; then
    printf 'pushed\n' > "$ATRIS_PUSH_RESULT"
  else
    printf 'blocked\n' > "$ATRIS_PUSH_RESULT"
  fi
fi
printf 'committed lap-marker.txt\n'
`;
}

function fakeValidatorScript() {
  return `#!/bin/sh
set -eu
count=0
if [ -f "$ATRIS_VALIDATOR_COUNT" ]; then count=$(cat "$ATRIS_VALIDATOR_COUNT"); fi
count=$((count + 1))
printf '%s\n' "$count" > "$ATRIS_VALIDATOR_COUNT"
printf '%s\n' "$*" > "$ATRIS_VALIDATOR_PROMPT"
case "\${ATRIS_VALIDATOR_MODE:-signoff}" in
  reject)
    printf 'reviewed the isolated diff\nREJECT: the diff does not satisfy the task\n'
    ;;
  mutate)
    printf 'validator mutation\n' >> README.md
    printf 'SIGNOFF: verifier passed and the diff matches the task\n'
    ;;
  outage)
    printf 'usage limit reached\n' >&2
    exit 1
    ;;
  *)
    printf 'reviewed the isolated diff and verifier\nSIGNOFF: committed diff matches the task and verifier passed\n'
    ;;
esac
`;
}

function setupRuntime(mode) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `atris-one-lap-${mode}-`));
  const workspace = path.join(base, 'workspace');
  const origin = path.join(base, 'origin.git');
  const home = path.join(base, 'home');
  const fakeBin = path.join(base, 'bin');
  const db = path.join(base, 'tasks.db');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  const codex = path.join(fakeBin, 'codex');
  fs.writeFileSync(codex, fakeCodexScript(), { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'cursor-agent'), fakeCodexScript(), { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'claude'), fakeValidatorScript(), { mode: 0o755 });
  const env = {
    ...scrubAgentEnv(),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    ATRIS_TASKS_DB: db,
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_ENGINE_MODE: mode,
    ATRIS_ENGINE_COUNT: path.join(base, 'engine-count.txt'),
    ATRIS_ENGINE_PROMPT: path.join(base, 'engine-prompt.txt'),
    ATRIS_VALIDATOR_MODE: mode === 'validator-reject' ? 'reject' : (mode === 'validator-mutate' ? 'mutate' : 'signoff'),
    ATRIS_VALIDATOR_COUNT: path.join(base, 'validator-count.txt'),
    ATRIS_VALIDATOR_PROMPT: path.join(base, 'validator-prompt.txt'),
    ATRIS_PUSH_RESULT: path.join(base, 'push-result.txt'),
    NODE_NO_WARNINGS: '1',
    USER: 'lap-test',
  };
  delete env.NODE_TEST_CONTEXT;

  git(['init', '-b', 'master'], workspace, env);
  git(['config', 'user.email', 'one-lap@example.invalid'], workspace, env);
  git(['config', 'user.name', 'One Lap Test'], workspace, env);
  const initialized = cli(['init', '--yes'], { workspace, env });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  fs.writeFileSync(path.join(workspace, 'atris', 'MAP.md'), '# MAP.md\n\n- runtime: test/lap-marker.test.js:1\n');
  fs.mkdirSync(path.join(workspace, 'test'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# One lap runtime\n');
  fs.writeFileSync(path.join(workspace, 'test', 'lap-marker.test.js'), [
    "'use strict';",
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "test('lap marker records one lap', () => {",
    "  const marker = path.resolve(__dirname, '..', 'lap-marker.txt');",
    "  assert.equal(fs.readFileSync(marker, 'utf8'), 'one lap\\n');",
    "});",
    '',
  ].join('\n'));
  const profile = path.join(workspace, '.atris', 'state', 'context_profile.json');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, JSON.stringify({ schema: 'atris.context_profile.v1', first_answer: 'maintain this test workspace' }, null, 2) + '\n');

  git(['add', '.'], workspace, env);
  assert.equal(git(['ls-files', 'test/lap-marker.test.js'], workspace, env), 'test/lap-marker.test.js');
  git(['commit', '-m', 'initial one lap workspace'], workspace, env);
  git(['init', '--bare', '--initial-branch=master', origin], base, env);
  git(['remote', 'add', 'origin', origin], workspace, env);
  git(['push', '-u', 'origin', 'master'], workspace, env);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'], workspace, env);
  const masterBefore = git(['rev-parse', 'origin/master'], workspace, env);
  const sentinelResult = cli(['task', 'new', 'unrelated sentinel stays open', '--tag', 'test', '--json'], { workspace, env });
  assert.equal(sentinelResult.status, 0, sentinelResult.stderr || sentinelResult.stdout);
  const sentinelPayload = json(sentinelResult, 'sentinel task');
  return {
    base,
    workspace,
    origin,
    env,
    masterBefore,
    sentinel: sentinelPayload.task && sentinelPayload.task.display_id || sentinelPayload.task_id,
    worktrees: [],
  };
}

function cleanupRuntime(setup) {
  if (!setup) return;
  for (const worktree of setup.worktrees || []) {
    run('git', ['worktree', 'remove', '--force', worktree], { cwd: setup.workspace, env: setup.env });
  }
  run('git', ['worktree', 'prune'], { cwd: setup.workspace, env: setup.env });
  fs.rmSync(setup.base, { recursive: true, force: true });
}

function assertMasterUnchanged(setup) {
  assert.equal(git(['rev-parse', 'origin/master'], setup.workspace, setup.env), setup.masterBefore);
  const marker = run('git', ['--git-dir', setup.origin, 'show', 'master:lap-marker.txt'], { cwd: setup.base, env: setup.env });
  assert.notEqual(marker.status, 0, 'default one lap must not change origin/master');
}

test('one natural sentence runs one real isolated lap to verified Review without merging master', { timeout: 60000 }, () => {
  const setup = setupRuntime('pass');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'one lap success');
    assert.equal(payload.schema, 'atris.one_lap.v1');
    assert.equal(payload.status, 'done');
    assert.equal(payload.ok, true);
    assert.equal(payload.engine, 'codex');
    assert.equal(payload.validator, 'claude');
    assert.equal(payload.verifier, 'node --test');
    assert.equal(payload.mission_status, 'ready');
    assert.equal(payload.approval_status, 'pending');
    assert.equal(payload.master_changed, false);
    assert.equal(payload.result.passed, true);
    assert.match(result.stderr, /navigator is scoping the request/);
    assert.match(result.stderr, /codex is building/);
    assert.doesNotMatch(result.stderr, /[—–✓✔✗✖⏸·→]/);
    assert.doesNotMatch(result.stdout, /CONTEXT LOADED|DIRECT REQUEST/);
    setup.worktrees.push(payload.worktree);

    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1');
    const prompt = fs.readFileSync(setup.env.ATRIS_ENGINE_PROMPT, 'utf8');
    assert.match(prompt, new RegExp(ASK));
    assert.match(prompt, /Trusted verifier.*node --test/);
    const validatorPrompt = fs.readFileSync(setup.env.ATRIS_VALIDATOR_PROMPT, 'utf8');
    assert.match(validatorPrompt, /independent validator/);
    assert.match(validatorPrompt, /Required verifier: node --test/);
    assert.match(validatorPrompt, /--allowedTools Bash,Read,Grep,Glob/);
    assert.equal(fs.readFileSync(path.join(payload.worktree, 'lap-marker.txt'), 'utf8'), 'one lap\n');
    const verified = run(process.execPath, ['--test'], { cwd: payload.worktree, env: setup.env });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);

    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'one lap task');
    assert.equal(task.status, 'review');
    assert.equal(task.review.approval_status, 'pending');
    const sentinel = json(cli(['task', 'show', setup.sentinel, '--json'], setup), 'sentinel');
    assert.equal(sentinel.status, 'open');

    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.schema, 'atris.dispatch_receipt.v1');
    assert.equal(receipt.context.ask, ASK);
    assert.equal(receipt.context.wish_id, payload.wish_id);
    assert.equal(receipt.context.mission_id, payload.mission_id);
    assert.equal(receipt.result.passed, true);
    assert.equal(receipt.result.verifier_result.command, 'node --test');
    assert.equal(receipt.result.verifier_result.status, 0);
    assert.match(receipt.result.verifier_result.output, /pass 1/);
    assert.deepEqual({
      engine: receipt.result.validator_result.engine,
      executor_engine: receipt.result.validator_result.executor_engine,
      independent: receipt.result.validator_result.independent,
      passed: receipt.result.validator_result.passed,
      verdict: receipt.result.validator_result.verdict,
      worktree_unchanged: receipt.result.validator_result.worktree_unchanged,
    }, {
      engine: 'claude',
      executor_engine: 'codex',
      independent: true,
      passed: true,
      verdict: 'signoff',
      worktree_unchanged: true,
    });
    assertMasterUnchanged(setup);

    const repeated = cli([ASK, '--engine=codex', '--json'], setup);
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assert.equal(json(repeated, 'resumed one lap').resumed, true);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1', 'duplicate ask must not run another engine');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1', 'duplicate ask must not run another validator');

    const textResult = cli([ASK], setup);
    assert.equal(textResult.status, 0, textResult.stderr || textResult.stdout);
    assert.match(textResult.stdout, /^lap: done$/m);
    assert.match(textResult.stdout, /^changed:/m);
    assert.match(textResult.stdout, /^how i checked: node --test passed$/m);
    assert.match(textResult.stdout, /^proof: atris\/runs\/dispatch-/m);
    assert.match(textResult.stdout, /^next: cd .+atris worktree ship /m);
    assert.doesNotMatch(textResult.stdout, /CONTEXT LOADED|DIRECT REQUEST|[—–✓✔✗✖⏸·→]/);

    fs.unlinkSync(path.join(setup.workspace, payload.receipt));
    const missingProof = cli([ASK, '--json'], setup);
    assert.equal(missingProof.status, 1, missingProof.stderr || missingProof.stdout);
    const missingPayload = json(missingProof, 'missing one-lap proof');
    assert.equal(missingPayload.status, 'stuck');
    assert.match(missingPayload.reason, /without a passing matching one-lap receipt/);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap keeps the worktree and proof receipt when the real verifier fails', { timeout: 60000 }, () => {
  const setup = setupRuntime('fail');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    const engineTrace = fs.existsSync(setup.env.ATRIS_ENGINE_PROMPT)
      ? fs.readFileSync(setup.env.ATRIS_ENGINE_PROMPT, 'utf8')
      : '(no engine trace)';
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nengine:\n${engineTrace}`);
    const payload = json(result, 'one lap failure');
    assert.equal(payload.status, 'stuck');
    assert.equal(payload.ok, false);
    assert.equal(payload.checked, 'node --test failed (exit 1)');
    assert.ok(payload.worktree);
    setup.worktrees.push(payload.worktree);
    assert.ok(fs.existsSync(payload.worktree), 'failed worktree must remain available');

    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'failed one lap task');
    assert.notEqual(task.status, 'review');
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.result.passed, false);
    assert.equal(receipt.result.verifier_result.command, 'node --test');
    assert.equal(receipt.result.verifier_result.status, 1);
    assert.match(receipt.result.verifier_result.output, /ENOENT|lap-marker\.txt/);
    assert.ok(!fs.existsSync(setup.env.ATRIS_VALIDATOR_COUNT), 'validator must not run after verifier failure');
    assertMasterUnchanged(setup);

    setup.env.ATRIS_ENGINE_MODE = 'pass';
    const resumed = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(resumed.status, 0, `stdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`);
    const resumedPayload = json(resumed, 'resumed failed one lap');
    assert.equal(resumedPayload.status, 'done');
    assert.equal(resumedPayload.task_id, payload.task_id);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '2');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1');
    setup.worktrees.push(resumedPayload.worktree);
    const resumedTask = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'resumed one lap task');
    assert.equal(resumedTask.status, 'review');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('identical asks in separate processes run one atomic lap', { timeout: 60000 }, async () => {
  const setup = setupRuntime('pass');
  try {
    setup.env.ATRIS_ENGINE_DELAY = '1';
    const firstRun = cliAsync([ASK, '--engine', 'codex', '--json'], setup);
    await waitForFile(setup.env.ATRIS_ENGINE_PROMPT);

    const concurrent = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(concurrent.status, 0, concurrent.stderr || concurrent.stdout);
    const concurrentPayload = json(concurrent, 'concurrent one lap');
    assert.equal(concurrentPayload.status, 'waiting_input');
    assert.equal(concurrentPayload.question, 'an identical lap is already running');
    assert.equal(concurrentPayload.resumed, true);

    const first = await firstRun;
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    const firstPayload = json(first, 'first atomic one lap');
    assert.equal(firstPayload.status, 'done');
    setup.worktrees.push(firstPayload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1');

    const events = fs.readFileSync(path.join(setup.workspace, '.atris', 'state', 'wishes.jsonl'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const capturedIds = new Set(events
      .filter((event) => event.text === ASK && event.status === 'captured')
      .map((event) => event.id));
    assert.equal(capturedIds.size, 1, 'one ask lease must create one durable wish');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap blocks an engine git push before recording Review', { timeout: 60000 }, () => {
  const setup = setupRuntime('push');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'push-blocked one lap');
    assert.equal(payload.status, 'done');
    assert.equal(payload.validator, 'claude');
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'blocked');
    assert.ok(payload.worktree);
    setup.worktrees.push(payload.worktree);
    assertMasterUnchanged(setup);
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.ready[0].master_before, setup.masterBefore);
    assert.equal(receipt.ready[0].master_after, setup.masterBefore);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap reports the engine that actually completed a restaffed build', { timeout: 60000 }, () => {
  const setup = setupRuntime('restaff');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'restaffed one lap');
    assert.equal(payload.engine, 'cursor');
    assert.equal(payload.validator, 'claude');
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '2');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1');
    setup.worktrees.push(payload.worktree);
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.ready[0].engine, 'cursor');
    assert.deepEqual(receipt.ready[0].restaffed, { from: 'codex', to: 'cursor', reason: 'usage_limit' });

    const repeated = json(cli([ASK, '--json'], setup), 'resumed restaffed one lap');
    assert.equal(repeated.engine, 'cursor');
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap keeps proof out of Review when the independent validator rejects', { timeout: 60000 }, () => {
  const setup = setupRuntime('validator-reject');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'validator rejection');
    assert.equal(payload.status, 'stuck');
    assert.equal(payload.validator, 'claude');
    assert.equal(payload.checked, 'node --test passed (exit 0)');
    assert.match(payload.reason, /does not satisfy the task/);
    assert.ok(payload.worktree);
    setup.worktrees.push(payload.worktree);

    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'validator rejected task');
    assert.equal(task.status, 'claimed');
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.result.passed, false);
    assert.equal(receipt.result.verifier_result.passed, true);
    assert.equal(receipt.result.validator_result.passed, false);
    assert.equal(receipt.result.validator_result.verdict, 'reject');
    assert.equal(receipt.ready.length, 0);
    assert.equal(receipt.paused[0].stage, 'validation_rejected');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});
