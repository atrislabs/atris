'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memberEngineChoices } = require('../lib/roster-swap');

test('an unrecorded current model keeps its model name in the member card', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-current-model-'));
  const keys = ['HOME', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL'];
  const saved = keys.map(key => [key, process.env[key]]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.HOME = root;
    const roster = path.join(root, '.atris', 'ROSTER.md');
    fs.mkdirSync(path.dirname(roster), { recursive: true });
    fs.writeFileSync(roster, '# roster\n\n## build\n- codex, model: gpt-6-astra\n\n## team\n- builder: codex, model: gpt-6-astra\n');
    process.env.ATRIS_MACHINE_ROSTER_MD_PATH = roster;
    const member = path.join(root, 'atris', 'team', 'builder');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: builder\nrole: builder\n---\n');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    const { RUNNER_PROFILE_DEFS } = require('../lib/runner-command');
    fs.writeFileSync(path.join(state, 'engines.json'), JSON.stringify({ engines: Object.keys(RUNNER_PROFILE_DEFS).map(id => ({ id, installed: false, health: { status: 'error' } })) }));
    const card = memberEngineChoices(root, 'builder');
    assert.equal(card.groups.find(group => group.engine === 'codex').models.find(model => model.current).label, 'gpt-6-astra');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
