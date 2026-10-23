'use strict';

// resolveRegisteredEngine turns a name or alias into the engine entry saved in
// a project's engine registry, or throws and lists the ids it does know. Every
// engine below is written with a saved health status, so the registry never
// probes this machine for installed tools.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-resolve-engine-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { resolveRegisteredEngine } = require('../lib/engine-registry');
const { RUNNER_PROFILE_DEFS } = require('../lib/runner-command');

const ENGINE_IDS = Object.keys(RUNNER_PROFILE_DEFS);

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// A project folder whose engines.json saves every engine as ready, plus any
// per-engine overrides, so resolving reads the file and never the machine.
function makeRoot(overrides = {}) {
  const root = fs.mkdtempSync(path.join(tmpHome, 'root-'));
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const engines = ENGINE_IDS.map((id) => ({
    id,
    name: id,
    health: { status: 'ready' },
    installed: true,
    ...(overrides[id] || {}),
  }));
  fs.writeFileSync(path.join(stateDir, 'engines.json'), JSON.stringify({ engines }, null, 2));
  return root;
}

test('resolves a canonical engine id to its registry entry', () => {
  const root = makeRoot();
  const engine = resolveRegisteredEngine('codex', root);
  assert.strictEqual(engine.id, 'codex');
  assert.strictEqual(engine.name, 'codex');
  assert.strictEqual(engine.bin, RUNNER_PROFILE_DEFS.codex.bin);
  assert.strictEqual(engine.tier, 'pro');
  assert.deepStrictEqual(engine.roles, ['executor']);
  assert.strictEqual(engine.installed, true);
  assert.deepStrictEqual(engine.health, { status: 'ready' });
});

test('returns an entry for every registered engine id', () => {
  const root = makeRoot();
  assert.ok(ENGINE_IDS.length > 1);
  for (const id of ENGINE_IDS) {
    const engine = resolveRegisteredEngine(id, root);
    assert.strictEqual(engine.id, id);
    assert.strictEqual(engine.bin, RUNNER_PROFILE_DEFS[id].bin);
  }
});

test('resolves aliases to the canonical engine', () => {
  const root = makeRoot();
  assert.strictEqual(resolveRegisteredEngine('antigravity', root).id, 'agy');
  assert.strictEqual(resolveRegisteredEngine('atris2-fast', root).id, 'atris-fast');
  assert.strictEqual(resolveRegisteredEngine('atris-2-fast', root).id, 'atris-fast');
});

test('trims whitespace around the requested name', () => {
  const root = makeRoot();
  assert.strictEqual(resolveRegisteredEngine('  claude \n', root).id, 'claude');
});

test('uses saved owner policy and keeps saved health as written', () => {
  const root = makeRoot({
    grok: { tier: 'max', duty: 'errands', fallback_order: 7, health: { status: 'credit_out' } },
  });
  const engine = resolveRegisteredEngine('grok', root);
  assert.strictEqual(engine.tier, 'max');
  assert.strictEqual(engine.duty, 'errands');
  assert.strictEqual(engine.fallback_order, 7);
  assert.strictEqual(engine.health.status, 'credit_out');
  assert.strictEqual(engine.installed, true);
});

test('owner-set models win over the seed list, unmarked saved models do not', () => {
  const root = makeRoot({
    cursor: { models: ['custom-a', 'custom-b'], models_set_by_owner: true },
    devin: { models: ['stale-model'] },
  });
  assert.deepStrictEqual(resolveRegisteredEngine('cursor', root).models, ['custom-a', 'custom-b']);
  assert.deepStrictEqual(resolveRegisteredEngine('devin', root).models, ['built-in router']);
});

test('throws an unknown-engine error that lists every registered id', () => {
  const root = makeRoot();
  assert.throws(
    () => resolveRegisteredEngine('not-an-engine', root),
    {
      name: 'Error',
      message: `Unknown engine "not-an-engine". Registered engine ids: ${ENGINE_IDS.join(', ')}`,
    },
  );
});

test('throws on empty, blank, and missing names', () => {
  const root = makeRoot();
  for (const value of ['', '   ', undefined, null]) {
    assert.throws(
      () => resolveRegisteredEngine(value, root),
      /^Error: Unknown engine "". Registered engine ids: /,
    );
  }
});

test('names are matched exactly, so a different case is unknown', () => {
  const root = makeRoot();
  assert.throws(
    () => resolveRegisteredEngine('CODEX', root),
    /Unknown engine "CODEX"/,
  );
});

test('does not rewrite a registry that is already settled for the engine it returns', () => {
  const root = makeRoot();
  const file = path.join(root, '.atris', 'state', 'engines.json');
  const first = resolveRegisteredEngine('haiku', root);
  const afterFirst = fs.readFileSync(file, 'utf8');
  const second = resolveRegisteredEngine('haiku', root);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), afterFirst);
  assert.deepStrictEqual(second, first);
});
