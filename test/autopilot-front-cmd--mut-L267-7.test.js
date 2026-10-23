'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { autopilotFront } = require('../commands/autopilot-front');

test('autopilot preserves an explicit leg wall in the saved mission budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-leg-wall-'));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    // An empty room has no runnable work or members. One leg only creates a
    // planning mission, exposing the budget without calling an AI engine.
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_SKIP_UPDATE_CHECK = '1';
    process.chdir(root);

    assert.equal(await autopilotFront(['--yes', '--once', '--leg-wall', '120']), 0);

    const missions = fs.readFileSync(
      path.join(root, '.atris', 'state', 'missions.jsonl'), 'utf8'
    ).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(missions.length, 1);
    assert.equal(missions[0].max_wall_seconds, 120);
    assert.equal(missions[0].budget_contract.requested_seconds, 120);
    assert.equal(missions[0].budget_contract.budget_label, '2 minutes');
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
