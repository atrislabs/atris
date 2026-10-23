'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planFeedbackTriage, dispatchFeedbackTriage } = require('../lib/feedback-triage');

test('a failed dispatch cannot turn a partial verdict into a successful triage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-failed-dispatch-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const brief = planFeedbackTriage({
      id: 'feedback-failed-dispatch',
      message: 'Resolved feedback remains visible after refreshing the open queue.',
      context: { verify_command: 'node --test test/example.test.js' },
    }, root);
    await assert.rejects(dispatchFeedbackTriage(brief, root, {
      resolveEngine: () => ({ engine: { id: 'codex' } }),
      dispatch: async (jobs) => [{
        ...jobs[0],
        ok: false,
        stdout: 'The queue still shows the resolved item.\nverdict: reproduced',
        stderr: 'connection interrupted',
      }],
    }), /connection interrupted/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
