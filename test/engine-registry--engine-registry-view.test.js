'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-registry-view-home-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { engineRegistryView } = require('../lib/engine-registry');

const temps = [home];

// Catalog copied from the runner profiles and the registry seed. Health is
// supplied by the fixture so a view never asks this machine which tools exist.
const PROFILES = [
  { id: 'atris-fast', bin: 'ax', tier: 'fast', roles: ['navigator'], models: ['atris fast'], duty: 'learning', fallback_order: 10 },
  { id: 'mercury', bin: 'ax', tier: 'fast', roles: [], models: ['mercury 3 (test model)'], duty: '', fallback_order: 100 },
  { id: 'claude', bin: 'claude', tier: 'max', roles: ['validator', 'executor', 'navigator'], models: ['opus 5.5', 'opus 5', 'fable', 'haiku'], duty: '', fallback_order: 20 },
  { id: 'codex', bin: 'codex', tier: 'pro', roles: ['executor'], models: ['codex'], duty: '', fallback_order: 10 },
  { id: 'cursor', bin: 'cursor-agent', tier: 'pro', roles: ['executor'], models: ['composer 2.5', 'grok 4.6', 'kimi 3'], duty: '', fallback_order: 30 },
  { id: 'fable', bin: 'claude', tier: 'max', roles: ['validator', 'executor'], models: ['opus 5.5', 'opus 5', 'fable', 'haiku'], duty: 'leader', fallback_order: 50 },
  { id: 'composer', bin: 'ax', tier: 'fast', roles: ['navigator', 'executor'], models: ['composer 2.5'], duty: '', fallback_order: 60 },
  { id: 'haiku', bin: 'claude', tier: 'fast', roles: ['validator', 'navigator'], models: ['haiku'], duty: '', fallback_order: 70 },
  { id: 'devin', bin: 'devin', tier: 'max', roles: ['executor'], models: ['built-in router'], duty: 'errands', fallback_order: 40 },
  { id: 'grok', bin: 'grok', tier: 'pro', roles: ['executor'], models: ['grok 4.7 fast', 'grok 4.7'], duty: '', fallback_order: 45 },
  {
    id: 'agy',
    bin: 'agy',
    tier: 'pro',
    roles: ['executor'],
    models: [
      'gemini-3.8-flash',
      'gemini-4-argon-high',
      'gemini-4-argon-medium',
      'gemini-3.8-flash-high',
      'claude-opus-5-5-high',
      'claude-sonnet-5-5-high',
      'gpt-oss-120b-medium',
    ],
    duty: 'errands',
    fallback_order: 90,
  },
  { id: 'opencode', bin: 'opencode', tier: 'pro', roles: ['executor'], models: ['opencode/big-pickle', 'opencode/claude-opus-5-5', 'opencode/gpt-5.2'], duty: '', fallback_order: 95 },
  { id: 'commandcode', bin: 'cmd', tier: 'max', roles: ['validator', 'executor'], models: ['machine default'], duty: 'errands', fallback_order: 98 },
];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-registry-view-'));
  temps.push(root);
  return root;
}

function writeEngines(root, engines) {
  const file = path.join(root, '.atris', 'state', 'engines.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ engines })}\n`);
  return file;
}

function ready(id) {
  return { id, name: id, installed: true, health: { status: 'ready' } };
}

function seeded(profile, extra = {}) {
  return {
    id: profile.id,
    name: profile.id,
    installed: true,
    health: { status: 'ready' },
    bin: profile.bin,
    tier: profile.tier,
    roles: profile.roles,
    models: profile.models,
    duty: profile.duty,
    fallback_order: profile.fallback_order,
    ...extra,
  };
}

function byId(engines, id) {
  const found = engines.find((engine) => engine.id === id);
  assert.ok(found, `missing ${id}`);
  return found;
}

test.after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

test('a saved registry comes back with seed models and the saved overrides', () => {
  const root = makeRoot();
  writeEngines(root, PROFILES.map((profile) => {
    if (profile.id !== 'codex') return ready(profile.id);
    return {
      ...ready(profile.id),
      tier: 'max',
      duty: 'leader',
      roles: ['executor'],
      fallback_order: 2,
      models: ['not-the-seed'],
      note: 'weekday build',
    };
  }));

  const engines = engineRegistryView(root);
  const again = engineRegistryView(root);

  const expected = PROFILES.map((profile) => seeded(profile));
  const expectedCodex = expected.find((engine) => engine.id === 'codex');
  expectedCodex.tier = 'max';
  expectedCodex.duty = 'leader';
  expectedCodex.roles = ['executor'];
  expectedCodex.fallback_order = 2;
  expectedCodex.note = 'weekday build';

  assert.deepStrictEqual(engines.map((engine) => engine.id), PROFILES.map((profile) => profile.id));
  assert.deepStrictEqual(again, engines);
  assert.deepStrictEqual(engines, expected);

  const codex = byId(engines, 'codex');
  const fable = byId(engines, 'fable');
  assert.deepStrictEqual(codex.models, ['codex']);
  assert.equal(codex.duty, 'leader');
  assert.equal(codex.note, 'weekday build');
  assert.equal(fable.duty, 'leader');
  assert.equal(byId(engines, 'commandcode').bin, 'cmd');
  assert.deepStrictEqual(byId(engines, 'mercury').roles, []);
});

test('odd saved rows keep a fixed shape', () => {
  const root = makeRoot();
  const saved = PROFILES.map((profile) => ready(profile.id));
  const replace = (id, entry) => {
    const index = saved.findIndex((engine) => engine.id === id);
    saved[index] = entry;
  };
  replace('codex', {
    id: 'codex',
    name: 'codex',
    installed: true,
    health: { status: 'ready' },
    tier: 'fast',
    duty: 'leader',
    roles: ['validator', 'nope', 'executor', 'validator'],
    fallback_order: 0,
    models: ['should-not-stick'],
  });
  replace('cursor', {
    ...ready('cursor'),
    models_set_by_owner: true,
    models: ['  grok 4.6  ', '', 'grok 4.6', 'kimi 3'],
  });
  replace('composer', {
    ...ready('composer'),
    models_set_by_owner: true,
    models: ['', '   '],
  });
  replace('claude', { ...ready('claude'), tier: ' max ' });
  replace('haiku', {
    id: 'haiku',
    name: 'haiku',
    installed: true,
    health: {
      status: 'cooling',
      cooling_until: '2099-06-15T12:00:00.000Z',
      cooling_reason: 'lost its connection',
      last_failure_ts: '2020-01-01T00:00:00.000Z',
    },
  });
  replace('fable', {
    id: 'fable',
    name: 'fable',
    installed: true,
    health: {
      status: 'cooling',
      cooling_until: '1999-12-31T00:00:00.000Z',
      cooling_reason: 'stalled',
      last_failure_ts: '1999-12-31T00:00:00.000Z',
    },
  });
  replace('devin', {
    id: 'devin',
    name: 'devin',
    installed: true,
    health: { status: 'error', last_failure_ts: '2020-06-01T00:00:00.000Z' },
  });
  replace('opencode', {
    id: 'opencode',
    name: 'opencode',
    installed: false,
    health: { status: 'not_installed', checked_at: '2099-01-01T00:00:00.000Z' },
  });
  replace('agy', {
    id: 'antigravity',
    installed: false,
    tier: 'ultra',
    duty: 'captain',
    roles: ['nope'],
    fallback_order: 'soon',
    models: ['nope'],
    health: { status: 'credit_out', last_failure_ts: '2024-05-01T00:00:00.000Z' },
  });
  saved.push({ id: 'not-a-real-engine', health: { status: 'ready' } }, { id: '   ' });
  writeEngines(root, saved);

  const engines = engineRegistryView(root);

  assert.deepStrictEqual(engines.map((engine) => engine.id), PROFILES.map((profile) => profile.id));
  assert.equal(engines.some((engine) => engine.id === 'antigravity' || engine.id === 'not-a-real-engine'), false);

  const codex = byId(engines, 'codex');
  assert.equal(codex.tier, 'fast');
  assert.equal(codex.duty, 'leader');
  assert.equal(codex.fallback_order, 0);
  assert.deepStrictEqual(codex.roles, ['validator', 'executor']);
  assert.deepStrictEqual(codex.models, ['codex']);

  const cursor = byId(engines, 'cursor');
  assert.equal(cursor.models_set_by_owner, true);
  assert.deepStrictEqual(cursor.models, ['grok 4.6', 'kimi 3']);

  const composer = byId(engines, 'composer');
  assert.equal(composer.models_set_by_owner, true);
  assert.deepStrictEqual(composer.models, ['composer 2.5']);

  assert.equal(byId(engines, 'claude').tier, 'max');
  assert.deepStrictEqual(byId(engines, 'haiku').health, {
    status: 'cooling',
    last_failure_ts: '2020-01-01T00:00:00.000Z',
    cooling_until: '2099-06-15T12:00:00.000Z',
    cooling_reason: 'lost its connection',
  });
  assert.deepStrictEqual(byId(engines, 'fable').health, { status: 'ready' });
  assert.equal(byId(engines, 'fable').duty, 'leader');
  assert.deepStrictEqual(byId(engines, 'devin').health, {
    status: 'error',
    last_failure_ts: '2020-06-01T00:00:00.000Z',
  });
  assert.deepStrictEqual(byId(engines, 'opencode').health, {
    status: 'not_installed',
    checked_at: '2099-01-01T00:00:00.000Z',
  });
  assert.equal(byId(engines, 'opencode').installed, false);

  const agy = byId(engines, 'agy');
  assert.equal(agy.name, 'agy');
  assert.equal(agy.bin, 'agy');
  assert.equal(agy.installed, false);
  assert.equal(agy.tier, 'pro');
  assert.equal(agy.duty, '');
  assert.equal(agy.fallback_order, 90);
  assert.deepStrictEqual(agy.roles, ['executor']);
  assert.deepStrictEqual(agy.models, PROFILES.find((profile) => profile.id === 'agy').models);
  assert.deepStrictEqual(agy.health, {
    status: 'credit_out',
    last_failure_ts: '2024-05-01T00:00:00.000Z',
  });
});

test('an empty folder, a broken file, and a bad root stay predictable', () => {
  const empty = makeRoot();
  const engines = engineRegistryView(empty);

  assert.equal(fs.existsSync(path.join(empty, '.atris')), false);
  assert.deepStrictEqual(engines.map((engine) => ({
    id: engine.id,
    name: engine.name,
    bin: engine.bin,
    tier: engine.tier,
    roles: engine.roles,
    models: engine.models,
    duty: engine.duty,
    fallback_order: engine.fallback_order,
  })), PROFILES.map((profile) => ({ ...profile, name: profile.id })));
  for (const engine of engines) {
    assert.equal(typeof engine.installed, 'boolean');
    assert.equal(engine.health.status === 'ready' || engine.health.status === 'not_installed', true);
  }

  const broken = makeRoot();
  const file = writeEngines(broken, []);
  fs.writeFileSync(file, '{');
  const recovered = engineRegistryView(broken);
  assert.deepStrictEqual(recovered.map((engine) => engine.id), PROFILES.map((profile) => profile.id));
  assert.deepStrictEqual(byId(recovered, 'atris-fast').models, ['atris fast']);
  assert.equal(byId(recovered, 'mercury').roles.length, 0);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema, 'atris.engine_registry.v2');
  assert.deepStrictEqual(saved.engines.map((engine) => engine.id), PROFILES.map((profile) => profile.id));

  assert.throws(() => engineRegistryView(null), TypeError);
  assert.throws(() => engineRegistryView(42), TypeError);
});
