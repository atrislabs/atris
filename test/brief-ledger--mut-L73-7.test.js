'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendBriefRecord } = require('../lib/brief-ledger');

test('a nonexistent worktree uses the fallback author even when its normalized path has an owner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-author-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.atris'));
  fs.writeFileSync(path.join(root, '.atris', 'agent-worktree.json'),
    JSON.stringify({ owner: 'sidecar-owner' }));

  // Keep the missing segment: path.join would remove it before the call.
  // The OS cannot traverse it, but joining the sidecar filename normalizes it.
  const worktree = `${root}${path.sep}missing${path.sep}..`;
  assert.equal(fs.existsSync(worktree), false);
  const record = appendBriefRecord(root, {
    brief_id: 'brief-author-guard',
    context: { worktree, base_ref: 'fixed-base' },
  }, { now: new Date('2020-01-02T03:04:05.000Z') });

  assert.equal(record.author, 'orb');
});
