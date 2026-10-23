'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memberEngineChoices } = require('../lib/roster-swap');

test('member model choices display the readable name of a pinned Claude model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-choice-'));
  const keys = ['HOME', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR'];
  const saved = keys.map(key => [key, process.env[key]]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.HOME = root;
    const roster = path.join(root, '.atris', 'ROSTER.md');
    fs.mkdirSync(path.dirname(roster), { recursive: true });
    fs.writeFileSync(roster, '# roster\n\n## build\n- fable, model: claude-haiku-5-5\n\n## team\n- builder: fable, model: claude-haiku-5-5\n');
    process.env.ATRIS_MACHINE_ROSTER_MD_PATH = roster;
    const member = path.join(root, 'atris', 'team', 'builder');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: builder\nrole: builder\n---\n');
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), JSON.stringify({ engines: Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS).map(id => ({ id, ...(id === 'fable' ? { models: ['claude-haiku-5-5'], models_set_by_owner: true } : {}), health: { status: 'ready' } })) }));
    const card = memberEngineChoices(root, 'builder', { now: new Date('2026-01-15T12:00:00Z') });
    assert.equal(card.groups.find(group => group.engine === 'fable')?.models.find(model => model.model === 'claude-haiku-5-5')?.label, 'haiku 5.5');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
