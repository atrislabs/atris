'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a member with a neutral name gets the engine for their research role', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-role-card-'));
  const keys = ['HOME', 'ATRIS_HOME', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROSTER_SESSION'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.HOME = root;
  process.env.ATRIS_HOME = path.join(root, '.atris');
  try {
    const team = path.join(root, 'atris', 'team', 'alex');
    fs.mkdirSync(team, { recursive: true });
    fs.writeFileSync(path.join(team, 'MEMBER.md'), '---\nname: alex\nrole: Researcher\n---\n# Alex\n');
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), [
      '# roster', '',
      '## build', '- codex, model: gpt-5.4', '',
      '## search', '- claude code, model: opus 5.5', '',
    ].join('\n'));
    const season = require('../lib/gm-season');
    const result = season.loadCard(root, 'alex', {
      now: Date.UTC(2026, 9, 21, 12),
      dbPath: path.join(root, 'missing.db'),
    });
    assert.strictEqual(result.card.engine.engine, 'claude');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
