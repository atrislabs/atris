const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertClaudeVoiceHook } = require('../lib/voice-card');

test('voice hook skips settings whose top level is an array', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-card-array-'));
  try {
    const settingsPath = path.join(directory, 'settings.json');
    fs.writeFileSync(settingsPath, '[]');

    const result = upsertClaudeVoiceHook(settingsPath, { warn() {} });

    assert.equal(result.action, 'skipped');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '[]');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
