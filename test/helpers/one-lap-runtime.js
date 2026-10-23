'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./agent-env');

const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const ASK = 'fix the auth bug';
// a lap runs dozens of git and node steps; on a busy mac one step alone can take
// most of a minute, so the bound only needs to catch a real hang.
const LAP_STEP_TIMEOUT_MS = 180000;
const LAP_TEST_TIMEOUT_MS = LAP_STEP_TIMEOUT_MS * 4;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout || LAP_STEP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return result;
}

function git(args, cwd, env) {
  const result = run('git', args, { cwd, env });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function cli(args, setup, timeout = LAP_STEP_TIMEOUT_MS) {
  return run(process.execPath, [cliPath, ...args], { cwd: setup.workspace, env: setup.env, timeout });
}

function cliAsync(args, setup, timeout = LAP_STEP_TIMEOUT_MS) {
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

async function waitForFile(file, timeout = LAP_STEP_TIMEOUT_MS) {
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
case "$*" in
  *"--model claude-haiku-5-5"*)
    printf '{}\n'
    exit 0
    ;;
esac
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

function setupRuntime(mode, mainBranch = 'master') {
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
    // These tests assert exact engine/validator run counts and a stable
    // origin/master for the foreground lap. Wish delegation also spawns a
    // detached `atris mission run` driver (lib/wish-delegate.js ->
    // spawnMissionDriver) because NODE_TEST_CONTEXT is scrubbed below; that
    // driver races the foreground lap (extra engine legs, unsandboxed
    // dispatch, concurrent landings) and made whole-file runs flaky.
    ATRIS_WISH_NO_DRIVER: '1',
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

  git(['init', '-b', mainBranch], workspace, env);
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
  git(['init', '--bare', `--initial-branch=${mainBranch}`, origin], base, env);
  git(['remote', 'add', 'origin', origin], workspace, env);
  git(['push', '-u', 'origin', mainBranch], workspace, env);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${mainBranch}`], workspace, env);
  const masterBefore = git(['rev-parse', `origin/${mainBranch}`], workspace, env);
  const sentinelResult = cli(['task', 'new', 'unrelated sentinel stays open', '--tag', 'test', '--json'], { workspace, env });
  assert.equal(sentinelResult.status, 0, sentinelResult.stderr || sentinelResult.stdout);
  const sentinelPayload = json(sentinelResult, 'sentinel task');
  return {
    base,
    workspace,
    origin,
    env,
    masterBefore,
    mainBranch,
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
  assert.equal(git(['--git-dir', setup.origin, 'rev-parse', setup.mainBranch], setup.base, setup.env), setup.masterBefore);
  assert.equal(git(['rev-parse', `origin/${setup.mainBranch}`], setup.workspace, setup.env), setup.masterBefore);
  const marker = run('git', ['--git-dir', setup.origin, 'show', `${setup.mainBranch}:lap-marker.txt`], { cwd: setup.base, env: setup.env });
  assert.notEqual(marker.status, 0, 'default one lap must not change origin/master');
}

module.exports = { ASK, LAP_TEST_TIMEOUT_MS, cliPath, run, git, cli, cliAsync, waitForFile, json, setupRuntime, cleanupRuntime, assertMasterUnchanged };
