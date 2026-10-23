const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSpawnRequest } = require('../commands/agent-spawn');

test('spawn request id carries the requested role', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-'));
  try {
    const request = createSpawnRequest(dir, {
      role: 'scout',
      task: 'Map the flag parsing path',
      engine: 'manual',
    });
    assert.match(request.id, /^spawn-\d{14}-scout-[0-9a-f]{6}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
