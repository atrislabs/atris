'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planFeedbackTriage, dispatchFeedbackTriage } = require('../lib/feedback-triage');

test('dispatch reports the resolved engine id string, not the engine object', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-triage-mut-'));
  try {
    const brief = planFeedbackTriage({
      id: 'feed-12345678',
      message: 'Steps to reproduce:\n1. Open the queue.\n2. Watch it fail.',
      context: { verify_command: 'node --test test/example.test.js' },
    }, root);

    const engineCalls = [];
    const dispatched = await dispatchFeedbackTriage(brief, root, {
      resolveEngine: () => ({ engine: { id: 'codex' } }),
      dispatch: async (jobs, options) => {
        engineCalls.push({ jobs, options });
        return [{ ...jobs[0], ok: true, stdout: 'it failed\nverdict: reproduced', stderr: '' }];
      },
    });

    assert.strictEqual(dispatched.engine, 'codex');
    assert.strictEqual(engineCalls[0].jobs[0].engine, 'codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
