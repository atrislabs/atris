'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planFeedbackTriage } = require('../lib/feedback-triage');

test('uses a verification command supplied directly on the feedback row', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-triage-command-'));
  const brief = planFeedbackTriage({
    id: 'feed-command',
    message: 'Steps to reproduce:\n1. Open the feedback list.',
    verify_command: 'node --test test/example.test.js',
  }, root);

  assert.equal(brief.verify_command, 'node --test test/example.test.js');
});
