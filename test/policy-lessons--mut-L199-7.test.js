const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mineProofPolicy } = require('../lib/policy-lessons');

test('orb failure lesson points to the failed job log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-custom-orb-log-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const row = {
      schema: 'atris.improve_tick.v1',
      ts: '2026-06-10T12:00:00.000Z',
      source: 'orb', member: 'pulse', mode: 'orb_failure',
      reward: -1, verify_passed: false, credits_deducted: 0,
      what_shipped: 'orb job failed: review docs', files_written: [],
      model_used: 'codex', task_id: null, elapsed_ms: 1200,
      next_task_suggestion: 'investigate failed orb job "review docs" from codex exit 1; open .atris/state/orb-runs/review-docs.log',
      orb_run_key: '2026-06-10T12:00:00.000Z|.atris/state/orb-runs/review-docs.log|codex|review docs', orb_kind: 'review', orb_engine: 'codex',
      orb_exit_code: 1, orb_log_path: '.atris/state/orb-runs/review-docs.log',
      orb_error: 'review failed',
    };
    const mined = mineProofPolicy({ receipts: [], episodes: [], scorecards: [row] }, {
      now: new Date('2026-06-11T12:00:00.000Z'),
    });
    assert.match(mined.lessons.find((lesson) => lesson.id === 'orb-job-failures').lesson, /review-docs\.log/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
