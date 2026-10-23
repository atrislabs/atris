'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-live-run-engine-text-'));
process.env.HOME = tmpDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

const { liveRunEngineText } = require('../lib/engine-processes');

test('liveRunEngineText formats normal engine and model combinations', () => {
  assert.strictEqual(
    liveRunEngineText({ engine: 'codex', model: 'gpt-5-codex' }),
    'codex · gpt-5-codex'
  );
  assert.strictEqual(
    liveRunEngineText({ engine: 'claude', model: 'claude-sonnet-4-5-20250929' }),
    'claude · sonnet 4.5'
  );
  assert.strictEqual(
    liveRunEngineText({ engine: 'claude', model: 'claude-opus-4' }),
    'claude · opus 4'
  );
  assert.strictEqual(
    liveRunEngineText({ engine: 'grok', model: 'grok-3-build-fast' }),
    'grok · grok 3 fast'
  );
});

test('liveRunEngineText handles edge cases such as missing models and whitespace', () => {
  assert.strictEqual(
    liveRunEngineText({ engine: 'cursor' }),
    'cursor · own default'
  );
  assert.strictEqual(
    liveRunEngineText({ engine: 'devin', model: '' }),
    'devin · own default'
  );
  assert.strictEqual(
    liveRunEngineText({ engine: 'opencode', model: null }),
    'opencode · own default'
  );
  assert.strictEqual(
    liveRunEngineText({ engine: '  claude  ', model: 'claude-opus-5' }),
    'claude · opus 5'
  );
  assert.strictEqual(
    liveRunEngineText({ engine: 'codex', model: '  o3-mini  ' }),
    'codex · o3-mini'
  );
});

test('liveRunEngineText falls back to dash for empty or invalid inputs', () => {
  assert.strictEqual(liveRunEngineText(null), '-');
  assert.strictEqual(liveRunEngineText(undefined), '-');
  assert.strictEqual(liveRunEngineText({}), '-');
  assert.strictEqual(liveRunEngineText({ engine: '' }), '-');
  assert.strictEqual(liveRunEngineText({ engine: '   ' }), '-');
  assert.strictEqual(liveRunEngineText({ model: 'claude-opus-5' }), '-');
  assert.strictEqual(liveRunEngineText(''), '-');
  assert.strictEqual(liveRunEngineText(false), '-');
});
