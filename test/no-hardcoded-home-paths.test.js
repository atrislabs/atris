'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const scannedDirs = ['bin', 'commands', 'lib', 'utils'];
const allowed = new Map([
  // This path belongs to the fixed service account in the hosted Linux runtime.
  ['lib/runtime-bootstrap.js:50', '/home/atris/bin'],
  ['lib/runtime-bootstrap.js:63', '/home/atris/bin'],
  ['lib/runtime-bootstrap.js:64', '/home/atris/bin'],
]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : (/\.[cm]?js$/.test(entry.name) ? [file] : []);
  });
}

test('shipped JavaScript has no personal home paths or owner names', () => {
  const violations = [];
  for (const dir of scannedDirs) {
    for (const file of sourceFiles(path.join(packageRoot, dir))) {
      const relative = path.relative(packageRoot, file);
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (!/\/Users\/|\/home\/[a-z][\w-]*|~\/arena|keshav/i.test(line)) return;
        const location = `${relative}:${index + 1}`;
        if (allowed.get(location) && line.includes(allowed.get(location))) return;
        violations.push(location);
      });
    }
  }
  assert.deepEqual(violations, [], `personal paths or names found:\n${violations.join('\n')}`);
});

test('backend root follows environment, config, sibling, then nothing', () => {
  const { resolveBackendRoot } = require('../utils/backend-root');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-backend-root-'));
  const workspace = path.join(temp, 'workspace');
  const sibling = path.join(temp, 'atrisos-backend');
  const override = path.join(temp, 'override');
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
  fs.mkdirSync(override);
  const previous = { root: process.env.ATRIS_BACKEND_ROOT, dir: process.env.ATRIS_BACKEND_DIR };
  try {
    delete process.env.ATRIS_BACKEND_ROOT;
    delete process.env.ATRIS_BACKEND_DIR;
    assert.equal(resolveBackendRoot(workspace), null);
    fs.mkdirSync(sibling);
    assert.equal(fs.realpathSync(resolveBackendRoot(workspace)), fs.realpathSync(sibling));
    fs.writeFileSync(path.join(workspace, 'atris', '.config'), '{broken json');
    assert.equal(fs.realpathSync(resolveBackendRoot(workspace)), fs.realpathSync(sibling));
    fs.writeFileSync(path.join(workspace, 'atris', '.config'), JSON.stringify({ backend_root: 42 }));
    assert.equal(fs.realpathSync(resolveBackendRoot(workspace)), fs.realpathSync(sibling));
    fs.writeFileSync(path.join(workspace, 'atris', '.config'), JSON.stringify({ backend_root: override }));
    assert.equal(fs.realpathSync(resolveBackendRoot(workspace)), fs.realpathSync(override));
    process.env.ATRIS_BACKEND_ROOT = sibling;
    assert.equal(fs.realpathSync(resolveBackendRoot(workspace)), fs.realpathSync(sibling));
    process.env.ATRIS_BACKEND_DIR = override;
    assert.equal(fs.realpathSync(resolveBackendRoot(workspace)), fs.realpathSync(sibling));
    process.env.ATRIS_BACKEND_ROOT = path.join(temp, 'missing');
    assert.equal(resolveBackendRoot(workspace), null);
    delete process.env.ATRIS_BACKEND_ROOT;
    process.env.ATRIS_BACKEND_DIR = sibling;
    assert.equal(fs.realpathSync(resolveBackendRoot(workspace)), fs.realpathSync(sibling));
  } finally {
    for (const [key, value] of Object.entries({ ATRIS_BACKEND_ROOT: previous.root, ATRIS_BACKEND_DIR: previous.dir })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('backend root finds the CLI install sibling from a business workspace', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-install-root-'));
  const arena = path.join(temp, 'arena');
  const workspace = path.join(arena, 'atris-business', 'sample');
  const backend = path.join(arena, 'atrisos-backend');
  const workspaceSibling = path.join(arena, 'atris-business', 'atrisos-backend');
  const previous = { root: process.env.ATRIS_BACKEND_ROOT, dir: process.env.ATRIS_BACKEND_DIR };
  try {
    delete process.env.ATRIS_BACKEND_ROOT;
    delete process.env.ATRIS_BACKEND_DIR;
    fs.mkdirSync(arena, { recursive: true });
    fs.symlinkSync(packageRoot, path.join(arena, 'atris-cli'), 'dir');
    fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
    fs.mkdirSync(backend);
    const resolveFrom = (cwd) => {
      const result = spawnSync(process.execPath, [
        '--preserve-symlinks', '-e',
        'process.stdout.write(require(process.argv[1]).resolveBackendRoot(process.argv[2]) || "")',
        path.join(arena, 'atris-cli', 'utils', 'backend-root.js'), cwd,
      ], { cwd, encoding: 'utf8', env: process.env });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.equal(fs.realpathSync(resolveFrom(arena)), fs.realpathSync(backend));
    assert.equal(fs.realpathSync(resolveFrom(workspace)), fs.realpathSync(backend));
    fs.mkdirSync(workspaceSibling);
    assert.equal(fs.realpathSync(resolveFrom(workspace)), fs.realpathSync(workspaceSibling));
  } finally {
    for (const [key, value] of Object.entries({ ATRIS_BACKEND_ROOT: previous.root, ATRIS_BACKEND_DIR: previous.dir })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('study keeps its old lookup order: study root, backend root, then the workspace study folder', () => {
  const { resolveStudyRoot } = require('../commands/study');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-study-root-'));
  const localStudy = path.join(temp, 'atris', 'study');
  const backend = path.join(temp, 'backend');
  const previous = { study: process.env.ATRIS_STUDY_ROOT, backend: process.env.ATRIS_BACKEND_ROOT };
  try {
    fs.mkdirSync(localStudy, { recursive: true });
    delete process.env.ATRIS_STUDY_ROOT;
    delete process.env.ATRIS_BACKEND_ROOT;
    assert.equal(resolveStudyRoot(temp), localStudy);
    process.env.ATRIS_STUDY_ROOT = path.join(temp, 'missing');
    assert.equal(resolveStudyRoot(temp), localStudy);
    fs.mkdirSync(backend);
    process.env.ATRIS_BACKEND_ROOT = backend;
    // Same as before this change: an explicitly set backend root wins over the local folder.
    assert.equal(resolveStudyRoot(temp), backend);
    delete process.env.ATRIS_BACKEND_ROOT;
    assert.equal(resolveStudyRoot(temp), localStudy);
    fs.rmSync(localStudy, { recursive: true });
    process.env.ATRIS_BACKEND_ROOT = backend;
    assert.equal(resolveStudyRoot(temp), backend);
    process.env.ATRIS_STUDY_ROOT = temp;
    assert.equal(resolveStudyRoot(temp), temp);
  } finally {
    for (const [key, value] of Object.entries({ ATRIS_STUDY_ROOT: previous.study, ATRIS_BACKEND_ROOT: previous.backend })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('aeo falls through to backend when the explicit root lacks aeo', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-aeo-root-'));
  const backend = path.join(temp, 'atrisos-backend');
  const unrelated = path.join(temp, 'unrelated');
  try {
    fs.mkdirSync(path.join(backend, 'atris', 'features', 'aeo'), { recursive: true });
    fs.mkdirSync(unrelated);
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'atris.js'), 'aeo', 'status', '--json'], {
      cwd: temp,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_AEO_ROOT: unrelated, ATRIS_BACKEND_ROOT: backend },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).backend_root, backend);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('business workspace prompts follow the configured folder', () => {
  const { businessWorkspaceBase } = require('../commands/business');
  const previous = process.env.ATRIS_BUSINESS_ROOT;
  try {
    process.env.ATRIS_BUSINESS_ROOT = path.join(os.tmpdir(), 'my-businesses');
    assert.equal(businessWorkspaceBase(), process.env.ATRIS_BUSINESS_ROOT);
  } finally {
    if (previous === undefined) delete process.env.ATRIS_BUSINESS_ROOT;
    else process.env.ATRIS_BUSINESS_ROOT = previous;
  }
});

test('codex companion uses override or newest installed version under home', () => {
  const { resolveCodexCompanion } = require('../lib/codex-flight');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-companion-home-'));
  const previous = { HOME: process.env.HOME, ATRIS_CODEX_COMPANION: process.env.ATRIS_CODEX_COMPANION };
  try {
    process.env.HOME = home;
    delete process.env.ATRIS_CODEX_COMPANION;
    assert.equal(resolveCodexCompanion(), null);
    for (const version of ['1.0.4', '1.2.0']) {
      const script = path.join(home, '.claude', 'plugins', 'cache', 'openai-codex', 'codex', version, 'scripts', 'codex-companion.mjs');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '');
    }
    assert.equal(resolveCodexCompanion(), path.join(home, '.claude', 'plugins', 'cache', 'openai-codex', 'codex', '1.2.0', 'scripts', 'codex-companion.mjs'));
    const override = path.join(home, 'override.mjs');
    fs.writeFileSync(override, '');
    process.env.ATRIS_CODEX_COMPANION = override;
    assert.equal(resolveCodexCompanion(), override);
    process.env.ATRIS_CODEX_COMPANION = home;
    assert.equal(resolveCodexCompanion(), null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('owner matching uses the configured account, not a built-in person', () => {
  const { isOwner, ownerIdentity, resetOwnerIdentityCache } = require('../utils/owner-identity');
  const { shouldSkipAutoHumanGate } = require('../commands/autopilot');
  const { sweepLine } = require('../commands/close');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-owner-home-'));
  const previous = { HOME: process.env.HOME, ATRIS_OPERATOR: process.env.ATRIS_OPERATOR };
  try {
    process.env.HOME = home;
    process.env.ATRIS_OPERATOR = 'alex';
    resetOwnerIdentityCache();
    assert.equal(isOwner('alex'), true);
    assert.equal(isOwner('operator'), true);
    assert.equal(isOwner('someone-else'), false);
    assert.equal(ownerIdentity({ email: 'alex@example.com' }, 'alexmorgan').names.includes('alexmorgan'), true);
    assert.equal(ownerIdentity({ email: 'alex@example.com' }, 'samson').names.includes('samson'), false);
    assert.equal(shouldSkipAutoHumanGate({ claimed: 'alex at 2026-09-23T00:00:00Z' }), true);
    assert.equal(shouldSkipAutoHumanGate({ claimed: 'operator at 2026-09-23T00:00:00Z' }), true);
    assert.equal(shouldSkipAutoHumanGate({ claimed: 'someone-else at 2026-09-23T00:00:00Z' }), false);
    assert.match(sweepLine({ what: 'send invoice', close_condition: 'sent', days_past_ttl: 1, owner: 'alex' }), /waiting on you/);
  } finally {
    resetOwnerIdentityCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('owner matching falls back to git name and local user without repeated lookups', () => {
  const owner = require('../utils/owner-identity');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-owner-fallback-'));
  const oldUserInfo = os.userInfo;
  const previous = Object.fromEntries(['HOME', 'ATRIS_OPERATOR', 'USER', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
    .map((key) => [key, process.env[key]]));
  let calls = 0;
  try {
    process.env.HOME = home;
    delete process.env.ATRIS_OPERATOR;
    process.env.USER = 'casey_local';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'user.name';
    process.env.GIT_CONFIG_VALUE_0 = 'Casey Morgan';
    os.userInfo = () => { calls++; throw new Error('no passwd entry'); };
    owner.resetOwnerIdentityCache();
    assert.equal(owner.isOwner('casey'), true);
    assert.equal(owner.isOwner('casey_local'), true);
    assert.equal(owner.isOwner('operator'), true);
    assert.equal(calls, 1);
  } finally {
    os.userInfo = oldUserInfo;
    owner.resetOwnerIdentityCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('metric wish gives one setup line before recording a wish', () => {
  const { runCapturedWish, parseMetricExpression } = require('../lib/wish-delegate');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-metric-root-'));
  const previous = { root: process.env.ATRIS_BACKEND_ROOT, dir: process.env.ATRIS_BACKEND_DIR };
  const errors = [];
  const oldError = console.error;
  try {
    delete process.env.ATRIS_BACKEND_ROOT;
    delete process.env.ATRIS_BACKEND_DIR;
    console.error = (line) => errors.push(line);
    assert.equal(runCapturedWish('grow subscriptions', temp, { metric: parseMetricExpression('stripe.active_subs>=10') }), 2);
    assert.deepEqual(errors, ['set ATRIS_BACKEND_ROOT to the backend workspace.']);
    assert.equal(fs.existsSync(path.join(temp, '.atris')), false);
  } finally {
    console.error = oldError;
    for (const [key, value] of Object.entries({ ATRIS_BACKEND_ROOT: previous.root, ATRIS_BACKEND_DIR: previous.dir })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
