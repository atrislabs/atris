'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateEngineOverride } = require('../lib/wish-audit');
const { RUNNER_PROFILE_DEFS } = require('../lib/runner-command');

const ENGINE_IDS = Object.keys(RUNNER_PROFILE_DEFS);

const savedEnv = {};
let tmpHome;
let root;

// Every engine is saved as ready, so the registry read never probes this
// machine for installed tools and never writes outside the temp folder.
function seedRegistry(dir) {
  const file = path.join(dir, '.atris', 'state', 'engines.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const engines = ENGINE_IDS.map((id) => ({ id, name: id, health: { status: 'ready' } }));
  fs.writeFileSync(file, JSON.stringify({ engines }), 'utf8');
}

test.before(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  savedEnv.HOME = process.env.HOME;
  savedEnv.USERPROFILE = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-validate-engine-home-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-validate-engine-root-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  seedRegistry(root);
});

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('returns a registered engine name unchanged', () => {
  assert.strictEqual(validateEngineOverride('codex', root), 'codex');
  assert.strictEqual(validateEngineOverride('atris-fast', root), 'atris-fast');
  for (const id of ENGINE_IDS) {
    assert.strictEqual(validateEngineOverride(id, root), id);
  }
});

test('trims surrounding whitespace and returns the trimmed name', () => {
  assert.strictEqual(validateEngineOverride('  codex  ', root), 'codex');
  assert.strictEqual(validateEngineOverride('\tclaude\n', root), 'claude');
});

test('accepts a known alias and returns the spelling it was given', () => {
  assert.strictEqual(validateEngineOverride('antigravity', root), 'antigravity');
  assert.strictEqual(validateEngineOverride('atris2-fast', root), 'atris2-fast');
  assert.strictEqual(validateEngineOverride(' atris-2-fast ', root), 'atris-2-fast');
});

test('returns an empty string for empty or missing input without reading the registry', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-validate-engine-empty-'));
  try {
    assert.strictEqual(validateEngineOverride('', emptyRoot), '');
    assert.strictEqual(validateEngineOverride('   ', emptyRoot), '');
    assert.strictEqual(validateEngineOverride(undefined, emptyRoot), '');
    assert.strictEqual(validateEngineOverride(null, emptyRoot), '');
    assert.strictEqual(validateEngineOverride(false, emptyRoot), '');
    assert.strictEqual(validateEngineOverride(0, emptyRoot), '');
    assert.deepStrictEqual(fs.readdirSync(emptyRoot), []);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('throws a plain error listing every registered engine for an unknown name', () => {
  assert.throws(
    () => validateEngineOverride('not-an-engine', root),
    (error) => {
      assert.ok(error instanceof Error);
      assert.strictEqual(
        error.message,
        `Unknown engine "not-an-engine". Registered engine ids: ${ENGINE_IDS.join(', ')}`
      );
      return true;
    }
  );
});

test('rejects names that only look close to a real engine', () => {
  // Matching is exact: no case folding, no prefix match, no inner whitespace.
  for (const bad of ['CODEX', 'Codex', 'cod', 'codex2', 'co dex', 'atris', 'agy-']) {
    assert.throws(
      () => validateEngineOverride(bad, root),
      /Unknown engine ".*"\. Registered engine ids: /,
      `expected "${bad}" to be rejected`
    );
  }
});

test('quotes the trimmed name in the error and stringifies non-string input', () => {
  assert.throws(() => validateEngineOverride('  nope  ', root), /^Error: Unknown engine "nope"\. /);
  assert.throws(() => validateEngineOverride(42, root), /Unknown engine "42"\. /);
});
