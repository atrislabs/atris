const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const engine = require('../commands/engine');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-test-'));
}

function runCli(args, cwd, env = {}) {
  const merged = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...env };
  delete merged.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env: merged });
}

test('engine roster lists every profile with detection state', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['engine', '--json'], dir);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    const names = parsed.engines.map((e) => e.name);
    assert.deepEqual(names, ['atris-fast', 'claude', 'codex', 'cursor', 'fable', 'composer', 'haiku', 'devin', 'hermes', 'droid']);
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'engines.json')));
    const codex = parsed.engines.find((e) => e.id === 'codex');
    assert.equal(codex.tier, 'pro');
    assert.deepEqual(codex.roles, ['executor']);
    assert.equal(codex.fallback_order, 10);
    assert.ok(codex.health);
    for (const entry of parsed.engines) {
      assert.equal(typeof entry.installed, 'boolean');
      assert.ok(entry.bin);
    }
    assert.ok(names.includes(parsed.default));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine <name> persists the workspace default and reset clears it', () => {
  const dir = makeTempDir();
  try {
    const set = runCli(['engine', 'cursor'], dir);
    assert.equal(set.status, 0, set.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'engine.json'), 'utf8'));
    assert.equal(saved.default, 'cursor');

    const status = runCli(['engine', '--json'], dir);
    assert.equal(JSON.parse(status.stdout).default, 'cursor');
    assert.equal(JSON.parse(status.stdout).source, 'saved');

    const reset = runCli(['engine', 'reset'], dir);
    assert.equal(reset.status, 0, reset.stderr);
    assert.ok(!fs.existsSync(path.join(dir, '.atris', 'engine.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine aliases canonicalize and unknown engines fail fast', () => {
  const dir = makeTempDir();
  try {
    const alias = runCli(['engine', 'atris2-fast'], dir);
    assert.equal(alias.status, 0, alias.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'engine.json'), 'utf8'));
    assert.equal(saved.default, 'atris-fast');

    const bad = runCli(['engine', 'gpt-11'], dir);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Unknown engine "gpt-11"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--engine flag rides a loop for one run and validates at the boundary', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], dir, {});
    // dry runs need no engine binary, so any engine name previews fine
    const good = runCli(['run', '--legacy', '--dry-run', '--engine', 'cursor'], dir);
    assert.equal(good.status, 0, good.stderr || good.stdout);

    const bad = runCli(['run', '--legacy', '--dry-run', '--engine', 'gpt-11'], dir);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown --engine "gpt-11"/);
    assert.match(bad.stderr, /atris-fast, claude, codex, cursor, fable, composer, haiku, devin, hermes, droid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saved engine resolves into the runner profile for loop spawns', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], dir, {});
    runCli(['engine', 'codex'], dir);
    // the boundary maps the saved engine to ATRIS_RUNNER_PROFILE; the codex
    // profile's command template is codex-shaped
    const { buildRunnerCommand } = require('../lib/runner-command');
    const prev = process.env.ATRIS_RUNNER_PROFILE;
    process.env.ATRIS_RUNNER_PROFILE = engine.readSavedEngine(dir);
    try {
      const cmd = buildRunnerCommand({ promptFile: '/tmp/p.md' });
      assert.match(cmd, /^codex exec /);
    } finally {
      if (prev === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
      else process.env.ATRIS_RUNNER_PROFILE = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('house default is atris-fast and profile templates stay engine-shaped', () => {
  assert.equal(engine.HOUSE_ENGINE, 'atris-fast');
  const { RUNNER_PROFILES } = require('../lib/runner-command');
  assert.match(RUNNER_PROFILES['atris-fast'].commandTemplate, /--fast/);
  assert.match(RUNNER_PROFILES.cursor.commandTemplate, /--trust -p/);
  assert.match(RUNNER_PROFILES.devin.commandTemplate, /-p --/);
  assert.match(RUNNER_PROFILES.hermes.commandTemplate, /-p --/);
  // claude rides the default claude-shaped spawn, no template needed
  assert.equal(RUNNER_PROFILES.claude.commandTemplate, '');
});

test('hermes resolves through the shared engine and runner profile lookup', () => {
  const { RUNNER_PROFILE_DEFS, RUNNER_PROFILES, buildRunnerCommand } = require('../lib/runner-command');
  assert.equal(engine.canonicalEngineName('hermes'), 'hermes');
  assert.equal(engine.canonicalEngineName('hermes-agent'), 'hermes');
  assert.strictEqual(RUNNER_PROFILES['hermes-agent'], RUNNER_PROFILE_DEFS.hermes);

  const prev = process.env.ATRIS_RUNNER_PROFILE;
  process.env.ATRIS_RUNNER_PROFILE = 'hermes';
  try {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.md' });
    assert.equal(cmd, 'hermes -p -- "$(cat /tmp/p.md)"');
  } finally {
    if (prev === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = prev;
  }
});

function makeBinDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-bin-'));
}

function writeFakeBin(binDir, name, body) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

// Preflight regression: `atris engine test` runs the engine CLI headless with
// a reply-OK prompt and reports pass/fail per engine. A clean PATH keeps the
// test deterministic regardless of which engines are installed on the host.
const CLEAN_PATH = '/usr/bin:/bin';

test('engine list --json exposes the registry contract', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['engine', 'list', '--json'], dir, { PATH: CLEAN_PATH });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout);
    assert.equal(typeof parsed.default, 'string');
    assert.ok(Array.isArray(parsed.engines));
    const atrisFast = parsed.engines.find((entry) => entry.id === 'atris-fast');
    assert.ok(atrisFast, 'atris-fast entry present');
    assert.equal(atrisFast.tier, 'fast');
    assert.deepEqual(atrisFast.roles, ['navigator']);
    assert.equal(typeof atrisFast.fallback_order, 'number');
    assert.equal(atrisFast.health.status, 'not_installed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine resolve chooses the first ready engine by role fallback order', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'codex', '#!/bin/sh\necho codex\n');
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho cursor\n');
  try {
    const res = runCli(['engine', 'resolve', 'executor'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), 'codex');

    const json = runCli(['engine', 'resolve', 'executor', '--json'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.id, 'codex');
    assert.equal(payload.health.status, 'ready');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('engine health flip removes a credited-out engine from resolve fallback', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'codex', '#!/bin/sh\necho codex\n');
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho cursor\n');
  try {
    const health = runCli(['engine', 'health', 'codex', '--set', 'credit_out', '--json'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(health.status, 0, health.stderr || health.stdout);
    const flipped = JSON.parse(health.stdout);
    assert.equal(flipped.id, 'codex');
    assert.equal(flipped.health.status, 'credit_out');
    assert.ok(flipped.health.last_failure_ts);

    const list = runCli(['engine', 'list', '--json'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const codex = JSON.parse(list.stdout).engines.find((entry) => entry.id === 'codex');
    assert.equal(codex.health.status, 'credit_out');

    const resolved = runCli(['engine', 'resolve', 'executor'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    assert.equal(resolved.stdout.trim(), 'cursor');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('engine test <name> exits 0 with a pass line when the CLI replies OK', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho OK\n');
  try {
    const res = runCli(['engine', 'test', 'cursor'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /cursor/i);
    assert.match(res.stdout, /pass/i);
    assert.match(res.stdout, /clear for flight|responded/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('engine test <name> exits nonzero naming the failing engine when it cannot reply', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho "broken login"\nexit 1\n');
  try {
    const res = runCli(['engine', 'test', 'cursor'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.notEqual(res.status, 0);
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.match(combined, /cursor/);
    assert.match(combined, /FAIL/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('engine test <name> exits nonzero naming the engine when its CLI is not installed', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['engine', 'test', 'cursor'], dir, { PATH: CLEAN_PATH });
    assert.notEqual(res.status, 0);
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.match(combined, /cursor/);
    assert.match(combined, /not installed|FAIL/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine test --json reports a per-engine pass/fail shape', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho OK\n');
  writeFakeBin(binDir, 'codex', '#!/bin/sh\necho "nope"\nexit 1\n');
  try {
    const res = runCli(['engine', 'test', '--json'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(Array.isArray(parsed.results));
    assert.equal(parsed.summary.fail, 1);
    assert.equal(parsed.summary.pass, 1);
    const cursor = parsed.results.find((r) => r.engine === 'cursor');
    const codex = parsed.results.find((r) => r.engine === 'codex');
    assert.ok(cursor, 'cursor result present');
    assert.equal(cursor.pass, true);
    assert.equal(cursor.reason, 'ok');
    assert.ok(codex, 'codex result present');
    assert.equal(codex.pass, false);
    assert.ok(['bad-exit', 'no-ok'].includes(codex.reason));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('engine test --json on a single passing engine reports ok:true', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho OK\n');
  try {
    const res = runCli(['engine', 'test', 'cursor', '--json'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].engine, 'cursor');
    assert.equal(parsed.results[0].pass, true);
    assert.equal(parsed.summary.pass, 1);
    assert.equal(parsed.summary.fail, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('engine test rejects an unknown engine name fast', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['engine', 'test', 'gpt-11'], dir, { PATH: CLEAN_PATH });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Unknown engine "gpt-11"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function captureConsole(fn) {
  const beforeLog = console.log;
  const beforeError = console.error;
  const stdout = [];
  const stderr = [];
  console.log = (...parts) => stdout.push(parts.map(String).join(' '));
  console.error = (...parts) => stderr.push(parts.map(String).join(' '));
  try {
    const code = await fn();
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = beforeLog;
    console.error = beforeError;
  }
}

function writeHomeFile(homeDir, relativePath, content) {
  const file = path.join(homeDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function fakeLoginDeps(extra = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      ensureValidCredentials: async () => ({ credentials: { token: 'test-token' } }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        return extra.response || { ok: true, status: 200, data: { ok: true, provider: 'codex' } };
      },
      ...extra,
    },
  };
}

function fakeDeviceLoginDeps(pollResponses, settings = {}) {
  const calls = [];
  const sleepCalls = [];
  const queue = pollResponses.slice();
  return {
    calls,
    sleepCalls,
    deps: {
      ensureValidCredentials: async () => ({ credentials: { token: 'test-token' } }),
      sleep: async (ms) => { sleepCalls.push(ms); },
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        if (options.method === 'POST') {
          return {
            ok: true,
            status: 200,
            data: settings.startData || {
              session_id: 's-device-1',
              provider: 'codex',
              instance_id: 'i-device-1',
              status: 'starting',
            },
          };
        }
        const data = queue.length ? queue.shift() : pollResponses[pollResponses.length - 1];
        return { ok: true, status: 200, data };
      },
      ...settings.extraDeps,
    },
  };
}

test('engine login manifest is a hard whitelist', () => {
  assert.deepEqual(Object.keys(engine.ENGINE_LOGIN_MANIFESTS).sort(), ['claude', 'codex', 'cursor', 'devin']);
  assert.equal(engine.normalizeLoginProvider('codex'), 'codex');
  assert.equal(engine.normalizeLoginProvider('composer'), '');
  assert.equal(engine.normalizeLoginProvider('hermes'), '');
});

test('engine login parses --computer and --business device targets', () => {
  const user = engine.parseEngineLoginArgs(['codex', '--computer']);
  assert.equal(user.provider, 'codex');
  assert.equal(user.computer, true);
  assert.equal(user.business, '');

  const business = engine.parseEngineLoginArgs(['codex', '--business', 'biz-1', '--json']);
  assert.equal(business.provider, 'codex');
  assert.equal(business.computer, true);
  assert.equal(business.business, 'biz-1');
  assert.equal(business.json, true);

  const businessEquals = engine.parseEngineLoginArgs(['codex', '--business=biz-2']);
  assert.equal(businessEquals.computer, true);
  assert.equal(businessEquals.business, 'biz-2');
});

test('engine login refuses a missing whitelisted file with a plain hint', async () => {
  const dir = makeTempDir();
  let authCalls = 0;
  let apiCalls = 0;
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--yes'], dir, {
      homeDir: dir,
      ensureValidCredentials: async () => { authCalls += 1; return { credentials: { token: 'unused' } }; },
      apiRequestJson: async () => { apiCalls += 1; return { ok: true, status: 200, data: {} }; },
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing ~\/\.codex\/auth\.json\. run codex login first\./);
    assert.equal(authCalls, 0);
    assert.equal(apiCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login confirm gate refuses upload without --yes', async () => {
  const dir = makeTempDir();
  const secret = 'super-secret-token';
  writeHomeFile(dir, '.codex/auth.json', JSON.stringify({
    access_token: secret,
    account: { email: 'person@example.com' },
  }));
  let apiCalls = 0;
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex'], dir, {
      homeDir: dir,
      confirmUpload: async () => false,
      ensureValidCredentials: async () => { throw new Error('auth should not run before confirm'); },
      apiRequestJson: async () => { apiCalls += 1; return { ok: true, status: 200, data: {} }; },
    }));
    assert.equal(result.code, 1);
    assert.match(result.stdout, /engine login: codex/);
    assert.match(result.stdout, /person@example\.com/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    assert.equal(apiCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login shapes a files payload and redacts echoed secrets', async () => {
  const dir = makeTempDir();
  const secret = 'secret-from-auth-json';
  const content = JSON.stringify({
    tokens: { access: secret },
    profile: { email: 'codex@example.com' },
  });
  writeHomeFile(dir, '.codex/auth.json', content);
  const { calls, deps } = fakeLoginDeps({
    homeDir: dir,
    response: {
      ok: true,
      status: 200,
      data: {
        provider: 'codex',
        registered_at: '2026-07-06T00:00:00.000Z',
        files: { '~/.codex/auth.json': secret },
      },
    },
  });
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--yes'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/engines/logins/codex');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.token, 'test-token');
    assert.deepEqual(calls[0].options.body, { files: { '~/.codex/auth.json': content } });
    assert.match(result.stdout, /codex@example\.com/);
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.match(result.stdout, /\[redacted\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login captures devin API key through a secret prompt', async () => {
  const dir = makeTempDir();
  const secret = 'devin-secret-key';
  const { calls, deps } = fakeLoginDeps({
    promptSecret: async () => secret,
    response: {
      ok: true,
      status: 200,
      data: { provider: 'devin', api_key: secret },
    },
  });
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['devin', '--yes'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/engines/logins/devin');
    assert.deepEqual(calls[0].options.body, { api_key: secret });
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.match(result.stdout, /\[redacted\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login --computer posts a user device-login target', async () => {
  const dir = makeTempDir();
  const { calls, deps } = fakeDeviceLoginDeps([
    {
      status: 'completed',
      verify_url: null,
      code: null,
      account_email: 'codex@example.com',
      registered: true,
    },
  ]);
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--computer'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls[0].pathname, '/engines/logins/codex/device-login');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.token, 'test-token');
    assert.deepEqual(calls[0].options.body, { target: { type: 'user' } });
    assert.equal(calls[1].pathname, '/engines/logins/device-login/s-device-1');
    assert.match(result.stdout, /account_email: codex@example\.com/);
    assert.match(result.stdout, /registered: true/);
    assert.match(result.stdout, /ready-check: provider=codex/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login --business posts a business device-login target', async () => {
  const dir = makeTempDir();
  const { calls, deps } = fakeDeviceLoginDeps([
    {
      status: 'completed',
      verify_url: null,
      code: null,
      account_email: 'codex@example.com',
      registered: true,
    },
  ]);
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--business', 'biz-1'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls[0].pathname, '/engines/logins/codex/device-login');
    assert.deepEqual(calls[0].options.body, { target: { type: 'business', id: 'biz-1' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login device flow prints url and code once, then completes', async () => {
  const dir = makeTempDir();
  const { calls, sleepCalls, deps } = fakeDeviceLoginDeps([
    {
      status: 'pending_user',
      verify_url: 'https://example.com/device',
      code: 'ABCD-EFGH',
      account_email: null,
      registered: false,
    },
    {
      status: 'pending_user',
      verify_url: 'https://example.com/device',
      code: 'ABCD-EFGH',
      account_email: null,
      registered: false,
    },
    {
      status: 'completed',
      verify_url: 'https://example.com/device',
      code: 'ABCD-EFGH',
      account_email: 'codex@example.com',
      registered: true,
    },
  ]);
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--computer'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.length, 4);
    assert.deepEqual(sleepCalls, [3000, 3000]);
    assert.match(result.stdout, /Sign in: https:\/\/example\.com\/device/);
    assert.match(result.stdout, /Code:    ABCD-EFGH   \(expires in 15 minutes; never share this code\)/);
    assert.equal((result.stdout.match(/ABCD-EFGH/g) || []).length, 1);
    assert.match(result.stdout, /account_email: codex@example\.com/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login device flow --json emits the final status on stdout', async () => {
  const dir = makeTempDir();
  const { deps } = fakeDeviceLoginDeps([
    {
      status: 'pending_user',
      verify_url: 'https://example.com/device',
      code: 'ABCD-EFGH',
      account_email: null,
      registered: false,
    },
    {
      status: 'completed',
      verify_url: null,
      code: null,
      account_email: 'codex@example.com',
      registered: true,
    },
  ]);
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--computer', '--json'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.account_email, 'codex@example.com');
    assert.equal(parsed.registered, true);
    assert.doesNotMatch(result.stdout, /Sign in:/);
    assert.match(result.stderr, /Sign in: https:\/\/example\.com\/device/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login device flow exits nonzero when expired', async () => {
  const dir = makeTempDir();
  const { deps } = fakeDeviceLoginDeps([
    {
      status: 'expired',
      verify_url: 'https://example.com/device',
      code: 'ABCD-EFGH',
      account_email: null,
      registered: false,
    },
  ]);
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--computer'], dir, deps));
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Sign in: https:\/\/example\.com\/device/);
    assert.match(result.stderr, /engine login device flow ended: expired/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login without --computer still uses the local upload path', async () => {
  const dir = makeTempDir();
  const content = JSON.stringify({
    tokens: { access: 'local-secret' },
    profile: { email: 'codex@example.com' },
  });
  writeHomeFile(dir, '.codex/auth.json', content);
  const { calls, deps } = fakeLoginDeps({
    homeDir: dir,
    response: {
      ok: true,
      status: 200,
      data: { provider: 'codex', files: { '~/.codex/auth.json': 'local-secret' } },
    },
  });
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--yes'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/engines/logins/codex');
    assert.doesNotMatch(calls[0].pathname, /device-login/);
    assert.deepEqual(calls[0].options.body, { files: { '~/.codex/auth.json': content } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine seed shapes business and user targets for backend ready checks', async () => {
  const dir = makeTempDir();
  const { calls, deps } = fakeLoginDeps({
    response: {
      ok: true,
      status: 200,
      data: { ready: true, checks: [{ name: 'credential', ok: true }] },
    },
  });
  try {
    const business = await captureConsole(() => engine.runEngineSeedCommand(['codex', '--business', 'biz-1'], dir, deps));
    assert.equal(business.code, 0, business.stderr);
    assert.equal(calls[0].pathname, '/engines/logins/codex/seed');
    assert.deepEqual(calls[0].options.body, { target: { type: 'business', id: 'biz-1' } });
    assert.match(business.stdout, /credential/);

    const user = await captureConsole(() => engine.runEngineSeedCommand(['codex', '--user'], dir, deps));
    assert.equal(user.code, 0, user.stderr);
    assert.equal(calls[1].pathname, '/engines/logins/codex/seed');
    assert.deepEqual(calls[1].options.body, { target: { type: 'user' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ATRIS_BACKEND_URL is accepted as a backend root for API paths', () => {
  const api = require('../utils/api');
  const previousApi = process.env.ATRIS_API_URL;
  const previousBackend = process.env.ATRIS_BACKEND_URL;
  try {
    delete process.env.ATRIS_API_URL;
    process.env.ATRIS_BACKEND_URL = 'http://127.0.0.1:4545';
    assert.equal(api.getApiBaseUrl(), 'http://127.0.0.1:4545/api');

    process.env.ATRIS_BACKEND_URL = 'http://127.0.0.1:4545/api/';
    assert.equal(api.getApiBaseUrl(), 'http://127.0.0.1:4545/api');

    process.env.ATRIS_API_URL = 'http://127.0.0.1:9999/custom-api';
    assert.equal(api.getApiBaseUrl(), 'http://127.0.0.1:9999/custom-api');
  } finally {
    if (previousApi === undefined) delete process.env.ATRIS_API_URL;
    else process.env.ATRIS_API_URL = previousApi;
    if (previousBackend === undefined) delete process.env.ATRIS_BACKEND_URL;
    else process.env.ATRIS_BACKEND_URL = previousBackend;
  }
});
