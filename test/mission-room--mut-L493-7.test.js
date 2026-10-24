'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom } = require('../lib/mission-room');

test('mission room context preserves the proposed member from owner resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-room-proposed-member-'));
  try {
    const room = buildMissionRoom('Improve customer onboarding', {
      root,
      owner: 'architect',
      ownerResolution: {
        owner: 'architect',
        reason: 'engine_owner_resolved_to_factory_owner',
        requested_owner: 'codex',
        executed_by: 'codex',
        proposed_member: 'feature-owner',
      },
    });

    assert.strictEqual(room.context.proposed_member, 'feature-owner');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
