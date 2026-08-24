'use strict';

// atris engine: the routing decisions are policy, not vibes. These tests pin
// the pure decision functions (default resolution precedence, flag parsing,
// seat/provider normalization) and the CLI error paths (unknown engine,
// dispatch arg shape, resolve usage) so a refactor cannot silently change
// which engine a run rides.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const {
  resolveDefaultEngine,
  readSavedEngine,
  canonicalEngineName,
  parseDispatchArgs,
  parseEngineLoginArgs,
  normalizeEngineLoginSeat,
  validEngineLoginSeat,
  expandHomePath,
  formatEngineSeats,
  setEngineHealth,
  HOUSE_ENGINE,
} = require('../commands/engine');
const { RUNNER_PROFILE_NAMES } = require('../lib/runner-command');

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  // A per-run engine override leaking in from the shell would change what
  // "default" resolves to inside these fixtures.
  delete env.ATRIS_RUNNER_PROFILE;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env,
  });
  if (result.error) throw result.error;
  return result;
}

function tmpRoot(prefix = 'atris-engine-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnvProfile(value, fn) {
  const prev = process.env.ATRIS_RUNNER_PROFILE;
  if (value === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
  else process.env.ATRIS_RUNNER_PROFILE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = prev;
  }
}

function writeSavedEngine(root, name) {
  const file = path.join(root, '.atris', 'engine.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ default: name })}\n`);
}

test('default engine precedence: env beats the saved file', () => {
  const root = tmpRoot();
  writeSavedEngine(root, 'cursor');
  const picked = withEnvProfile('codex', () => resolveDefaultEngine(root));
  assert.equal(picked.name, 'codex');
  assert.equal(picked.source, 'env');
});

test('default engine precedence: saved file wins when env is unset', () => {
  const root = tmpRoot();
  writeSavedEngine(root, 'cursor');
  const picked = withEnvProfile(undefined, () => resolveDefaultEngine(root));
  assert.equal(picked.name, 'cursor');
  assert.equal(picked.source, 'saved');
});

test('default engine resolution canonicalizes aliases and ignores junk env', () => {
  const root = tmpRoot();
  writeSavedEngine(root, 'cursor');
  // Alias spelling in the env still resolves to the canonical house engine.
  const aliased = withEnvProfile('atris2-fast', () => resolveDefaultEngine(root));
  assert.equal(aliased.name, HOUSE_ENGINE);
  assert.equal(aliased.source, 'env');
  // An unknown env value is not a pick: fall through to the saved policy.
  const junk = withEnvProfile('not-an-engine', () => resolveDefaultEngine(root));
  assert.equal(junk.name, 'cursor');
  assert.equal(junk.source, 'saved');
});

test('readSavedEngine returns empty for missing or unknown saved names', () => {
  const root = tmpRoot();
  assert.equal(readSavedEngine(root), '');
  writeSavedEngine(root, 'made-up-engine');
  assert.equal(readSavedEngine(root), '');
  writeSavedEngine(root, 'codex');
  assert.equal(readSavedEngine(root), 'codex');
});

test('canonicalEngineName: canonical names pass, aliases map, unknown is empty', () => {
  assert.equal(canonicalEngineName('codex'), 'codex');
  assert.equal(canonicalEngineName('atris2-fast'), 'atris-fast');
  assert.equal(canonicalEngineName('atris-2-fast'), 'atris-fast');
  assert.equal(canonicalEngineName('gpt-6'), '');
  assert.equal(canonicalEngineName(''), '');
  assert.equal(canonicalEngineName(undefined), '');
});

test('parseDispatchArgs keeps --engine values out of the task id list', () => {
  const parsed = parseDispatchArgs(['CLI-1', '--engine', 'cursor', 'CLI-2', '--yolo', '--json']);
  assert.deepEqual(parsed.taskIds, ['CLI-1', 'CLI-2']);
  assert.equal(parsed.engine, 'cursor');
  assert.equal(parsed.yolo, true);
  assert.equal(parsed.json, true);

  const equalsForm = parseDispatchArgs(['CLI-3', '--engine=codex', '--prompt-file=/tmp/p.md', '--base=master', '--mystery-flag']);
  assert.deepEqual(equalsForm.taskIds, ['CLI-3']);
  assert.equal(equalsForm.engine, 'codex');
  assert.equal(equalsForm.promptFile, '/tmp/p.md');
  assert.equal(equalsForm.base, 'master');
  // Unknown -- flags are skipped, never treated as task ids.
  assert.ok(!equalsForm.taskIds.includes('--mystery-flag'));
});

test('parseEngineLoginArgs: seat normalization and --business implies device flow', () => {
  const parsed = parseEngineLoginArgs(['claude', '--business', 'biz-1', '--seat', 'my seat']);
  assert.equal(parsed.provider, 'claude');
  assert.equal(parsed.business, 'biz-1');
  assert.equal(parsed.businessFlag, true);
  assert.equal(parsed.computer, true, '--business must switch to the device-login path');
  assert.equal(parsed.seat, 'MY_SEAT');

  const removeForm = parseEngineLoginArgs(['--remove=codex', '--json']);
  assert.equal(removeForm.remove, 'codex');
  assert.equal(removeForm.json, true);
});

test('seat names normalize and validate as uppercase word tokens', () => {
  assert.equal(normalizeEngineLoginSeat('  personal-work seat '), 'PERSONAL_WORK_SEAT');
  assert.ok(validEngineLoginSeat(normalizeEngineLoginSeat('personal')));
  assert.ok(!validEngineLoginSeat(''));
  assert.ok(!validEngineLoginSeat('_LEADING_UNDERSCORE'));
  assert.ok(!validEngineLoginSeat('BAD!CHARS'));
  assert.ok(!validEngineLoginSeat('A'.repeat(49)), 'over 48 chars must fail');
});

test('expandHomePath expands ~ against the given home dir only', () => {
  assert.equal(expandHomePath('~', '/home/kr'), '/home/kr');
  assert.equal(expandHomePath('~/.codex/auth.json', '/home/kr'), path.join('/home/kr', '.codex/auth.json'));
  assert.equal(expandHomePath('/abs/path', '/home/kr'), '/abs/path');
  assert.equal(expandHomePath('relative/~/x', '/home/kr'), 'relative/~/x');
});

test('formatEngineSeats: setup hint when empty, ready vs cooling otherwise', () => {
  assert.match(formatEngineSeats({ seats: [] }), /atris computer setup/);
  const nowSeconds = 1_700_000_000;
  const out = formatEngineSeats({
    seats: [
      { engine: 'codex', name: 'personal', cooling_until: 0 },
      { engine: 'claude', name: 'work', cooling_until: nowSeconds + 90 * 60 },
    ],
  }, nowSeconds * 1000);
  const lines = out.split('\n');
  assert.equal(lines[0], 'codex personal - ready');
  assert.match(lines[1], /^claude work - cooling down, back 1h 30m$/);
});

test('cli: unknown engine name is a clean exit 2, not a stack trace', () => {
  const root = tmpRoot();
  const res = runCli(['engine', 'gpt-6'], root);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown engine "gpt-6"/);
  assert.match(res.stderr, /codex/, 'error must list the known engines');
  assert.ok(!/at .*engine\.js:\d+/.test(res.stderr), 'no raw stack trace');

  const jsonRes = runCli(['engine', 'gpt-6', '--json'], root);
  assert.equal(jsonRes.status, 2);
  const payload = JSON.parse(jsonRes.stdout.slice(jsonRes.stdout.indexOf('{')));
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.known, Array.from(RUNNER_PROFILE_NAMES));
});

test('cli: set default persists to .atris/engine.json, reset removes it', () => {
  const root = tmpRoot();
  const set = runCli(['engine', 'codex'], root);
  assert.equal(set.status, 0);
  const file = path.join(root, '.atris', 'engine.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.default, 'codex');

  const list = runCli(['engine', 'list', '--json', '--global'], root);
  assert.equal(list.status, 0);
  const payload = JSON.parse(list.stdout.slice(list.stdout.indexOf('{')));
  assert.equal(payload.default, 'codex');
  assert.equal(payload.source, 'saved');
  const flagged = payload.engines.filter((engine) => engine.default);
  assert.deepEqual(flagged.map((engine) => engine.id), ['codex']);

  const reset = runCli(['engine', 'reset'], root);
  assert.equal(reset.status, 0);
  assert.ok(!fs.existsSync(file), 'reset must delete the saved default');

  const again = runCli(['engine', 'reset'], root);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing to reset/);
});

test('cli: resolve without a role or with an unknown role is usage exit 2', () => {
  const root = tmpRoot();
  const missing = runCli(['engine', 'resolve'], root);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: atris engine resolve <role>/);

  const unknown = runCli(['engine', 'resolve', 'poet', '--json'], root);
  assert.equal(unknown.status, 2);
  const payload = JSON.parse(unknown.stdout.slice(unknown.stdout.indexOf('{')));
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Unknown role "poet"/);
});

test('routing honors saved health policy: credit_out engines are never picked', () => {
  // Flip every engine to credit_out in this root. Even on a machine where the
  // binaries are installed, resolve must refuse: the health file is policy
  // and routing decides from it, not from what happens to be on the PATH.
  const root = tmpRoot();
  for (const name of RUNNER_PROFILE_NAMES) {
    setEngineHealth(name, 'credit_out', root);
  }
  const res = runCli(['engine', 'resolve', 'executor', '--json'], root);
  assert.equal(res.status, 1);
  const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
  assert.equal(payload.ok, false);
  assert.match(payload.error, /No ready installed engine can fill role "executor"/);
});

test('a settled registry is never rewritten by reads, so readers cannot stomp mutations', () => {
  const root = tmpRoot();
  const registryLib = require('../lib/engine-registry');
  registryLib.readEngineRegistry(root);
  const file = registryLib.engineRegistryFile(root);
  const before = fs.statSync(file).mtimeMs;
  const savedText = fs.readFileSync(file, 'utf8');
  registryLib.readEngineRegistry(root);
  registryLib.resolveEngineForRoleRanked('executor', root);
  assert.equal(fs.readFileSync(file, 'utf8'), savedText, 'read paths must not rewrite the policy file');
  assert.equal(fs.statSync(file).mtimeMs, before, 'read paths must not touch the policy file');
});

test('resolve is probe-free: no child_process call happens on a settled registry', () => {
  // Routing must decide from the saved policy file alone. Seed the registry
  // once (the only moment a probe is allowed), then spy on every child_process
  // entry point and assert resolve never touches the machine.
  const root = tmpRoot();
  const registryLib = require('../lib/engine-registry');
  registryLib.readEngineRegistry(root);

  const childProcess = require('node:child_process');
  const spied = ['spawnSync', 'spawn', 'exec', 'execSync', 'execFile', 'execFileSync'];
  const originals = new Map(spied.map((name) => [name, childProcess[name]]));
  const calls = [];
  for (const name of spied) {
    childProcess[name] = (...args) => {
      calls.push(`${name} ${JSON.stringify(args[0])}`);
      return originals.get(name)(...args);
    };
  }
  try {
    const picked = registryLib.resolveEngineForRoleRanked('executor', root);
    assert.ok(Array.isArray(picked.ranked));
    assert.deepEqual(calls, [], 'resolve must make zero child_process calls');
    // The nothing-configured default path rides the same rule: no env, no
    // saved engine.json, and the pick still comes from registry policy alone.
    const fallback = withEnvProfile(undefined, () => resolveDefaultEngine(root));
    assert.ok(fallback.name, 'default resolution must still pick a name');
    assert.ok(['house', 'detected', 'none'].includes(fallback.source));
    assert.deepEqual(calls, [], 'default resolution must make zero child_process calls');
  } finally {
    for (const name of spied) childProcess[name] = originals.get(name);
  }
});

test('nothing configured: the default comes from registry health, not the machine', () => {
  // No env, no .atris/engine.json. The registry health file is the only
  // input: flip it and the pick flips, without any probe in between.
  const root = tmpRoot();
  for (const name of RUNNER_PROFILE_NAMES) {
    setEngineHealth(name, 'not_installed', root);
  }
  // No ready engine anywhere: fall back to the house default anyway. The
  // missing binary is the execution stage's problem, not resolution's.
  const none = withEnvProfile(undefined, () => resolveDefaultEngine(root));
  assert.equal(none.name, HOUSE_ENGINE);
  assert.equal(none.source, 'none');

  // A ready non-house engine in policy becomes the detected default, even on
  // a machine where that binary does not exist.
  setEngineHealth('cursor', 'ready', root);
  const detected = withEnvProfile(undefined, () => resolveDefaultEngine(root));
  assert.equal(detected.name, 'cursor');
  assert.equal(detected.source, 'detected');

  // A ready house engine beats every other ready engine.
  setEngineHealth(HOUSE_ENGINE, 'ready', root);
  const house = withEnvProfile(undefined, () => resolveDefaultEngine(root));
  assert.equal(house.name, HOUSE_ENGINE);
  assert.equal(house.source, 'house');
});

test('routing believes a ready health flag even when the binary is missing', () => {
  // Policy over probes, the other direction: an operator-set "ready" wins.
  // The missing binary is a problem for the execution stage, where it must fail
  // in one plain sentence naming the binary.
  const root = tmpRoot();
  for (const name of RUNNER_PROFILE_NAMES) {
    setEngineHealth(name, 'not_installed', root);
  }
  setEngineHealth('devin', 'ready', root);
  const res = runCli(['engine', 'resolve', 'executor', '--json'], root);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
  assert.equal(payload.id, 'devin');

  const { requireEngineBin } = require('../lib/engine-registry');
  const prevPath = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent-dir-for-this-test';
    assert.throws(
      () => requireEngineBin('devin'),
      /devin CLI \(devin\) is not installed here/,
      'execution must name the missing binary'
    );
  } finally {
    process.env.PATH = prevPath;
  }
});

test('cli: engine doctor is the explicit probe pass and respects credit_out policy', () => {
  const root = tmpRoot();
  const binDir = path.join(root, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'cursor-agent'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  setEngineHealth('cursor', 'credit_out', root);

  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${binDir}${path.delimiter}/usr/bin:/bin` };
  const res = spawnSync(process.execPath, [cliPath, 'engine', 'doctor', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 20000, env,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
  const byId = new Map(payload.engines.map((engine) => [engine.id, engine]));
  assert.equal(byId.get('codex').installed, true);
  assert.equal(byId.get('codex').health.status, 'ready');
  assert.equal(byId.get('devin').installed, false);
  assert.equal(byId.get('devin').health.status, 'not_installed');
  // credit_out is operator policy: doctor updates installed but keeps it.
  assert.equal(byId.get('cursor').installed, true);
  assert.equal(byId.get('cursor').health.status, 'credit_out');

  // Doctor persists its findings so routing keeps reading policy, not PATH.
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'engines.json'), 'utf8'));
  assert.equal(saved.engines.find((engine) => engine.id === 'devin').health.status, 'not_installed');
});

test('cli: dispatch argument shape errors surface before any environment check', () => {
  const root = tmpRoot();
  const noEngine = runCli(['engine', 'dispatch', 'CLI-1'], root);
  assert.equal(noEngine.status, 2);
  assert.match(noEngine.stderr, /usage: atris engine dispatch/);

  const badEngine = runCli(['engine', 'dispatch', 'CLI-1', '--engine', 'atris-fast'], root);
  assert.equal(badEngine.status, 2);
  assert.match(badEngine.stderr, /--engine must be one of/);

  const multiPrompt = runCli([
    'engine', 'dispatch', 'CLI-1', 'CLI-2', '--engine', 'cursor', '--prompt-file', '/nope/prompt.md',
  ], root);
  assert.equal(multiPrompt.status, 2);
  assert.match(multiPrompt.stderr, /--prompt-file only supports a single task id/);
});
