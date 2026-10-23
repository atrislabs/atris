'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addIdea, readIdeas } = require('../lib/idea-inbox');

test('a waiting idea retains its saved intake timestamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-intake-time-'));
  const at = '2025-04-12T09:30:00.000Z';
  try {
    addIdea(root, 'make inbox search faster', { now: new Date(at) });
    assert.strictEqual(readIdeas(root)[0].at, at);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
