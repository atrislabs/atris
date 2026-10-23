'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertCursorVoiceCard } = require('../lib/voice-card');

test('previewing a new Cursor card leaves its rule file absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hook-preview-'));
  try {
    const file = path.join(dir, '.cursor', 'rules', 'atris-voice.mdc');
    upsertCursorVoiceCard(file, 'Speak plainly.', { dryRun: true });
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
