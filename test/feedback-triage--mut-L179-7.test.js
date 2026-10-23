'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planFeedbackTriage, dispatchFeedbackTriage } = require('../lib/feedback-triage');

test('dispatch preserves the engine selected by the supplied resolver', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-engine-choice-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const brief = planFeedbackTriage({
      id: 'feedback-engine-choice',
      message: 'Resolved reports still appear in the open feedback queue.',
      context: { verify_command: 'node --test' },
    }, root);
    const result = await dispatchFeedbackTriage(brief, root, {
      resolveEngine: () => ({ engine: { id: 'claude' } }),
      dispatch: async (jobs) => jobs.map(job => ({
        ...job,
        ok: true,
        stdout: 'The report remains in the queue.\nverdict: reproduced',
        stderr: '',
      })),
    });
    assert.strictEqual(result.engine, 'claude');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
