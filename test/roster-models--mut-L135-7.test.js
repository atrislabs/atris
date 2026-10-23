'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { availableModels } = require('../lib/roster-models');

test('available models uses the cache in a custom Codex home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-custom-model-cache-'));
  const keys = ['HOME', 'CODEX_HOME', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'NODE_TEST_CONTEXT'];
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, 'custom-codex');
    delete process.env.ATRIS_CODEX_MODELS_CACHE_PATH;
    delete process.env.NODE_TEST_CONTEXT;
    fs.mkdirSync(process.env.CODEX_HOME);
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'custom-cache-model' }] }));
    fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'default-cache-model' }] }));

    const row = availableModels([{ id: 'codex', models: ['fallback'] }])[0];
    assert.strictEqual(row.models[0], 'custom-cache-model');
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
