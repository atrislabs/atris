'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom } = require('../lib/mission-room');

test('result landing preserves every timeline preview item in both execution modes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-room-landing-'));
  try {
    for (const trustedRun of [false, true]) {
      const input = 'Prepare a customer onboarding guide';
      const room = buildMissionRoom(input, { root, owner: 'builder', trustedRun });
      assert.deepStrictEqual(room.result.landing.timeline_preview, [
        {
          order: 1,
          title: 'Messy ask captured',
          did: `Turned "${input}" into ${room.name}.`,
          meant: 'The room starts from the operator truth, not a generic task template.',
        },
        {
          order: 2,
          title: 'Goal set',
          did: room.goal_chain.first_goal,
          meant: 'Atris runs one bounded goal before proposing another.',
        },
        {
          order: 3,
          title: 'Goal done',
          did: 'Build the smallest artifact or change, then attach a receipt.',
          meant: 'The operator reviews visible proof instead of internal run noise.',
        },
        {
          order: 4,
          title: 'Next goal set',
          did: 'Route the next proof step to builder only after approval or proof.',
          meant: 'The loop can continue without hiding priority or taste decisions.',
        },
        {
          order: 5,
          title: 'Mission accomplished',
          did: 'Stop when the proof is strong enough to accept, revise, or ship.',
          meant: 'The final handoff is a short story plus links to inspectable proof.',
        },
      ], `timeline survives in ${trustedRun ? 'trusted' : 'approval-gated'} mode`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
