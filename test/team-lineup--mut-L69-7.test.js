'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootTeamLine } = require('../lib/team-lineup');

test('a custom job without a saved key still advertises its running tool', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-custom-job-'));
  const line = bootTeamLine(root, {
    now: new Date('2026-09-27T12:00:00.000Z'),
    jobs: [{ job: 'small build', now_runs: { engine: 'codex' } }],
  });

  assert.match(line, /small build\s+codex/);
});
