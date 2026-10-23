'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootTeamLine } = require('../lib/team-lineup');

test('boot shows the search job only once when all built-in jobs are assigned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-job-order-'));
  const keys = ['HOME', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_CODEX_CONFIG_PATH'];
  const saved = keys.map((key) => process.env[key]);
  process.env.HOME = root;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(root, 'machine.json');
  process.env.ATRIS_CODEX_CONFIG_PATH = path.join(root, 'config.toml');
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## search\n- claude code, model: haiku 5.5\n\n## build\n- claude code, model: opus 5.5\n\n## review\n- codex, model: gpt-6-astra\n');
    const registry = require('../lib/engine-registry');
    registry.readEngineRegistry(root);
    for (const engine of ['claude', 'codex']) registry.setEngineHealth(engine, 'ready', root);
    const line = bootTeamLine(root, { width: 200, now: new Date('2026-09-27T12:00:00Z') });
    assert.strictEqual((line.match(/\bsearch\b/g) || []).length, 1);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});
