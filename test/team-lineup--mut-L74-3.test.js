'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootTeamLine } = require('../lib/team-lineup');

test('boot lineup keeps a custom job when the full line exactly fits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lineup-exact-fit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const expected = 'build codex · docs codex';
  const actual = bootTeamLine(root, {
    width: expected.length,
    now: new Date('2025-01-15T12:00:00.000Z'),
    jobs: [
      { job: 'build', now_runs: { engine: 'codex' } },
      { job: 'docs', now_runs: { engine: 'codex' } },
    ],
  });

  assert.equal(actual, expected);
});
