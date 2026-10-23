'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootTeamLine } = require('../lib/team-lineup');

test('boot lists the search job only once alongside the other jobs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-distinct-jobs-'));
  const keys = ['HOME', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_CONFIG_PATH'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.HOME = root;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(root, 'machine.json');
  process.env.ATRIS_MACHINE_ROSTER_MD_PATH = path.join(root, 'machine.md');
  process.env.ATRIS_CODEX_CONFIG_PATH = path.join(root, 'config.toml');
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## build\n- codex\n\n## review\n- claude\n\n## search\n- claude\n');
    const line = bootTeamLine(root, { width: 300, now: new Date('2026-09-27T12:00:00Z') });
    assert.strictEqual((line.match(/\bsearch\b/g) || []).length, 1);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
