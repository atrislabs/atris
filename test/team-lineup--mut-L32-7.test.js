'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootTeamLine } = require('../lib/team-lineup');

test('boot line omits the claude tool prefix for its model label', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lineup-label-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(bootTeamLine(root, {
    now: new Date('2025-01-15T12:00:00.000Z'),
    jobs: [{
      job: 'build',
      now_runs: { engine: 'claude', model: 'claude-opus-5-5' },
    }],
  }), 'build opus 5.5');
});
