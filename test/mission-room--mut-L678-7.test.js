'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom } = require('../lib/mission-room');

test('chat approval gate uses the decision options from the approval packet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-room-decision-options-'));
  try {
    const room = buildMissionRoom('Prepare an onboarding checklist', { root });

    assert.deepStrictEqual(room.approval_packet.decision_options, ['approve', 'revise', 'stop']);
    assert.strictEqual(
      room.chat_zone.approval_gate.decision_options,
      room.approval_packet.decision_options,
      'the chat gate must expose the packet decision options themselves'
    );

    room.approval_packet.decision_options.push('ask');
    assert.deepStrictEqual(room.chat_zone.approval_gate.decision_options, [
      'approve', 'revise', 'stop', 'ask',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
