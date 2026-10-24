'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addIdea, updateIdea, readIdeas } = require('../lib/idea-inbox');

test('moving a refused idea back to waiting clears its old refusal reason', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reason-transition-'));
  const now = new Date('2026-01-15T12:00:00Z');
  const idea = addIdea(root, 'make the inbox search faster', { now });
  updateIdea(root, idea.id, { status: 'refused', reason: 'the checks failed' }, { now });
  updateIdea(root, idea.id, { status: 'waiting' }, { now });
  assert.strictEqual(readIdeas(root)[0].reason, '');
});
