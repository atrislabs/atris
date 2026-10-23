'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectImproveVitals } = require('../commands/improve');

test('scout missions with tied timestamps keep the first finding result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-tied-missions-'));
  const previousEnv = process.env;
  const previousCwd = process.cwd();
  process.env = { ...previousEnv, HOME: root };
  process.chdir(root);
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    // Separate missions can finish within the same recorded second.
    const missions = [true, false].map((finding_landed, index) => ({
      schema: 'atris.mission.v1',
      id: `scout-mission-${index + 1}`,
      owner: 'scout',
      updated_at: '2026-07-08T10:00:00Z',
      finding_landed,
    }));
    fs.writeFileSync(path.join(state, 'missions.jsonl'),
      missions.map(row => JSON.stringify(row)).join('\n') + '\n');

    const vitals = collectImproveVitals(
      { workspace: root, now: '2026-07-08T12:00:00Z' },
      { cronInstalled: () => false }
    );
    assert.strictEqual(vitals.explore.finding_landed, true);
  } finally {
    process.chdir(previousCwd);
    process.env = previousEnv;
  }
});
