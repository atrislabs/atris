'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('scout vitals report no finding when a mission has a null landing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-null-landing-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { collectImproveVitals } = require('../commands/improve');
    const state = path.join(home, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1',
      owner: 'scout',
      updated_at: '2026-07-08T11:00:00.000Z',
      landing: null,
    }) + '\n');

    const vitals = collectImproveVitals(
      { workspace: home, now: '2026-07-08T12:00:00.000Z' },
      { cronInstalled: () => true }
    );
    assert.strictEqual(vitals.explore.finding_landed, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
