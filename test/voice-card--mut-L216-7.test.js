'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertClaudeVoiceHook } = require('../lib/voice-card');

test('new Claude settings preserve supplied initial settings when adding the voice hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-card-initial-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    const result = upsertClaudeVoiceHook(file, {
      initialSettings: { permissions: { allow: ['Read'] } },
    });
    const expected = `${JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        UserPromptSubmit: [{
          hooks: [{
            type: 'command',
            command: 'command -v atris >/dev/null 2>&1 && atris voice card --hook || true',
          }],
        }],
      },
    }, null, 2)}\n`;

    assert.deepEqual(result, { action: 'created', content: expected });
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
