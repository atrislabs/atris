'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBriefData } = require('../commands/brief');

test('a review task exactly 48 hours old has its age expressed in days', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brief-age-'));
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{
        id: 'review-boundary',
        title: 'Review boundary',
        status: 'review',
        updated_at: '2026-07-03T12:00:00Z',
      }],
    }));

    const data = buildBriefData(root, { now: Date.parse('2026-07-05T12:00:00Z') });
    assert.deepEqual(data.waiting, [{
      id: 'review-boundary',
      title: 'Review boundary',
      why: 'review lane',
      age: '2d',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
