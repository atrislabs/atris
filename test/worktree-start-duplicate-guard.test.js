const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collidingFlights,
  describeFlightAge,
  flightStampMs,
  parseAgentFlightName,
  taskTokens,
} = require('../commands/worktree');

test('flight names split into owner, task slug, and stamp', () => {
  const flight = parseAgentFlightName('codex/cursor-map-shrink-freshness-20260809-175253');
  assert.equal(flight.owner, 'cursor');
  assert.equal(flight.taskSlug, 'map-shrink-freshness');
  assert.equal(flight.stamp, '20260809-175253');
  assert.equal(flight.stampMs, Date.UTC(2026, 7, 9, 17, 52, 53));
  assert.deepEqual(flight.tokens, ['map', 'shrink', 'freshness']);
});

test('non-agent and malformed names are not flights', () => {
  assert.equal(parseAgentFlightName('master'), null);
  assert.equal(parseAgentFlightName('feature/map-rewrite-20260809-175253'), null);
  assert.equal(parseAgentFlightName('codex/cursor-map-rewrite'), null);
  assert.equal(parseAgentFlightName('codex/cursor-map-rewrite-20261399-175253'), null);
  // Owner but no task words left to compare.
  assert.equal(parseAgentFlightName('codex/cursor-20260809-175253'), null);
});

test('stamps parse as UTC and reject junk', () => {
  assert.equal(flightStampMs('20260101-000000'), Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(flightStampMs('2026-08-09'), null);
  assert.equal(flightStampMs(''), null);
});

test('stopwords drop out of task tokens', () => {
  assert.deepEqual(taskTokens('fix the atris cli map rewrite'), ['map', 'rewrite']);
  assert.deepEqual(taskTokens('Add a new task for the repo'), []);
  assert.deepEqual(taskTokens('billing-refund-bug'), ['billing', 'refund', 'bug']);
});

test('one shared task word is a collision, none is clear to fly', () => {
  const flights = [
    parseAgentFlightName('codex/cursor-map-shrink-freshness-20260809-175253'),
    parseAgentFlightName('codex/claude-billing-refund-bug-20260809-180000'),
  ];
  assert.deepEqual(
    collidingFlights(flights, taskTokens('map-rewrite')).map((f) => f.taskSlug),
    ['map-shrink-freshness']
  );
  assert.deepEqual(collidingFlights(flights, taskTokens('invoice-export')), []);
  // Every word was a stopword: nothing left to compare, so nothing collides.
  assert.deepEqual(collidingFlights(flights, taskTokens('fix the cli')), []);
});

test('age reads from the embedded stamp', () => {
  const flight = parseAgentFlightName('codex/cursor-map-rewrite-20260809-120000');
  assert.equal(describeFlightAge(flight, Date.UTC(2026, 7, 9, 12, 44, 0)), '44m old');
  assert.equal(describeFlightAge(flight, Date.UTC(2026, 7, 9, 15, 5, 0)), '3h5m old');
});
