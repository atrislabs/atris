'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootTeamLine } = require('../lib/team-lineup');

test('bootTeamLine shows a resolved built-in job without custom jobs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lineup-built-in-'));
  try {
    assert.equal(bootTeamLine(root, {
      now: new Date('2025-01-15T12:00:00.000Z'),
      jobs: [{ job: 'build', now_runs: { engine: 'codex' } }],
    }), 'build codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
