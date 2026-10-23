'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureMemberBundle } = require('../lib/member-scaffold');

test('a custom description becomes the member mission', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-purpose-'));
  try {
    ensureMemberBundle(root, {
      name: 'orb',
      role: 'Reviewer',
      description: 'Review accessibility regressions.',
      now: new Date('2026-08-20T12:00:00Z'),
    });
    const mission = fs.readFileSync(path.join(root, 'MISSION.md'), 'utf8');
    assert.match(mission, /Review accessibility regressions\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
