'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { swapFromCard } = require('../lib/roster-swap');
const { OWNER_BANNED } = require('../lib/gm-bet');

test('a swap for everyone that leaves a member on its own pick says so in plain words', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-own-model-'));
  const keys = ['HOME', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL'];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_MACHINE_ROSTER_MD_PATH = path.join(root, 'machine.md');
    fs.mkdirSync(path.join(root, 'atris', 'team', 'researcher'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', 'researcher', 'MEMBER.md'), '---\nname: researcher\nrole: researcher\n---\n');
    fs.writeFileSync(path.join(root, 'machine.md'), '# roster\n\n## search\n- claude code, model: haiku 5.5\n\n## team\n- researcher: claude code, model: opus 5.5\n');
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), JSON.stringify({ engines: [{ id: 'claude', health: { status: 'ready', checked_at: '2026-01-01T12:00:00.000Z' } }] }));
    const out = swapFromCard(root, 'researcher', 'claude', 'sonnet 5.5', 'job', { now: new Date('2026-01-01T12:00:00.000Z') });
    assert.match(out.line, / researcher keeps its own model\.$/, out.line);
    assert.doesNotMatch(out.line, /\bline\b/, out.line);
    assert.doesNotMatch(out.line, OWNER_BANNED, out.line);
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
});
