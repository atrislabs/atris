'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memberEngineChoices } = require('../lib/roster-swap');
const { RUNNER_PROFILE_DEFS } = require('../lib/runner-command');

test('a known current model appears only once in its engine group', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-current-model-'));
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    const roster = path.join(root, '.atris', 'ROSTER.md');
    process.env.ATRIS_MACHINE_ROSTER_MD_PATH = roster;
    fs.mkdirSync(path.dirname(roster), { recursive: true });
    fs.writeFileSync(roster, '# roster\n\n## search\n- claude code, model: haiku 5.5\n');
    const memberDir = path.join(root, 'atris', 'team', 'researcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: researcher\nrole: researcher\n---\n');
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const engines = Object.keys(RUNNER_PROFILE_DEFS).map((id) => ({
      id,
      installed: id === 'claude',
      health: { status: id === 'claude' ? 'ready' : 'not_installed', checked_at: '2026-01-15T12:00:00.000Z' },
    }));
    fs.writeFileSync(path.join(stateDir, 'engines.json'), JSON.stringify({ engines }));
    const card = memberEngineChoices(root, 'researcher', { now: 1768478400000 });
    const group = card.groups.find((item) => item.engine === 'claude');
    assert.equal(group.models.filter((item) => item.current).length, 1);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
