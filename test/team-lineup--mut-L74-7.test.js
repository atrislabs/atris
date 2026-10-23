'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootTeamLine } = require('../lib/team-lineup');

test('bootTeamLine includes custom jobs when they fit alongside built-in jobs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lineup-mut-L74-7-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(bootTeamLine(root, {
    width: 69,
    now: new Date('2025-01-15T12:00:00.000Z'),
    jobs: [
      { job: 'build', now_runs: { engine: 'codex' } },
      { job: 'deploy', now_runs: { engine: 'codex' } },
    ],
  }), 'build codex · deploy codex');
});
