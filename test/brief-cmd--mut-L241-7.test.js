'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nextMoves = require('../lib/next-moves');

test('brief moves preserve an owner and fall back to a member', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(nextMoves, 'nextMoves', (actualRoot, limit) => {
    assert.equal(actualRoot, root);
    assert.equal(limit, 3);
    return [
      { id: 'owner-only', title: 'Owned move', owner: 'alice' },
      { id: 'member-only', title: 'Member move', member: 'bob' },
      { id: 'both', title: 'Both assigned', owner: 'carol', member: 'dave' },
    ];
  });
  const { buildBriefData } = require('../commands/brief');

  const data = buildBriefData(root, { now: '2026-01-15T12:00:00Z' });

  assert.deepEqual(data.moves, [
    { id: 'owner-only', title: 'Owned move', why: 'workspace signal', source: null, owner: 'alice' },
    { id: 'member-only', title: 'Member move', why: 'workspace signal', source: null, owner: 'bob' },
    { id: 'both', title: 'Both assigned', why: 'workspace signal', source: null, owner: 'carol' },
  ]);
});
