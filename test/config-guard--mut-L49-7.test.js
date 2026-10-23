'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isClaudeSettingsPath } = require('../lib/config-guard');

test('relative settings paths use the supplied working directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-cwd-'));
  try {
    assert.equal(isClaudeSettingsPath('settings.json', {
      cwd: dir,
      home: dir,
      configDir: dir,
    }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
