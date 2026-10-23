'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildActivityStream } = require('../lib/activity-stream');

test('mission event titles prefer the summary over the objective', () => {
  const events = buildActivityStream({
    missionEvents: [{
      ts: '2020-01-02T03:04:05Z',
      type: 'progress',
      payload: {
        summary: 'Added the missing regression test',
        objective: 'Improve activity reporting',
      },
    }],
  });

  assert.deepEqual(events.map(event => event.title), [
    'Added the missing regression test',
  ]);
});
