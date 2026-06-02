const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterCalendarEventsForSearch,
  formatCalendarSearchError,
  formatCalendarSearchResults,
  parseCalendarSearchArgs,
} = require('../commands/integrations');

test('calendar search parses query and bounded options', () => {
  assert.deepEqual(parseCalendarSearchArgs(['investor', 'call', '--days', '45', '--limit', '5', '--timeout-ms', '2500', '--json']), {
    query: 'investor call',
    days: 45,
    limit: 5,
    timeoutMs: 2500,
    json: true,
  });

  assert.deepEqual(parseCalendarSearchArgs(['demo', '--days', '999', '--limit', '999', '--timeout', '999999']), {
    query: 'demo',
    days: 365,
    limit: 100,
    timeoutMs: 60000,
    json: false,
  });
});

test('calendar search filters title, location, description, and attendees', () => {
  const events = [
    {
      id: 'evt-1',
      start: { dateTime: '2026-05-20T16:30:00-07:00' },
      summary: 'Investor call',
      location: 'Zoom',
      description: 'Series A prep',
      attendees: [{ email: 'maya@example.com', displayName: 'Maya' }],
    },
    {
      id: 'evt-2',
      start: { dateTime: '2026-05-21T12:00:00-07:00' },
      summary: 'Product review',
      location: 'Office',
      description: 'Atris desktop demo',
      attendees: ['jon@example.com'],
    },
  ];

  assert.deepEqual(filterCalendarEventsForSearch(events, 'investor call').map((event) => event.id), ['evt-1']);
  assert.deepEqual(filterCalendarEventsForSearch(events, 'desktop demo').map((event) => event.id), ['evt-2']);
  assert.deepEqual(filterCalendarEventsForSearch(events, 'maya').map((event) => event.id), ['evt-1']);
  assert.deepEqual(filterCalendarEventsForSearch(events, 'missing'), []);
});

test('calendar search json errors are machine-readable', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    formatCalendarSearchError('investor', 'Request timeout after 10s', { json: true, status: 0 });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(JSON.parse(lines.join('\n')), {
    ok: false,
    query: 'investor',
    status: 0,
    error: 'Request timeout after 10s',
    totalEvents: 0,
    matchCount: 0,
    matches: [],
  });
});

test('calendar search json can report cache fallback', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    formatCalendarSearchResults('investor', [
      { id: 'evt-1', summary: 'Investor call', start: '2026-05-20T16:30:00-07:00' },
    ], {
      json: true,
      total: 2,
      source: 'cache',
      liveOk: false,
      cacheUpdatedAt: '2026-05-20T12:00:00.000Z',
      error: 'Request timeout after 10s',
    });
  } finally {
    console.log = originalLog;
  }
  const parsed = JSON.parse(lines.join('\n'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.source, 'cache');
  assert.equal(parsed.liveOk, false);
  assert.equal(parsed.cacheUpdatedAt, '2026-05-20T12:00:00.000Z');
  assert.equal(parsed.error, 'Request timeout after 10s');
  assert.equal(parsed.totalEvents, 2);
  assert.equal(parsed.matchCount, 1);
  assert.equal(parsed.matches[0].summary, 'Investor call');
});
