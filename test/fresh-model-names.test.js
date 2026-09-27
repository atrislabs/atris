const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEngineRegistry, setEngineOverrides } = require('../lib/engine-registry');

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fresh-models-'));
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  return dir;
}

function writeRegistry(dir, engines) {
  const file = path.join(dir, '.atris', 'state', 'engines.json');
  fs.writeFileSync(file, `${JSON.stringify({ schema: 'atris.engine_registry.v2', engines }, null, 2)}\n`, 'utf8');
  return file;
}

test('a saved model list without the owner mark thaws to the current seed list', () => {
  const dir = makeTempDir();
  try {
    writeRegistry(dir, [
      { id: 'grok', name: 'grok', tier: 'pro', roles: ['executor'], models: ['grok 4.5'], fallback_order: 45 },
    ]);
    const registry = readEngineRegistry(dir);
    assert.deepEqual(registry.engines.find((engine) => engine.id === 'grok').models, ['grok 4.7 fast', 'grok 4.7']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a model list set through setEngineOverrides survives a reread', () => {
  const dir = makeTempDir();
  try {
    const updated = setEngineOverrides('grok', { models: ['grok 99 owner pick'] }, dir);
    assert.deepEqual(updated.models, ['grok 99 owner pick']);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'engines.json'), 'utf8'));
    const savedGrok = saved.engines.find((entry) => entry.id === 'grok');
    assert.deepEqual(savedGrok.models, ['grok 99 owner pick']);
    assert.equal(savedGrok.models_set_by_owner, true);

    const registry = readEngineRegistry(dir);
    assert.deepEqual(registry.engines.find((engine) => engine.id === 'grok').models, ['grok 99 owner pick']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('thawing a stale list keeps the saved entry other fields', () => {
  const dir = makeTempDir();
  try {
    const file = writeRegistry(dir, [
      {
        id: 'grok',
        name: 'grok',
        tier: 'pro',
        roles: ['executor'],
        models: ['grok 4.5'],
        duty: 'errands',
        fallback_order: 45,
        operator_note: 'keep me',
      },
    ]);
    const registry = readEngineRegistry(dir);
    const grok = registry.engines.find((engine) => engine.id === 'grok');
    assert.equal(grok.duty, 'errands');
    assert.equal(grok.fallback_order, 45);
    assert.equal(grok.operator_note, 'keep me');

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const savedGrok = saved.engines.find((entry) => entry.id === 'grok');
    assert.equal(savedGrok.duty, 'errands');
    assert.equal(savedGrok.fallback_order, 45);
    assert.equal(savedGrok.operator_note, 'keep me');
    assert.equal(savedGrok.models_set_by_owner, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
