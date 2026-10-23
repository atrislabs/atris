'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { memberStandupLines } = require('../commands/member');
const season = require('../lib/gm-season');

const standup = [
  { member: 'builder', role: 'Builder', status: 'running', engine: 'claude', latest_update: 'shipped the board', next_push: 'the standup table' },
  { member: 'scout', role: 'Team Member', status: 'idle', engine: 'auto', latest_update: 'looked around', next_push: 'look again' },
];
const profiles = { builder: { role: 'ships features', engine: 'claude opus 5.5' }, scout: { role: null, engine: null } };
const ratings = { builder: 84 };

test('standup is a bordered table of member, role, ovr, engine, status in a wide terminal', () => {
  const text = memberStandupLines(standup, { bordered: true, width: 120, profiles, ratings }).join('\n');
  assert.match(text, /^ {2}│ member +│ role +│ ovr +│ engine +│ status +│$/m);
  assert.match(text, /^ {2}│ builder +│ ships features +│ 84 +│ claude opus 5\.5 +│ running +│$/m);
  assert.match(text, /^ {2}│ scout +│ ·· +│ ·· +│ ·· +│ idle +│$/m);
  assert.match(text, /^ {2}┌─+┬/m);
  assert.match(text, /^ {4}found: shipped the board$/m);
  assert.match(text, /^ {4}push: {2}the standup table$/m);
  assert.doesNotMatch(text, /\+-{10}/);
});

test('standup keeps the old boxes when the terminal is too narrow or output is piped', () => {
  const narrow = memberStandupLines(standup, { bordered: true, width: 40, profiles, ratings });
  const piped = memberStandupLines(standup, { bordered: false, width: 120, profiles, ratings });
  for (const lines of [narrow, piped]) {
    assert.equal(lines[1], '| 1. BUILDER (Builder) · running · engine:claude');
    assert.equal(lines[2], '|    Found:   shipped the board');
    assert.doesNotMatch(lines.join('\n'), /│/);
  }
});

test('ratings are the board rating per member, null for rookies, missing for no plays', () => {
  const now = Date.now();
  const outcomes = [
    ...['landed', 'landed', 'landed', 'dropped'].map((kind, i) => ({ member: 'builder', kind, at: now - i * 1000 })),
    { member: 'scout', kind: 'landed', at: now },
  ];
  const rated = season.memberRatings(outcomes);
  assert.ok(rated instanceof Map);
  assert.equal(rated.get('builder').ovr, season.ovr(outcomes.slice(0, 4)));
  assert.equal(rated.get('scout').ovr, null);
  assert.equal(rated.has('ghost'), false);
});
