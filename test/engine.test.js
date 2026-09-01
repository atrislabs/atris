const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const engine = require('../commands/engine');
const computer = require('../commands/computer');

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-test-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

function runCli(args, cwd, env = {}) {
  const merged = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...env };
  delete merged.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env: merged });
}

test('engine roster lists every profile with detection state', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['engine', '--json', '--global'], dir);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    const names = parsed.engines.map((e) => e.name);
    assert.deepEqual(names, ['atris-fast', 'claude', 'codex', 'cursor', 'fable', 'composer', 'haiku', 'devin', 'grok', 'agy', 'opencode']);
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'engines.json')));
    const codex = parsed.engines.find((e) => e.id === 'codex');
    assert.equal(codex.tier, 'pro');
    assert.deepEqual(codex.roles, ['executor']);
    assert.deepEqual(codex.models, ['codex']);
    assert.equal(codex.fallback_order, 10);
    assert.ok(codex.health);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'claude').models, ['opus 5', 'opus 4.8', 'fable', 'haiku']);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'fable').models, ['opus 5', 'opus 4.8', 'fable', 'haiku']);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'cursor').models, ['composer 2.5', 'grok 4.6', 'kimi 3']);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'composer').models, ['composer 2.5']);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'grok').models, ['grok 4.6', 'grok 4.5']);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'devin').models, ['built-in router']);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'agy').models, [
      'gemini-3.7-flash-high',
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ]);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'haiku').models, ['haiku']);
    assert.deepEqual(parsed.engines.find((e) => e.id === 'atris-fast').models, ['atris fast']);
    assert.equal(parsed.engines.find((e) => e.id === 'atris-fast').duty, 'learning');
    assert.equal(parsed.engines.find((e) => e.id === 'fable').duty, 'leader');
    assert.equal(parsed.engines.find((e) => e.id === 'devin').duty, 'errands');
    assert.equal(parsed.engines.find((e) => e.id === 'agy').duty, 'errands');
    for (const entry of parsed.engines) {
      assert.equal(typeof entry.installed, 'boolean');
      assert.ok(entry.bin);
    }
    assert.ok(names.includes(parsed.default));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bare engine name persists the workspace default and prints both alternate commands', () => {
  const dir = makeTempDir();
  try {
    const set = runCli(['engine', 'cursor'], dir);
    assert.equal(set.status, 0, set.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'engine.json'), 'utf8'));
    assert.equal(saved.default, 'cursor');
    assert.match(set.stdout, /default engine changed to cursor/);
    assert.match(set.stdout, /atris engine ask "\.\.\." --engine cursor/);
    assert.match(set.stdout, /atris engine dispatch <task> --engine cursor/);
    assert.equal(set.stdout.trim().split(/\r?\n/).length, 3);

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

test('engine aliases canonicalize and unknown engines with trailing text fail fast', () => {
  const dir = makeTempDir();
  try {
    const alias = runCli(['engine', 'atris2-fast'], dir);
    assert.equal(alias.status, 0, alias.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'engine.json'), 'utf8'));
    assert.equal(saved.default, 'atris-fast');

    const bad = runCli(['engine', 'gpt-11', 'answer this'], dir);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Unknown engine "gpt-11"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'engine.json'), 'utf8')).default, 'atris-fast');
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
    assert.match(bad.stderr, /atris-fast, claude, codex, cursor, fable, composer, haiku, devin, grok, agy, opencode/);
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
  assert.match(RUNNER_PROFILES.grok.commandTemplate, /--always-approve -p/);
  assert.match(RUNNER_PROFILES.agy.commandTemplate, /--mode accept-edits .* -p/);
  // claude rides the default claude-shaped spawn, no template needed
  assert.equal(RUNNER_PROFILES.claude.commandTemplate, '');
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
    assert.deepEqual(atrisFast.models, ['atris fast']);
    assert.equal(typeof atrisFast.fallback_order, 'number');
    assert.equal(atrisFast.health.status, 'not_installed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saved engine models override the seed without code edits', () => {
  const dir = makeTempDir();
  try {
    const initial = runCli(['engine', 'list', '--json', '--global'], dir, { PATH: CLEAN_PATH });
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    const registryFile = path.join(dir, '.atris', 'state', 'engines.json');
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    registry.engines.find((entry) => entry.id === 'cursor').models = ['composer 3'];
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

    const swapped = runCli(['engine', 'list', '--json', '--global'], dir, { PATH: CLEAN_PATH });
    assert.equal(swapped.status, 0, swapped.stderr || swapped.stdout);
    const cursor = JSON.parse(swapped.stdout).engines.find((entry) => entry.id === 'cursor');
    assert.deepEqual(cursor.models, ['composer 3']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine duty and model overrides round-trip through the saved registry', () => {
  const dir = makeTempDir();
  try {
    const set = runCli(['engine', 'set', 'codex', '--duty', 'leader', '--models', 'gpt 5, o3'], dir, { PATH: CLEAN_PATH });
    assert.equal(set.status, 0, set.stderr || set.stdout);
    assert.equal(set.stdout.trim(), 'codex updated: duty leader; models gpt 5, o3');

    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'engines.json'), 'utf8'));
    assert.deepEqual(saved.engines.find((entry) => entry.id === 'codex').models, ['gpt 5', 'o3']);
    assert.equal(saved.engines.find((entry) => entry.id === 'codex').duty, 'leader');
    assert.equal(saved.engines.find((entry) => entry.id === 'fable').duty, '');

    const list = runCli(['engine', 'list', '--json', '--global'], dir, { PATH: CLEAN_PATH });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const parsed = JSON.parse(list.stdout);
    assert.deepEqual(parsed.engines.find((entry) => entry.id === 'codex').models, ['gpt 5', 'o3']);
    assert.equal(parsed.engines.find((entry) => entry.id === 'codex').duty, 'leader');
    assert.equal(parsed.engines.find((entry) => entry.id === 'fable').duty, '');
    assert.equal(parsed.scope, 'global');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine chart renders every registry group without engine-name assumptions', () => {
  const rendered = engine.renderEngineChart({ engines: [
    { id: 'captain', duty: 'leader', roles: ['validator'], models: ['lead model'] },
    { id: 'maker', duty: '', roles: ['executor'], models: ['build model'] },
    { id: 'reviewer', duty: '', roles: ['validator'], models: ['check model'] },
    { id: 'runner', duty: 'errands', roles: ['executor'], models: ['errand model'] },
    { id: 'student', duty: 'learning', roles: ['navigator'], models: ['learn model'] },
  ] });
  for (const label of ['owner', 'leader', 'captain', 'builders', 'maker', 'checkers', 'reviewer', 'errands', 'runner', 'apprentice', 'student', 'learning the system']) {
    assert.match(rendered, new RegExp(label));
  }
  assert.ok(rendered.indexOf('owner') < rendered.indexOf('leader'));
  assert.ok(rendered.indexOf('leader') < rendered.indexOf('builders'));
  assert.ok(rendered.indexOf('builders') < rendered.indexOf('apprentice'));
  assert.doesNotMatch(rendered, /\u001b\[/);
  assert.doesNotMatch(rendered, /—/);
});

test('engines chart aliases render the seeded leader and apprentice', () => {
  for (const args of [['engines', '--chart'], ['engines', 'chart']]) {
    const dir = makeTempDir();
    try {
      const res = runCli(args, dir, { PATH: CLEAN_PATH });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /│ owner\s+│/);
      assert.match(res.stdout, /leader/);
      assert.match(res.stdout, /fable/);
      assert.match(res.stdout, /apprentice/);
      assert.match(res.stdout, /atris-fast/);
      assert.match(res.stdout, /learning the system/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('engines list renders models and errand duty', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['engines', '--global'], dir, { PATH: CLEAN_PATH });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /models: opus 5, opus 4\.8, fable, haiku/);
    assert.match(res.stdout, /models: composer 2\.5, grok 4\.6, kimi 3/);
    assert.match(res.stdout, /models: built-in router\s+duty: errands/);
    assert.doesNotMatch(res.stdout, /—/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('duty overrides leave existing executor role resolution unchanged', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'codex', '#!/bin/sh\necho codex\n');
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho cursor\n');
  try {
    const registry = runCli(['engine', 'list', '--json', '--global'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(registry.status, 0, registry.stderr || registry.stdout);
    const parsed = JSON.parse(registry.stdout);
    assert.deepEqual(parsed.engines.find((entry) => entry.id === 'devin').roles, ['executor']);
    assert.deepEqual(parsed.engines.find((entry) => entry.id === 'agy').roles, ['executor']);

    const set = runCli(['engine', 'set', 'codex', '--duty', 'errands'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(set.status, 0, set.stderr || set.stdout);

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

test('engine resolve explains why the router picked the winning engine', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'codex', '#!/bin/sh\necho codex\n');
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho cursor\n');
  try {
    const reason = 'router picked codex because executor track records are thin, so fallback order applies.';
    const res = runCli(['engine', 'resolve', 'executor'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), 'codex');
    assert.equal(res.stderr.trim(), reason);

    const json = runCli(['engine', 'resolve', 'executor', '--json'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    assert.equal(JSON.parse(json.stdout).won_reason, reason);
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

    const list = runCli(['engine', 'list', '--json', '--global'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
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

test('engine test writes a probe receipt per role that the router brain can read', () => {
  const dir = makeTempDir();
  const binDir = makeBinDir();
  writeFakeBin(binDir, 'cursor-agent', '#!/bin/sh\necho OK\n');
  try {
    const res = runCli(['engine', 'test', 'cursor'], dir, { PATH: `${binDir}:${CLEAN_PATH}` });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const runsDir = path.join(dir, 'atris', 'runs');
    const receipts = fs.readdirSync(runsDir).filter((name) => name.startsWith('engine-probe-task-cursor-'));
    assert.ok(receipts.length >= 1, `expected probe receipts in ${runsDir}`);
    const receipt = JSON.parse(fs.readFileSync(path.join(runsDir, receipts[0]), 'utf8'));
    assert.equal(receipt.engine, 'cursor');
    assert.equal(typeof receipt.task_type, 'string');
    assert.equal(receipt.verified_passed, true);
    assert.equal(typeof receipt.duration_ms, 'number');
    const { loadRouterHistory } = require('../lib/router-brain');
    const observations = loadRouterHistory(dir);
    assert.ok(
      observations.some((row) => row.engine === 'cursor' && row.verified_passed === true),
      'router brain should read the probe receipt as an observation',
    );
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
  const codeResponses = Array.isArray(settings.codeResponses) ? settings.codeResponses.slice() : [];
  return {
    calls,
    sleepCalls,
    deps: {
      ensureValidCredentials: async () => ({ credentials: { token: 'test-token' } }),
      sleep: async (ms) => { sleepCalls.push(ms); },
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        if (options.method === 'POST' && /\/device-login\/[^/]+\/code$/.test(pathname)) {
          return codeResponses.length
            ? codeResponses.shift()
            : { ok: true, status: 200, data: { status: 'submitted' } };
        }
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
  assert.deepEqual(Object.keys(engine.ENGINE_LOGIN_MANIFESTS).sort(), ['claude', 'codex', 'cursor', 'devin', 'grok']);
  assert.equal(engine.normalizeLoginProvider('codex'), 'codex');
  assert.equal(engine.normalizeLoginProvider('grok'), 'grok');
  assert.equal(engine.normalizeLoginProvider('composer'), '');
});

test('engine login parses --computer and --business device targets', () => {
  const user = engine.parseEngineLoginArgs(['codex', '--computer', '--seat', 'personal-work']);
  assert.equal(user.provider, 'codex');
  assert.equal(user.computer, true);
  assert.equal(user.business, '');
  assert.equal(user.seat, 'PERSONAL_WORK');
  assert.equal(user.seatFlag, true);

  const business = engine.parseEngineLoginArgs(['codex', '--business', 'biz-1', '--seat=team alpha', '--json']);
  assert.equal(business.provider, 'codex');
  assert.equal(business.computer, true);
  assert.equal(business.business, 'biz-1');
  assert.equal(business.seat, 'TEAM_ALPHA');
  assert.equal(business.json, true);

  const businessEquals = engine.parseEngineLoginArgs(['codex', '--business=biz-2']);
  assert.equal(businessEquals.computer, true);
  assert.equal(businessEquals.business, 'biz-2');
});

test('engine login normalizes and validates named seats', async () => {
  assert.equal(engine.normalizeEngineLoginSeat(' Personal-work '), 'PERSONAL_WORK');
  assert.equal(engine.validEngineLoginSeat('PERSONAL_WORK'), true);
  assert.equal(engine.validEngineLoginSeat('_PERSONAL'), false);
  assert.equal(engine.validEngineLoginSeat(`A${'B'.repeat(48)}`), false);

  const dir = makeTempDir();
  let apiCalls = 0;
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(
      ['codex', '--computer', '--seat', 'personal!'],
      dir,
      {
        ensureValidCredentials: async () => ({ credentials: { token: 'test-token' } }),
        apiRequestJson: async () => {
          apiCalls += 1;
          return { ok: true, status: 200, data: {} };
        },
      }
    ));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /seat names are letters, numbers, underscores - like personal or work/);
    assert.equal(apiCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine login help shows named seats for computer logins', async () => {
  const result = await captureConsole(() => engine.runEngineLoginCommand(['--help'], process.cwd()));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--computer \[--seat <name>\]/);
  assert.match(result.stdout, /--business <id> \[--seat <name>\]/);
});

test('engine seats renders ready, cooling, and empty accounts in plain words', async () => {
  const now = 1_800_000_000_000;
  assert.equal(engine.formatEngineSeats({ seats: [
    { engine: 'codex', name: 'PERSONAL', secret_name: 'hidden-1', cooling_until: null },
    { engine: 'claude', name: 'WORK', secret_name: 'hidden-2', cooling_until: (now / 1000) + 9000 },
  ] }, now), [
    'codex personal - ready',
    'claude work - cooling down, back 2h 30m',
  ].join('\n'));
  assert.equal(
    engine.formatEngineSeats({ seats: [] }, now),
    'No accounts linked yet. Run: atris computer setup'
  );

  const calls = [];
  const result = await captureConsole(() => engine.engineCommand(['seats'], {
    now: () => now,
    ensureValidCredentials: async () => ({ credentials: { token: 'test-token' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: { seats: [{ engine: 'codex', name: 'PERSONAL', cooling_until: null }] },
      };
    },
  }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'codex personal - ready');
  assert.deepEqual(calls.map((call) => [call.pathname, call.options.method, call.options.token]), [
    ['/engines/logins/seats', 'GET', 'test-token'],
  ]);

  const help = await captureConsole(() => engine.engineCommand(['help']));
  assert.match(help.stdout, /atris engine seats +show which named accounts are ready to work/);
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

test('engine login --computer passes a normalized named seat', async () => {
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
    const result = await captureConsole(() => engine.runEngineLoginCommand(
      ['codex', '--computer', '--seat', 'personal-work'],
      dir,
      deps
    ));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls[0].pathname, '/engines/logins/codex/device-login');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.token, 'test-token');
    assert.deepEqual(calls[0].options.body, { target: { type: 'user' }, seat: 'PERSONAL_WORK' });
    assert.equal(calls[1].pathname, '/engines/logins/device-login/s-device-1');
    assert.match(result.stdout, /account_email: codex@example\.com/);
    assert.match(result.stdout, /seat: PERSONAL_WORK/);
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

test('computer setup links named codex and claude seats on one computer', async () => {
  const calls = [];
  const questions = [];
  const answers = ['both', 'personal-work', '', 'work', ''];
  const pastedCodes = ['CLAUDE-PASTE-BACK'];
  let claudeCodeSubmitted = false;
  const deps = {
    loadCredentials: async () => ({ token: 'test-token' }),
    ensureValidCredentials: async () => ({ credentials: { token: 'test-token' } }),
    prompt: async (question) => {
      questions.push(question);
      return answers.shift() || '';
    },
    sleep: async () => {},
    readline: {
      createInterface: () => ({
        question: (_prompt, callback) => callback(pastedCodes.shift() || ''),
        close: () => {},
      }),
    },
    deviceLoginPollMs: 1,
    now: () => 1_800_000_000_000,
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (pathname === '/business/') {
        return {
          ok: true,
          status: 200,
          data: [{ id: 'biz-1', name: 'Acme', workspace_id: 'ws-1' }],
        };
      }
      if (pathname === '/engines/logins/seats') {
        return {
          ok: true,
          status: 200,
          data: { seats: [
            { engine: 'codex', name: 'PERSONAL_WORK', secret_name: 'hidden-1', cooling_until: null },
            { engine: 'claude', name: 'WORK', secret_name: 'hidden-2', cooling_until: null },
          ] },
        };
      }
      const start = pathname.match(/^\/engines\/logins\/(codex|claude)\/device-login$/);
      if (start && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          data: { session_id: `s-${start[1]}`, provider: start[1], status: 'starting' },
        };
      }
      const poll = pathname.match(/^\/engines\/logins\/device-login\/s-(codex|claude)$/);
      if (poll) {
        const pasteBackPending = poll[1] === 'claude' && !claudeCodeSubmitted;
        return {
          ok: true,
          status: 200,
          data: {
            provider: poll[1],
            status: pasteBackPending ? 'pending_user' : 'completed',
            verify_url: `https://example.com/${poll[1]}`,
            code: poll[1] === 'codex' ? 'CODE-X' : null,
            registered: true,
          },
        };
      }
      if (pathname === '/engines/logins/device-login/s-claude/code' && options.method === 'POST') {
        claudeCodeSubmitted = true;
        return { ok: true, status: 200, data: { status: 'submitted' } };
      }
      const readyCheck = pathname.match(/^\/engines\/logins\/(codex|claude)\/ready-check$/);
      if (readyCheck && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          data: { provider: readyCheck[1], status: readyCheck[1] === 'codex' ? 'ready' : 'failed' },
        };
      }
      return { ok: false, status: 404, error: 'not found' };
    },
  };

  const result = await captureConsole(() => computer.computerSetup(deps));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /using Acme computer\./);
  assert.match(result.stdout, /^On your phone, open: https:\/\/example\.com\/codex  and type the code: CODE-X$/m);
  assert.match(result.stdout, /^On your phone, open: https:\/\/example\.com\/claude$/m);
  assert.match(result.stdout, /^When the browser shows you a code, paste it here:$/m);
  assert.match(result.stdout, /PERSONAL_WORK linked\./);
  assert.match(result.stdout, /WORK linked\./);
  assert.match(result.stdout, /personal_work: working/);
  assert.match(result.stdout, /work: linked, but the check failed - it may still work, try: atris engine seats/);
  assert.match(result.stdout, /^codex personal_work - ready$/m);
  assert.match(result.stdout, /^claude work - ready$/m);
  assert.match(result.stdout, /Done\. Your computer can now work on these accounts\./);

  const starts = calls.filter((call) => /\/device-login$/.test(call.pathname));
  assert.deepEqual(starts.map((call) => call.options.body), [
    { target: { type: 'business', id: 'biz-1' }, seat: 'PERSONAL_WORK' },
    { target: { type: 'business', id: 'biz-1' }, seat: 'WORK' },
  ]);
  const readyChecks = calls.filter((call) => /\/ready-check$/.test(call.pathname));
  assert.deepEqual(readyChecks.map((call) => [call.pathname, call.options.body]), [
    ['/engines/logins/codex/ready-check', { target: { type: 'business', id: 'biz-1' } }],
    ['/engines/logins/claude/ready-check', { target: { type: 'business', id: 'biz-1' } }],
  ]);
  assert.equal(calls.at(-1).pathname, '/engines/logins/seats');
  const pastedCode = calls.find((call) => call.pathname === '/engines/logins/device-login/s-claude/code');
  assert.deepEqual(pastedCode.options.body, { code: 'CLAUDE-PASTE-BACK' });
  assert.ok(calls.every((call) => call.options.token === 'test-token'));
  assert.equal(questions[0], 'which coding accounts do you want to connect? (codex / claude / both) [both] ');
  assert.equal(questions[1], 'connect a codex account? give it a short name like personal or work (enter to finish) ');
  assert.match(questions[3], /you will get a code in the browser, paste it back here/);
});

test('computer setup tells logged-out users the one next command', async () => {
  const result = await captureConsole(() => computer.computerSetup({
    loadCredentials: async () => null,
  }));
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'run: atris login');
});

test('engine login device flow prints url and code once, then completes', async () => {
  const dir = makeTempDir();
  let readlineCalls = 0;
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
  ], {
    extraDeps: {
      readline: {
        createInterface: () => {
          readlineCalls += 1;
          throw new Error('codex device login should not read stdin');
        },
      },
    },
  });
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['codex', '--computer'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.length, 4);
    assert.deepEqual(sleepCalls, [3000, 3000]);
    assert.match(result.stdout, /Sign in: https:\/\/example\.com\/device/);
    assert.match(result.stdout, /Code:    ABCD-EFGH   \(expires in 15 minutes; never share this code\)/);
    assert.equal((result.stdout.match(/ABCD-EFGH/g) || []).length, 1);
    assert.match(result.stdout, /account_email: codex@example\.com/);
    assert.equal(readlineCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude device login pastes the browser code back and completes', async () => {
  const dir = makeTempDir();
  const readlineCalls = [];
  const { calls, deps } = fakeDeviceLoginDeps([
    {
      provider: 'claude',
      status: 'pending_user',
      verify_url: 'https://claude.ai/oauth/authorize?code=true',
      code: null,
      registered: false,
    },
    {
      provider: 'claude',
      status: 'completed',
      verify_url: null,
      code: null,
      account_email: 'claude@example.com',
      registered: true,
    },
  ], {
    startData: { session_id: 's-claude-1', provider: 'claude', status: 'starting' },
    extraDeps: {
      readline: {
        createInterface: () => ({
          question: (prompt, callback) => {
            readlineCalls.push(prompt);
            callback('  browser-code-1  ');
          },
          close: () => {},
        }),
      },
    },
  });
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['claude', '--computer'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^On your phone, open: https:\/\/claude\.ai\/oauth\/authorize\?code=true$/m);
    assert.match(result.stdout, /^When the browser shows you a code, paste it here:$/m);
    assert.equal(readlineCalls.length, 1);
    const codeCall = calls.find((call) => call.pathname === '/engines/logins/device-login/s-claude-1/code');
    assert.equal(codeCall.options.method, 'POST');
    assert.deepEqual(codeCall.options.body, { code: 'browser-code-1' });
    assert.match(result.stdout, /account_email: claude@example\.com/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude device login allows one paste-back retry after a 400', async () => {
  const dir = makeTempDir();
  const answers = ['mistyped-code', 'correct-code'];
  const { calls, deps } = fakeDeviceLoginDeps([
    {
      provider: 'claude',
      status: 'pending_user',
      verify_url: 'https://claude.ai/oauth/authorize?code=true',
      code: null,
      registered: false,
    },
    {
      provider: 'claude',
      status: 'completed',
      verify_url: null,
      code: null,
      account_email: 'claude@example.com',
      registered: true,
    },
  ], {
    startData: { session_id: 's-claude-retry', provider: 'claude', status: 'starting' },
    codeResponses: [
      { ok: false, status: 400, error: 'bad request' },
      { ok: true, status: 200, data: { status: 'submitted' } },
    ],
    extraDeps: {
      readline: {
        createInterface: () => ({
          question: (_prompt, callback) => callback(answers.shift()),
          close: () => {},
        }),
      },
    },
  });
  try {
    const result = await captureConsole(() => engine.runEngineLoginCommand(['claude', '--computer'], dir, deps));
    assert.equal(result.code, 0, result.stderr);
    assert.equal((result.stdout.match(/When the browser shows you a code, paste it here:/g) || []).length, 2);
    assert.equal((result.stderr.match(/that code did not work; paste it again\./g) || []).length, 1);
    const codeCalls = calls.filter((call) => /\/device-login\/s-claude-retry\/code$/.test(call.pathname));
    assert.deepEqual(codeCalls.map((call) => call.options.body), [
      { code: 'mistyped-code' },
      { code: 'correct-code' },
    ]);
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

test('readEngineRegistry does not mint engines.json in an empty folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-empty-'));
  try {
    const before = fs.readdirSync(dir).sort();
    require('../lib/engine-registry').readEngineRegistry(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown engine name fails cleanly with no stack trace (text + json)', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['engine', 'bogus'], dir);
    assert.equal(res.status, 2, res.stderr);
    // A new person must see a plain message, never a raw Node stack trace.
    assert.doesNotMatch(res.stderr, /at Object\.|throw new Error|\.js:\d+/);
    assert.match(res.stderr, /Unknown engine "bogus"/);
    assert.match(res.stderr, /known engines:/);
    // No engine file gets written for a typo.
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'engines.json')), false);

    const jsonRes = runCli(['engine', 'bogus', '--json'], dir);
    assert.equal(jsonRes.status, 2, jsonRes.stderr);
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Unknown engine "bogus"/);
    assert.ok(Array.isArray(parsed.known) && parsed.known.includes('codex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
