const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');
const { reviewOnlyEngineEnvironment, SEALED_WORKER_GUARD_ENV } = require('../lib/fleet');
const { unattendedStop, APPROVAL_ENV } = require('../lib/claude-spend-guard');
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

// The builder picker asks the Claude spend guard about a sealed worker with SEALED_WORKER_GUARD_ENV, because the
// sealed runtime is built on a machine this check can only reach on darwin. This keeps the two from drifting apart:
// every variable the guard reads is the same in the real sealed environment, and so is the guard's verdict.
test('the spend-guard view of a sealed worker is the environment a sealed worker really gets', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-guard-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git remote add origin https://example.invalid/repo.git', { cwd: worktree });
  // Everything that could make the guard say yes or no, set in the parent. None of it may reach the worker.
  const parent = {
    ANTHROPIC_API_KEY: 'sk-test-should-never-pass-through',
    ANTHROPIC_AUTH_TOKEN: 'token-should-never-pass-through',
    ANTHROPIC_MODEL: 'claude-haiku-5-5',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-haiku-5-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-haiku-5-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5-5',
    [APPROVAL_ENV]: 'claude-mystery-9,claude-opus-5-5',
    ATRIS_CLAUDE_KEY_OK: '1',
  };
  // The owner's home has Claude settings that name Haiku. The worker's home is its own and has none.
  const ownerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-owner-home-'));
  fs.mkdirSync(path.join(ownerHome, '.claude'));
  fs.writeFileSync(path.join(ownerHome, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-haiku-5-5' }));
  fs.writeFileSync(path.join(ownerHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.invalid' } }));
  const previous = Object.fromEntries([...Object.keys(parent), 'HOME'].map((key) => [key, process.env[key]]));
  const environments = [];
  try {
    Object.assign(process.env, parent, { HOME: ownerHome });
    for (const engine of ['claude', 'codex', 'cursor']) environments.push(reviewOnlyEngineEnvironment(worktree, { engine }));
    // The view names every variable the parent set, so a variable the worker is given later has to be added there.
    assert.deepStrictEqual(Object.keys(parent).filter((key) => !(key in SEALED_WORKER_GUARD_ENV)), []);
    for (const env of environments) {
      for (const key of Object.keys(parent)) {
        assert.strictEqual(env[key] === undefined ? '' : env[key], SEALED_WORKER_GUARD_ENV[key] === undefined ? '' : SEALED_WORKER_GUARD_ENV[key], `${key}: what the picker assumes is what the worker gets`);
      }
      for (const model of ['claude-haiku-5-5', 'haiku', 'claude-mystery-9', 'claude-opus-5-5', '']) {
        assert.deepStrictEqual(unattendedStop({ model, env }), unattendedStop({ model, env: SEALED_WORKER_GUARD_ENV }), `${JSON.stringify(model)}: the guard says the same thing about both`);
      }
      // The worker's home is its own: Claude reads its settings from there, and there are none, so a run with no
      // --model falls back to the paid default, which is what the picker is told.
      assert.notStrictEqual(env.HOME, ownerHome);
      assert.ok(!fs.existsSync(path.join(env.HOME, '.claude', 'settings.json')), 'the owner\'s Claude settings are not copied in');
      assert.ok(!fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json')));
      assert.equal(unattendedStop({ model: '', env: { ...SEALED_WORKER_GUARD_ENV, HOME: env.HOME } }).model, 'default');
    }
    // And the parent's own view differs, so this test would notice a worker that kept an approval or a model.
    assert.equal(unattendedStop({ model: 'claude-mystery-9', env: process.env }), null);
    assert.notEqual(unattendedStop({ model: 'claude-mystery-9', env: SEALED_WORKER_GUARD_ENV }), null);
    assert.equal(unattendedStop({ model: '', env: process.env }), null, 'the parent\'s ANTHROPIC_MODEL is Haiku');
    assert.notEqual(unattendedStop({ model: '', env: SEALED_WORKER_GUARD_ENV }), null, 'the worker has none');
    const parentRemapOnly = { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ATRIS_CLAUDE_KEY_OK: '', [APPROVAL_ENV]: '' };
    assert.deepEqual(unattendedStop({ model: 'haiku', env: parentRemapOnly }), { reason: 'paid_model', model: 'claude-opus-5-5', why: 'paid model claude-opus-5-5, no spend approval' }, 'and the parent\'s remap is not the worker\'s');
    assert.equal(unattendedStop({ model: 'haiku', env: SEALED_WORKER_GUARD_ENV }), null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const env of environments) {
      fs.rmSync(env.TMPDIR, { recursive: true, force: true });
      fs.rmSync(env.ATRIS_ONE_LAP_CONTROL_DIR, { recursive: true, force: true });
    }
    fs.rmSync(ownerHome, { recursive: true, force: true });
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
