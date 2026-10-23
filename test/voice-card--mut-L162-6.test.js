'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAgentVoiceCard } = require('../lib/voice-card');

test('appends brain compile block when compile start tag is missing closing tag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-mut-'));
  try {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, '# AGENTS\n\n<!-- ATRIS_BRAIN_COMPILE:START -->\n', 'utf8');

    const result = upsertAgentVoiceCard(file, 'Keep it simple.');

    assert.equal(result.content.includes('## Atris Brain Compile'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
