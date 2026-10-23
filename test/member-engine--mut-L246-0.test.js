'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { teamRosterView } = require('../lib/member-engine');

test('a project team assignment warns when its member does not exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-roster-member-'));
  const overrides = {
    HOME: root,
    ATRIS_MACHINE_ROSTER_PATH: path.join(root, 'home', 'roster.json'),
    ATRIS_MACHINE_ROSTER_MD_PATH: path.join(root, 'home', 'ROSTER.md'),
    ATRIS_ROSTER_SESSION: '',
    ATRIS_ROSTER_SESSIONS_DIR: path.join(root, 'sessions'),
  };
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    fs.mkdirSync(path.join(root, 'atris', 'team'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## team\n- absent-reviewer: review\n');
    const view = teamRosterView(root, { now: new Date('2026-09-24T12:00:00Z') });
    assert.equal(view.warnings.some((warning) => /no team member named absent-reviewer/.test(warning.message)), true);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
