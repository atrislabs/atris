'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanLoopReceipts } = require('../lib/loop-doctor');

test('due-capability evidence preserves the configured caller runner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runner-evidence-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
    id: 'caller-1',
    status: 'running',
    cadence: '15m',
    runner: 'codex_goal',
    always_on: true,
    created_at: '2026-07-10T12:00:00.000Z',
  }) + '\n');

  const finding = scanLoopReceipts({
    root,
    now: '2026-07-10T12:00:00.000Z',
  }).find((entry) => entry.kind === 'zero_due_capable_missions');

  assert.equal(finding.evidence.runners[0], 'codex_goal');
});
