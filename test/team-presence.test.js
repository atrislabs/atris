'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTeamPresence,
  renderTeamPresence,
} = require('../lib/team-presence');

const NOW = '2026-07-19T12:00:00.000Z';
const FIFTEEN_MINUTES = 15 * 60 * 1000;

test('empty fixture returns the exact empty team presence envelope', () => {
  const input = {
    now: NOW,
    freshnessWindowMs: FIFTEEN_MINUTES,
    stream: {
      active_agents: 0,
      active: [],
      waiting_operator: 0,
      landing_wait: 0,
    },
    streamEvents: [],
    missions: [],
    tasks: [],
  };

  const presence = buildTeamPresence(input);
  assert.deepEqual(presence, {
    schema: 'atris.team_presence.v1',
    generated_at: NOW,
    freshness_window_seconds: 900,
    totals: {
      awake: 0,
      waiting_operator: 0,
      landing_wait: 0,
    },
    operator: null,
    members: [],
  });
  assert.equal(JSON.stringify(buildTeamPresence(input)), JSON.stringify(presence));
  assert.equal(renderTeamPresence(presence), [
    'team presence: 0 awake',
    'freshness window: 15 minutes',
    'waiting on operator: 0',
    'landing wait: 0',
    'awake roster: empty',
  ].join('\n'));
});

test('populated fixtures join doing, loop badge, totals, and the awake window', () => {
  const presence = buildTeamPresence({
    now: NOW,
    freshnessWindowMs: FIFTEEN_MINUTES,
    stream: {
      active_agents: 3,
      active: [
        ['task-planner', 'building the team presence contract --json'],
        ['stale-member', 'waiting on old work'],
      ],
      waiting_operator: 2,
      landing_wait: 1,
    },
    streamEvents: [
      { agent: 'task-planner', ts: '2026-07-19T11:58:00.000Z', summary: 'joined the feeds' },
      { agent: 'stale-member', ts: '2026-07-19T11:40:00.000Z', summary: 'old activity' },
    ],
    missions: [
      {
        id: 'mission-team-presence-contract',
        name: 'web i can',
        owner: 'task-planner',
        status: 'running',
        cadence: 'manual',
        runner: 'claude',
        objective: 'show the awake team on the web',
        next_action: 'join the three feeds',
        last_tick_at: '2026-07-19T11:57:00.000Z',
        updated_at: '2026-07-19T11:57:00.000Z',
      },
      {
        id: 'mission-stale-loop',
        owner: 'stale-member',
        status: 'running',
        objective: 'old loop',
        last_tick_at: '2026-07-19T11:40:00.000Z',
      },
    ],
    tasks: [
      {
        id: 'CLI-1135',
        title: 'build the team presence contract',
        status: 'claimed',
        claimed_by: 'task-planner',
        updated_at: '2026-07-19T11:59:00.000Z',
      },
      {
        id: 'WEB-22',
        title: 'polishing the roster',
        status: 'doing',
        claimed_by: 'designer',
        updated_at: '2026-07-19T11:55:00.000Z',
      },
    ],
  });

  assert.deepEqual(presence, {
    schema: 'atris.team_presence.v1',
    generated_at: NOW,
    freshness_window_seconds: 900,
    totals: {
      awake: 2,
      waiting_operator: 2,
      landing_wait: 1,
    },
    operator: null,
    members: [
      {
        name: 'designer',
        awake: true,
        doing: 'polishing the roster.',
        loop: null,
        last_seen: '2026-07-19T11:55:00.000Z',
      },
      {
        name: 'task-planner',
        awake: true,
        doing: 'building the team presence contract.',
        loop: {
          mission: 'web i can',
          cadence: 'manual',
          runner: 'claude',
          last_tick: '2026-07-19T11:57:00.000Z',
        },
        last_seen: '2026-07-19T11:59:00.000Z',
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(presence), /stale-member|--json/);

  const text = renderTeamPresence(presence);
  assert.match(text, /task-planner: building the team presence contract\./);
  assert.match(text, /loop: web i can \[manual \| claude \| last tick 2026-07-19T11:57:00\.000Z\]/);
});

test('operator activity is shown separately and excluded from the awake member count', () => {
  const presence = buildTeamPresence({
    now: NOW,
    freshnessWindowMs: FIFTEEN_MINUTES,
    operator: 'keshavrao',
    stream: {},
    streamEvents: [],
    missions: [],
    tasks: [
      {
        id: 'CLI-984',
        title: 'review the customer handoff',
        status: 'claimed',
        claimed_by: 'keshavrao',
        updated_at: '2026-07-19T11:59:00.000Z',
      },
      {
        id: 'CLI-1260',
        title: 'repair the team dashboard',
        status: 'claimed',
        claimed_by: 'builder',
        updated_at: '2026-07-19T11:58:00.000Z',
      },
    ],
  });

  assert.equal(presence.totals.awake, 1);
  assert.deepEqual(presence.members.map((member) => member.name), ['builder']);
  assert.deepEqual(presence.operator, {
    name: 'keshavrao',
    awake: true,
    doing: 'review the customer handoff.',
    loop: null,
    last_seen: '2026-07-19T11:59:00.000Z',
  });

  const text = renderTeamPresence(presence);
  assert.match(text, /team presence: 1 awake/);
  assert.match(text, /operator:\n  keshavrao: review the customer handoff\./);
  assert.doesNotMatch(text, /awake roster:\n  keshavrao:/);
});
