'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootTeamLine } = require('../lib/team-lineup');

test('boot lineup shows a keyed build job exactly once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lineup-mut-L68-6-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(bootTeamLine(root, {
    now: new Date('2025-01-15T12:00:00Z'),
    width: 1000,
    jobs: [{ job: 'build', key: 'custom-build', now_runs: { engine: 'codex' } }],
  }), 'build codex');
});
