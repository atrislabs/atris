'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { availableModels } = require('../lib/roster-models');

function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-available-models-'));
  const keys = ['HOME', 'ATRIS_CODEX_MODELS_CACHE_PATH'];
  const previous = keys.map((key) => process.env[key]);
  process.env.HOME = home;
  delete process.env.ATRIS_CODEX_MODELS_CACHE_PATH;
  try {
    run(home);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('availableModels returns known Claude names and filters engine seed models', () => {
  withHome(() => {
    const engines = [
      { id: 'claude', models: ['ignored'] },
      { id: 'custom', models: ['first', '', null, false, 'second'] },
      { id: 'unknown', models: 'not an array' },
    ];
    const expected = [
      { engine: 'claude', models: ['opus 5.5', 'opus 5', 'sonnet 5', 'haiku 5.5', 'fable 5.1'], source: 'known names' },
      { engine: 'custom', models: ['first', 'second'], source: 'known names' },
      { engine: 'unknown', models: [], source: 'known names' },
    ];
    const rows = availableModels(engines);
    assert.deepStrictEqual(rows, expected);
    assert.deepStrictEqual(engines[1].models, ['first', '', null, false, 'second']);
    rows[0].models.push('local change');
    assert.deepStrictEqual(availableModels(engines), expected);
  });
});

test('availableModels reads nested Codex slugs in order, trimming and deduplicating them', () => {
  withHome((home) => {
    const cache = path.join(home, 'models.json');
    fs.writeFileSync(cache, JSON.stringify({ models: [
      { slug: ' alpha ' },
      { nested: [{ slug: 'beta' }, { slug: 'alpha' }] },
      { slug: '   ' },
      { slug: 42 },
      { slug: 'gamma' },
    ] }));
    assert.deepStrictEqual(availableModels([{ id: 'codex', models: ['fallback'] }], {
      codexModelsCachePath: cache,
    }), [{ engine: 'codex', models: ['alpha', 'beta', 'gamma'], source: 'from ~/models.json' }]);
  });
});

test('availableModels falls back to seed models for missing, malformed, or empty caches', () => {
  withHome((home) => {
    const cache = path.join(home, 'models.json');
    const engines = [{ id: 'codex', models: ['fallback'] }];
    const expected = [{ engine: 'codex', models: ['fallback'], source: 'known names' }];
    assert.deepStrictEqual(availableModels(engines, { codexModelsCachePath: cache }), expected);
    for (const contents of ['{invalid json', '{}', 'null', '{"models":[{"slug":" "}]}']) {
      fs.writeFileSync(cache, contents);
      assert.deepStrictEqual(availableModels(engines, { codexModelsCachePath: cache }), expected);
    }
    assert.deepStrictEqual(availableModels([{ id: 'codex' }], { codexModelsCachePath: cache }), [
      { engine: 'codex', models: [], source: 'known names' },
    ]);
  });
});

test('availableModels returns no rows for absent or empty engine lists', () => {
  assert.deepStrictEqual(availableModels(), []);
  assert.deepStrictEqual(availableModels(null), []);
  assert.deepStrictEqual(availableModels([]), []);
});
