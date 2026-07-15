'use strict';

let test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) test = test.skip;

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
  while (!fs.existsSync(file) || fs.statSync(file).size === 0) {
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
  env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_VALUE_1 "$ATRIS_REAL_GIT" config --worktree --unset-all remote.origin.url || true
  env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_VALUE_1 "$ATRIS_REAL_GIT" config --worktree --unset-all remote.origin.pushurl || true
  env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_VALUE_1 "$ATRIS_REAL_GIT" remote get-url --push origin > "$ATRIS_PUSH_URL"
  env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_VALUE_1 "$ATRIS_REAL_GIT" config --show-origin --get-all remote.origin.pushurl > "$ATRIS_PUSH_CONFIG" || true
  if env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_VALUE_1 "$ATRIS_REAL_GIT" push origin HEAD:refs/atris/undetected; then
    printf 'pushed\n' > "$ATRIS_PUSH_RESULT"
  else
    printf 'blocked\n' > "$ATRIS_PUSH_RESULT"
  fi
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "forge-sidecar" ]; then
  common=$("$ATRIS_REAL_GIT" rev-parse --git-common-dir)
  printf '{"one_lap_remote":{"armed":true,"quarantine":"%s"}}\n' "$common" > .atris/agent-worktree.json
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "inspect-boundary" ]; then
  {
    "$ATRIS_REAL_GIT" config --show-origin --list
    "$ATRIS_REAL_GIT" rev-parse --git-common-dir
    env
    cat "$ATRIS_ENGINE_PROMPT"
  } > "$ATRIS_BOUNDARY_DUMP"
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "escape-primary" ]; then
  protected=$(dirname "$ATRIS_TASKS_DB")/workspace
  if "$ATRIS_REAL_GIT" -C "$protected" remote get-url origin >/dev/null 2>&1 && \
     "$ATRIS_REAL_GIT" push "$protected/../origin.git" HEAD:master >/dev/null 2>&1; then
    printf 'escaped\n' > "$ATRIS_PUSH_RESULT"
  else
    printf 'blocked\n' > "$ATRIS_PUSH_RESULT"
  fi
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "smudge-filter" ]; then
  printf '*.txt filter=escape\n' > .gitattributes
  git add .gitattributes
  git commit -m 'add adversarial attributes'
  git config --global filter.escape.smudge "sh -c 'printf escaped > \"$ATRIS_PUSH_RESULT\"; exit 1'"
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "persist-home" ]; then
  real_home=$(dirname "$ATRIS_TASKS_DB")/home
  read_ok=0
  write_ok=0
  cat "$real_home/.codex/session-secret.txt" >/dev/null 2>&1 && read_ok=1
  printf injected > "$real_home/.codex/config-injected.toml" 2>/dev/null && write_ok=1
  if [ "$read_ok" -eq 0 ] && [ "$write_ok" -eq 0 ]; then
    printf 'blocked\n' > "$ATRIS_PUSH_RESULT"
  else
    printf 'escaped\n' > "$ATRIS_PUSH_RESULT"
  fi
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "reserved-symlink" ]; then
  rm -rf .atris
  ln -s /tmp/one-lap-reserved-target .ATRIS
  git add -A
  git commit -m 'replace reserved metadata path'
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "unicode-reserved-symlink" ]; then
  reserved=$(printf '.atri\\305\\277')
  rm -rf .atris
  ln -s /tmp/one-lap-reserved-target "$reserved"
  git add -A
  git commit -m 'replace unicode-colliding metadata path'
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "late-mutate" ]; then
  nohup /bin/sh -c 'sleep 1; printf late > late.txt; git add late.txt; git commit -m "late detached mutation"' >/dev/null 2>&1 &
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "session-escape" ]; then
  node -e 'const { spawn } = require("node:child_process"); spawn("/bin/sh", ["-c", "sleep 1; printf escaped > $ATRIS_PUSH_RESULT"], { detached: true, stdio: "ignore", env: process.env }).unref();'
fi
if [ "\${ATRIS_ENGINE_MODE:-pass}" = "kill-lifecycle" ]; then
  nohup /bin/sh -c 'sleep 1; printf escaped > "$ATRIS_PUSH_RESULT"' >/dev/null 2>&1 &
  /usr/bin/perl -MPOSIX -e '$group = POSIX::getpgrp(); kill 9, $group'
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
    git config --local atris.validator-mutated true
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
  if (mode === 'persist-home') {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'session-secret.txt'), 'do not expose\n');
  }

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
    ATRIS_PUSH_URL: path.join(base, 'push-url.txt'),
    ATRIS_PUSH_CONFIG: path.join(base, 'push-config.txt'),
    ATRIS_BOUNDARY_DUMP: path.join(base, 'boundary-dump.txt'),
    ATRIS_REAL_GIT: spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(),
    NODE_NO_WARNINGS: '1',
    USER: 'lap-test',
  };
  delete env.NODE_TEST_CONTEXT;
  for (const key of [
    'ATRIS_ENGINE_COUNT', 'ATRIS_ENGINE_PROMPT', 'ATRIS_VALIDATOR_COUNT', 'ATRIS_VALIDATOR_PROMPT',
    'ATRIS_PUSH_RESULT', 'ATRIS_PUSH_URL', 'ATRIS_PUSH_CONFIG', 'ATRIS_BOUNDARY_DUMP',
  ]) {
    fs.writeFileSync(env[key], '');
  }

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
  if (mode === 'verifier-escape') {
    fs.writeFileSync(path.join(workspace, 'test', 'verifier-escape.test.js'), [
      "'use strict';",
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { spawnSync } = require('node:child_process');",
      "test('verifier cannot reach the protected checkout', () => {",
      "  const base = path.dirname(process.env.ATRIS_TASKS_DB);",
      "  const origin = path.join(base, 'origin.git');",
      "  const pushed = spawnSync(process.env.ATRIS_REAL_GIT, ['push', origin, 'HEAD:master'], { encoding: 'utf8' });",
      "  fs.writeFileSync(process.env.ATRIS_PUSH_RESULT, pushed.status === 0 ? 'escaped\\n' : 'blocked\\n');",
      "  assert.notEqual(pushed.status, 0, pushed.stderr || 'protected push unexpectedly succeeded');",
      "});",
      '',
    ].join('\n'));
  }
  if (mode === 'late-mutate') {
    fs.writeFileSync(path.join(workspace, 'test', 'late-delay.test.js'), [
      "'use strict';",
      "const test = require('node:test');",
      "test('keeps the verifier open long enough to expose late children', () => {",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);",
      "});",
      '',
    ].join('\n'));
  }
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
    if (!path.resolve(worktree).startsWith(`${path.resolve(setup.base)}${path.sep}`) && path.basename(worktree) === 'worktree') {
      fs.rmSync(path.dirname(worktree), { recursive: true, force: true });
    }
  }
  run('git', ['worktree', 'prune'], { cwd: setup.workspace, env: setup.env });
  fs.rmSync(setup.base, { recursive: true, force: true });
}

function assertMasterUnchanged(setup) {
  assert.equal(git(['--git-dir', setup.origin, 'rev-parse', 'master'], setup.base, setup.env), setup.masterBefore);
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
    assert.equal(git(['cat-file', '-t', receipt.ready[0].change.source_commit], payload.worktree, setup.env), 'commit');
    assert.equal(git(['rev-parse', receipt.ready[0].change.proof_ref], payload.worktree, setup.env), receipt.ready[0].change.source_commit);
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
    assert.equal(path.resolve(git(['remote', 'get-url', '--push', 'origin'], payload.worktree, setup.env)), path.resolve(setup.origin));
    const sidecar = JSON.parse(fs.readFileSync(path.join(payload.worktree, '.atris', 'agent-worktree.json'), 'utf8'));
    assert.equal(sidecar.one_lap_remote, undefined);
    const shipPreview = run(process.execPath, [
      cliPath,
      'worktree', 'ship',
      '--dry-run',
      '--message', 'ship verified one lap',
      '--target', 'origin/master',
    ], { cwd: payload.worktree, env: setup.env });
    assert.equal(shipPreview.status, 0, shipPreview.stderr || shipPreview.stdout);
    assert.match(shipPreview.stdout, /done: worktree shipped/);

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

test('one lap honors trusted operator Git URL rewrites for protected remote access', { timeout: 60000 }, () => {
  const setup = setupRuntime('pass');
  try {
    git(['config', '--global', `url.${setup.origin}.insteadOf`, 'one-lap://protected/'], setup.workspace, setup.env);
    git(['remote', 'set-url', 'origin', 'one-lap://protected/'], setup.workspace, setup.env);
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'rewritten remote one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(payload.status, 'done');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap keeps the worktree and proof receipt when the real verifier fails', { timeout: 60000 }, () => {
  const setup = setupRuntime('fail');
  try {
    const worktreesBefore = git(['worktree', 'list', '--porcelain'], setup.workspace, setup.env)
      .split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length;
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
    const worktreesAfter = git(['worktree', 'list', '--porcelain'], setup.workspace, setup.env)
      .split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length;
    assert.equal(worktreesAfter, worktreesBefore, 'failed lap must not leak a hidden protected-origin worktree');

    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'failed one lap task');
    assert.notEqual(task.status, 'review');
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.result.passed, false);
    assert.equal(receipt.result.verifier_result.command, 'node --test');
    assert.equal(receipt.result.verifier_result.status, 1);
    assert.match(receipt.result.verifier_result.output, /ENOENT|lap-marker\.txt/);
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '', 'validator must not run after verifier failure');
    assertMasterUnchanged(setup);

    const downgraded = cli([ASK, '--engine', 'codex', '--verify', 'git diff --check', '--json'], setup);
    assert.equal(downgraded.status, 2, downgraded.stderr || downgraded.stdout);
    assert.match(json(downgraded, 'frozen verifier retry').reason, /verifier is frozen/);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1');
    const stillClaimed = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'frozen verifier task');
    assert.equal(stillClaimed.status, 'claimed');

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

test('one lap freezes the repo default verifier before dispatch', { timeout: 60000 }, () => {
  const setup = setupRuntime('pass');
  try {
    fs.rmSync(path.join(setup.workspace, 'test'), { recursive: true, force: true });
    git(['add', '-A'], setup.workspace, setup.env);
    git(['commit', '-m', 'remove project verifier for retry test'], setup.workspace, setup.env);
    git(['push', 'origin', 'master'], setup.workspace, setup.env);
    setup.masterBefore = git(['rev-parse', 'origin/master'], setup.workspace, setup.env);

    const initial = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    const payload = json(initial, 'one lap default verifier');
    assert.equal(payload.status, 'done');
    assert.equal(payload.verifier, 'git diff --check');
    setup.worktrees.push(payload.worktree);

    const missions = fs.readFileSync(path.join(setup.workspace, '.atris', 'state', 'missions.jsonl'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const frozen = missions.filter((row) => row.id === payload.mission_id).at(-1);
    assert.equal(frozen.verifier, 'git diff --check');

    const replaced = cli([ASK, '--engine', 'codex', '--verify', 'node --check missing.js', '--json'], setup);
    assert.equal(replaced.status, 2, replaced.stderr || replaced.stdout);
    assert.match(json(replaced, 'replaced retry verifier').reason, /verifier is frozen/);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('identical asks in separate processes run one atomic lap', { timeout: 60000 }, async () => {
  const setup = setupRuntime('pass');
  try {
    setup.env.ATRIS_ENGINE_DELAY = '5';
    const firstRun = cliAsync([ASK, '--engine', 'codex', '--json'], setup);
    await waitForFile(setup.env.ATRIS_ENGINE_PROMPT);

    const concurrent = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(concurrent.status, 0, concurrent.stderr || concurrent.stdout);
    const concurrentPayload = json(concurrent, 'concurrent one lap');
    assert.ok(['waiting_input', 'done'].includes(concurrentPayload.status));
    if (concurrentPayload.status === 'waiting_input') {
      assert.equal(concurrentPayload.question, 'an identical lap is already running');
    }
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
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'push-blocked one lap');
    assert.equal(payload.status, 'stuck');
    assert.equal(payload.validator, 'claude');
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'pushed');
    assert.notEqual(path.resolve(fs.readFileSync(setup.env.ATRIS_PUSH_URL, 'utf8').trim()), path.resolve(setup.origin));
    assert.match(payload.reason, /quarantined remote/);
    assert.ok(payload.worktree);
    setup.worktrees.push(payload.worktree);
    assertMasterUnchanged(setup);
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.ready.length, 0);
    assert.equal(receipt.paused[0].stage, 'outbound_attempt');
    assert.equal(receipt.paused[0].master_before, setup.masterBefore);
    assert.equal(receipt.paused[0].master_after, setup.masterBefore);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap ignores a worker-forged quarantine deletion sidecar', { timeout: 60000 }, () => {
  const setup = setupRuntime('forge-sidecar');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'forged sidecar one lap');
    setup.worktrees.push(payload.worktree);
    const sidecar = JSON.parse(fs.readFileSync(path.join(payload.worktree, '.atris', 'agent-worktree.json'), 'utf8'));
    assert.equal(sidecar.one_lap_remote, undefined);
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], payload.worktree, setup.env), 'true');
    assert.equal(path.resolve(git(['remote', 'get-url', '--push', 'origin'], payload.worktree, setup.env)), path.resolve(setup.origin));
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap omits protected repository locators from the executor boundary', { timeout: 60000 }, () => {
  const setup = setupRuntime('inspect-boundary');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'boundary inspection one lap');
    setup.worktrees.push(payload.worktree);
    const dump = fs.readFileSync(setup.env.ATRIS_BOUNDARY_DUMP, 'utf8');
    assert.ok(!dump.includes(setup.workspace), 'executor boundary must not reveal the primary checkout');
    assert.ok(!dump.includes(setup.origin), 'executor boundary must not reveal the protected remote');
    assert.ok(!dump.includes(payload.worktree), 'executor boundary must not reveal the untouched landing worktree');
    assert.match(dump, /\/quarantine\.git/);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap OS boundary blocks an executor that knows the protected checkout path', { timeout: 60000 }, () => {
  const setup = setupRuntime('escape-primary');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'executor escape one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'blocked');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap OS boundary blocks a passing verifier from pushing protected master', { timeout: 60000 }, () => {
  const setup = setupRuntime('verifier-escape');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'verifier escape one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'blocked');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap raw tree import never executes worker-controlled Git filters', { timeout: 60000 }, () => {
  const setup = setupRuntime('smudge-filter');
  try {
    git(['config', 'filter.escape.clean', "sed 's/one/escaped/g'"], setup.workspace, setup.env);
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'smudge filter one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), '');
    assert.equal(fs.readFileSync(path.join(payload.worktree, '.gitattributes'), 'utf8'), '*.txt filter=escape\n');
    const shipped = run(process.execPath, [
      cliPath,
      'worktree', 'ship',
      '--message', 'ship filter-bound one lap',
      '--verify', 'node --test',
      '--local',
    ], { cwd: payload.worktree, env: setup.env });
    assert.equal(shipped.status, 3, shipped.stderr || shipped.stdout);
    assert.match(shipped.stderr, /one-lap index tree differs from the independently verified proof tree/);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap proof binding blocks a partially materialized landing from ship', { timeout: 60000 }, () => {
  const setup = setupRuntime('pass');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'partial landing one lap');
    setup.worktrees.push(payload.worktree);
    fs.rmSync(path.join(payload.worktree, 'lap-marker.txt'));
    const shipped = run(process.execPath, [
      cliPath,
      'worktree', 'ship',
      '--message', 'ship partial one lap',
      '--verify', 'node --test',
      '--local',
    ], { cwd: payload.worktree, env: setup.env });
    assert.equal(shipped.status, 3, shipped.stderr || shipped.stdout);
    assert.match(shipped.stderr, /one-lap index tree differs from the independently verified proof tree/);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap gives engines an ephemeral home and cannot persist agent config', { timeout: 60000 }, () => {
  const setup = setupRuntime('persist-home');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'ephemeral home one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'blocked');
    assert.equal(fs.readFileSync(path.join(setup.home || path.join(setup.base, 'home'), '.codex', 'session-secret.txt'), 'utf8'), 'do not expose\n');
    assert.equal(fs.existsSync(path.join(setup.base, 'home', '.codex', 'config-injected.toml')), false);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap rejects case-variant reserved metadata symlinks', { timeout: 60000 }, () => {
  const setup = setupRuntime('reserved-symlink');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'reserved symlink one lap');
    setup.worktrees.push(payload.worktree);
    assert.match(payload.reason, /conflicts with Atris worktree metadata|unsafe path/i);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap rejects Unicode paths that alias reserved metadata on APFS', { timeout: 60000 }, () => {
  const setup = setupRuntime('unicode-reserved-symlink');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(json(result, 'unicode reserved symlink one lap').reason, /non-ASCII path|could not be imported safely/i);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap reaps detached engine children before proof advances', { timeout: 60000 }, () => {
  const setup = setupRuntime('late-mutate');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'reaped child one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(payload.status, 'done');
    assert.equal(fs.existsSync(path.join(payload.worktree, 'late.txt')), false);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap reaps a detached child that creates a new session', { timeout: 60000 }, () => {
  const setup = setupRuntime('session-escape');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'new-session child one lap');
    setup.worktrees.push(payload.worktree);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), '');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap cleanup survives an engine killing its sandbox group leader', { timeout: 60000 }, () => {
  const setup = setupRuntime('kill-lifecycle');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'killed lifecycle one lap');
    if (payload.worktree) setup.worktrees.push(payload.worktree);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), '');
    assertMasterUnchanged(setup);
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

test('one lap blocks validator git metadata mutations before Review', { timeout: 60000 }, () => {
  const setup = setupRuntime('validator-mutate');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'validator metadata mutation');
    assert.equal(payload.status, 'stuck');
    assert.equal(payload.validator, 'claude');
    assert.match(payload.reason, /validator changed the worktree|Operation not permitted/i);
    setup.worktrees.push(payload.worktree);
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.result.passed, false);
    assert.equal(receipt.result.validator_result.worktree_unchanged, true);
    assert.equal(receipt.paused[0].stage, 'validator_failed');
    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'mutated validator task');
    assert.equal(task.status, 'claimed');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});
