const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('command fixtures ignore inherited runner commands', () => {
  const env = { ...process.env };
  // Run an independent test process, rather than inheriting the worker role.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-name-pattern=member run --minutes scales max-ticks',
    path.join(__dirname, 'commands.test.js'),
  ], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...env,
      ATRIS_RUNNER_COMMAND_TEMPLATE: 'node -e "process.exit(1)"',
      ATRIS_CLAUDE_COMMAND_TEMPLATE: 'node -e "process.exit(1)"',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pass 1/);
});

test('runner fixtures ignore inherited mission and caller settings', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test', path.join(__dirname, 'runner-model-leak.test.js'),
  ], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...env,
      ATRIS_RUNNER_PROFILE: 'codex',
      ATRIS_RUNNER_BIN: 'codex',
      ATRIS_RUNNER_COMMAND_TEMPLATE: 'node -e "process.exit(1)"',
      ATRIS_CLAUDE_COMMAND_TEMPLATE: 'node -e "process.exit(1)"',
      ATRIS_CALLER_RUNTIME: 'codex',
      CODEX_THREAD_ID: 'fixture-thread',
      CODEX_SESSION_ID: 'fixture-session',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pass 7/);
});

test('runner command checks ignore an inherited runner profile', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test', path.join(__dirname, 'runner-command.test.js'),
  ], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...env,
      ATRIS_RUNNER_PROFILE: 'codex',
      ATRIS_RUNNER_BIN: 'codex',
      ATRIS_CALLER_RUNTIME: 'codex',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /fail 0/);
});

test('roster routing checks ignore an inherited codex caller session', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test', path.join(__dirname, 'roster-markdown.test.js'),
  ], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...env,
      ATRIS_RUNNER_PROFILE: 'codex',
      ATRIS_CALLER_RUNTIME: 'codex',
      CODEX_THREAD_ID: 'fixture-thread',
      CODEX_SESSION_ID: 'fixture-session',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /fail 0/);
});

test('mission lock checks ignore inherited runner commands', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test', '--test-name-pattern=the mission lock names the live tick subprocess',
    path.join(__dirname, 'mission-run-reliability.test.js'),
  ], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...env,
      ATRIS_RUNNER_PROFILE: 'codex',
      ATRIS_CALLER_RUNTIME: 'codex',
      CODEX_THREAD_ID: 'fixture-thread',
      CODEX_SESSION_ID: 'fixture-session',
      ATRIS_RUNNER_COMMAND_TEMPLATE: 'node -e "process.exit(1)"',
      ATRIS_CLAUDE_COMMAND_TEMPLATE: 'node -e "process.exit(1)"',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pass 1/);
});
