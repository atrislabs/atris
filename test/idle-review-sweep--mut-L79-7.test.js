'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { idleDecision } = require('../lib/idle-review-sweep');

test('tasks with approval status in review block are skipped as decided', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-t-')));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const now = 1760000000000;
    const task = {
      id: 'task-1',
      display_id: 'TSK-1',
      title: 'Review status in review block',
      status: 'review',
      tag: 'ui',
      created_at: now - 864000000,
      updated_at: now - 864000000,
      metadata: {
        built_by: 'builder',
        verify: 'curl https://example.com',
      },
      review: {
        approval_status: 'accepted',
      },
    };
    const decision = idleDecision(task, { root, policy: { accept_all: true, strict_verify: true }, now });
    assert.strictEqual(decision.action, 'skip');
  } finally {
    if (oldHome !== undefined) {
      process.env.HOME = oldHome;
    } else {
      delete process.env.HOME;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
