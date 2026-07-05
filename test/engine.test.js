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
    assert.deepEqual(names, ['atris-fast', 'claude', 'codex', 'cursor', 'devin', 'hermes']);
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
    assert.match(bad.stderr, /atris-fast, claude, codex, cursor, devin, hermes/);
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
