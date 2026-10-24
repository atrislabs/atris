'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMemberActivity } = require('../lib/team-presence');

test('a member whose only log is two weeks old is idle', () => {
  const [member] = buildMemberActivity({
    nowMs: new Date(2026, 8, 30, 12).getTime(),
    members: ['scout'],
    logDays: { scout: ['2026-09-16'] },
  });

  assert.equal(member.status, 'idle');
});
