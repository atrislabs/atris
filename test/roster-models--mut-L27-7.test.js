'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCodexSettings } = require('../lib/roster-models');

test('custom codex home supplies the configured model instead of the default home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
  const keys = ['HOME', 'CODEX_HOME', 'ATRIS_CODEX_CONFIG_PATH', 'NODE_TEST_CONTEXT'];
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, 'custom-codex');
    delete process.env.ATRIS_CODEX_CONFIG_PATH;
    // Exercise normal configuration discovery, with both homes safely isolated.
    delete process.env.NODE_TEST_CONTEXT;
    fs.mkdirSync(process.env.CODEX_HOME);
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-6-astra"\n');
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-6-sol"\n');

    assert.strictEqual(readCodexSettings().model, 'gpt-6-astra');
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
