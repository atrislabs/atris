'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { triageFeedback } = require('../commands/feedback');

test('triage uses the explicitly requested workspace in its returned and printed brief', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-workspace-'));
  try {
    const output = [];
    const result = await triageFeedback('workspace-report', {
      workspace,
      token: 'local-test-token',
      fetchFeedbackItems: async () => [{
        id: 'workspace-report',
        message: 'Steps to reproduce:\n1. Open the requested workspace.',
      }],
      write: (text) => output.push(text),
    });

    assert.equal(result.brief.workspace, path.resolve(workspace));
    assert.deepEqual(output, [[
      'feedback triage workspace-report',
      `workspace: ${path.resolve(workspace)}`,
      'verify: npm test',
      '',
      'steps to reproduce:',
      '1. Open the requested workspace.',
      '',
      'verdict contract:',
      '- reproduced: the reported behavior occurs and the evidence names the failing step or check',
      '- already fixed on master: the reported behavior existed, but the same reproduction passes on origin/master',
      '- cannot reproduce: the exact reported steps and the verify command pass, with no master-only fix explaining the result',
    ].join('\n')]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
