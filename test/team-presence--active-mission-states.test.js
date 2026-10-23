'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ACTIVE_MISSION_STATES,
  buildTeamPresence,
} = require('../lib/team-presence');

const NOW_MS = Date.parse('2026-10-23T12:00:00.000Z');
const RECENT = '2026-10-23T11:55:00.000Z';

test('ACTIVE_MISSION_STATES holds exactly the four states a live mission can be in', () => {
  assert.ok(ACTIVE_MISSION_STATES instanceof Set);
  assert.deepStrictEqual([...ACTIVE_MISSION_STATES].sort(), ['active', 'planning', 'ready', 'running']);
});

test('ACTIVE_MISSION_STATES rejects finished, paused, empty, and differently cased states', () => {
  assert.strictEqual(ACTIVE_MISSION_STATES.has('running'), true);
  assert.strictEqual(ACTIVE_MISSION_STATES.has('done'), false);
  assert.strictEqual(ACTIVE_MISSION_STATES.has('paused'), false);
  assert.strictEqual(ACTIVE_MISSION_STATES.has(''), false);
  // The set holds lowercase only; buildTeamPresence lowercases before it looks.
  assert.strictEqual(ACTIVE_MISSION_STATES.has('Running'), false);
});

test('buildTeamPresence counts a mission owner as awake only when the mission status is active', () => {
  const presence = buildTeamPresence({
    nowMs: NOW_MS,
    missions: [
      { id: 'mission-a', owner: 'ada', status: 'ready', updated_at: RECENT },
      { id: 'mission-b', owner: 'ben', status: 'done', updated_at: RECENT },
      { id: 'mission-c', owner: 'dee', status: 'Running', updated_at: RECENT },
      { id: 'mission-d', owner: 'cy', updated_at: RECENT },
    ],
  });

  assert.deepStrictEqual(presence.members.map((member) => member.name), ['ada', 'dee']);
  assert.strictEqual(presence.totals.awake, 2);
});
