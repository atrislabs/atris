const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');
const { reviewOnlyEngineEnvironment } = require('../lib/fleet');
const { resetOwnerIdentityCache } = require('../utils/owner-identity');

// reviewOnlyEngineEnvironment refuses to build an environment without the
// macOS sandbox-exec isolation backend, so this guarantee is only testable
// on darwin. Linux CI skips it rather than reporting a false failure.
test('claude flights never receive an api key, even when the parent env has one', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-test-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git remote add origin https://example.invalid/repo.git', { cwd: worktree });
  const hadKey = process.env.ANTHROPIC_API_KEY;
  const hadToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-test-should-never-pass-through';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'subscription-token';
  try {
    const env = reviewOnlyEngineEnvironment(worktree, { engine: 'claude' });
    assert.strictEqual(env.ANTHROPIC_API_KEY, '', 'api key must be stripped: subscription only');
    assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-token', 'subscription token passes through');
    assert.ok(env.TMPDIR, 'the sealed runtime has its own temp folder');
    assert.strictEqual(env.CLAUDE_CODE_TMPDIR, env.TMPDIR, 'claude keeps its temp files inside the sealed runtime, not /tmp');
  } finally {
    if (hadKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = hadKey;
    if (hadToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = hadToken;
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('a claude flight uses the login saved by atris idea login when the env has none', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-saved-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-state-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git remote add origin https://example.invalid/repo.git', { cwd: worktree });
  const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ATRIS_TEST_STATE_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let claudeEnv;
  let codexEnv;
  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ATRIS_TEST_STATE_DIR = state;
    require('../lib/engine-login').saveToken('saved-subscription-token');
    claudeEnv = reviewOnlyEngineEnvironment(worktree, { engine: 'claude' });
    codexEnv = reviewOnlyEngineEnvironment(worktree, { engine: 'codex' });
    assert.strictEqual(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN, 'saved-subscription-token');
    assert.strictEqual(codexEnv.CLAUDE_CODE_OAUTH_TOKEN, '', 'only a claude flight gets the claude login');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const env of [claudeEnv, codexEnv].filter(Boolean)) {
      fs.rmSync(env.TMPDIR, { recursive: true, force: true });
      fs.rmSync(env.ATRIS_ONE_LAP_CONTROL_DIR, { recursive: true, force: true });
    }
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('sealed flights keep the parent owner names with a temporary home', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-owner-env-'));
  const worktree = path.join(root, 'worktree');
  const home = path.join(root, 'home');
  fs.mkdirSync(worktree);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n  name = Casey Morgan\n');
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git remote add origin https://example.invalid/repo.git', { cwd: worktree });
  const keys = ['HOME', 'GIT_CONFIG_GLOBAL', 'ATRIS_OPERATOR', 'ATRIS_OWNER_NAMES'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousCwd = process.cwd();
  let environment;
  try {
    process.env.HOME = home;
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.ATRIS_OPERATOR;
    delete process.env.ATRIS_OWNER_NAMES;
    // Resolve the fixture's Git identity, not the launch checkout's config.
    process.chdir(worktree);
    resetOwnerIdentityCache();
    environment = reviewOnlyEngineEnvironment(worktree, { engine: 'codex' });
    const result = spawnSync(process.execPath, ['-e',
      'process.stdout.write(String(require(process.argv[1]).isOwner("casey")))',
      path.join(__dirname, '..', 'utils', 'owner-identity.js'),
    ], { cwd: worktree, env: environment, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, 'true');
  } finally {
    process.chdir(previousCwd);
    resetOwnerIdentityCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (environment) {
      fs.rmSync(environment.TMPDIR, { recursive: true, force: true });
      fs.rmSync(environment.ATRIS_ONE_LAP_CONTROL_DIR, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
