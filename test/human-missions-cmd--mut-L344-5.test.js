'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { missionCard, renderMissionCard } = require('../commands/human-missions');

test('formats 60 elapsed seconds as 1m 0s rather than 60s', () => {
  const card = missionCard({ elapsed_s: 60 });
  const lines = renderMissionCard(card);
  const timeLine = lines.find((line) => line.startsWith('Time: '));
  assert.equal(timeLine, 'Time: 1m 0s');
});
