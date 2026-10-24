'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a receipt keeps its owner when its mission is no longer saved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-receipt-owner-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const { collectStreamEvents } = require('../commands/stream');
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'finished-mission.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'finished-mission',
      owner: 'mina',
      objective: 'check the release',
      at: '2026-07-06T08:06:00.000Z',
      result: {
        kind: 'mission_run_tick',
        tick: {
          status: 'ran',
          summary: 'checked the release',
          verifier_passed: true,
          started_at: '2026-07-06T08:05:00.000Z',
          finished_at: '2026-07-06T08:06:00.000Z',
        },
      },
    }));

    const events = collectStreamEvents({
      root,
      sinceMs: Date.parse('2026-07-06T08:00:00.000Z'),
      nowMs: Date.parse('2026-07-06T09:00:00.000Z'),
      skipLanding: true,
      deps: {
        listWorktrees: () => [],
        runGit: () => ({ status: 1, stdout: '', stderr: '' }),
      },
    });
    const receipt = events.find((event) => event.source === 'mission_receipt');
    assert.strictEqual(receipt?.agent, 'mina');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
