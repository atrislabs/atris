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
    assert.deepEqual(names, ['atris-fast', 'claude', 'codex', 'cursor', 'devin']);
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
    assert.match(bad.stderr, /atris-fast, claude, codex, cursor, devin/);
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
  // claude rides the default claude-shaped spawn, no template needed
  assert.equal(RUNNER_PROFILES.claude.commandTemplate, '');
});
