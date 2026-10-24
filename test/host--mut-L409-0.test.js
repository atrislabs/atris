'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hostAction } = require('../lib/host');

test('resuming makes the next question due at the requested time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-resume-schedule-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const joined = '2026-01-01T12:00:00.000Z';
  const resumed = '2026-01-03T12:00:00.000Z';
  hostAction(root, 'join', { id: 'ada', name: 'Ada', now: joined });
  hostAction(root, 'pause', { id: 'ada', now: '2026-01-02T12:00:00.000Z' });
  hostAction(root, 'resume', { id: 'ada', now: resumed });
  const record = fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'people', 'ada.md'), 'utf8');
  const nextQuestion = JSON.parse(record.match(/^next_question_at: (.+)$/m)[1]);
  assert.equal(nextQuestion, resumed);
});
