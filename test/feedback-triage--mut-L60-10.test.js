'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planFeedbackTriage } = require('../lib/feedback-triage');

test('keeps the first reproduction step when the report starts with its heading', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-step-offset-'));
  try {
    const brief = planFeedbackTriage({
      id: 'report-first-step',
      message: 'Steps to reproduce:\n1. Open the feedback view.\n2. Resolve a report.',
      context: { verify_command: 'node --test' },
    }, root);

    assert.strictEqual(brief.steps_to_reproduce[0], 'Open the feedback view.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
