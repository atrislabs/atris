'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanLoopReceipts } = require('../lib/loop-doctor');

test('repeated pauses name the pause reason in the proposed repair', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pause-label-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  for (const name of ['mission-first.json', 'mission-second.json']) {
    fs.writeFileSync(path.join(runs, name), JSON.stringify({
      ts: '2026-07-10T11:00:00.000Z',
      pause_reason: 'claude-session-busy',
    }));
  }

  const finding = scanLoopReceipts({
    root,
    now: '2026-07-10T12:00:00.000Z',
  }).find((entry) => entry.kind === 'repeated_pause_reason');

  assert.match(finding.suggested_mission.objective, /\bpause reason\b/);
});
