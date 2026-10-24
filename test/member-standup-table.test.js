'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { memberStandupLines } = require('../commands/member');

const standup = [
  { member: 'builder', role: 'Builder', status: 'running', engine: 'claude', latest_update: 'shipped the board', next_push: 'the standup table' },
  { member: 'scout', role: 'Team Member', status: 'idle', engine: 'auto', latest_update: 'looked around', next_push: 'look again' },
];
// the team page's cells, as gm-bet teamCells gives them
const cells = new Map([
  ['builder', { role: 'ships features', ovr: '84', engine: 'claude opus 5.5', parked: false }],
  ['scout', { role: '··', ovr: '··', engine: '··', parked: false }],
]);

test('standup is the team table in a terminal: member, role, ovr, engine, status', () => {
  const text = memberStandupLines(standup, { bordered: true, width: 120, cells }).join('\n');
  assert.match(text, /^ {2}│ member +│ role +│ ovr +│ engine +│ status +│$/m);
  assert.match(text, /^ {2}│ builder +│ ships features +│ 84 +│ claude opus 5\.5 +│ running +│$/m);
  assert.match(text, /^ {2}│ scout +│ ·· +│ ·· +│ ·· +│ idle +│$/m);
  assert.match(text, /^ {2}┌─+┬/m);
  assert.match(text, /^ {4}found: shipped the board$/m);
  assert.match(text, /^ {4}push: {2}the standup table$/m);
  assert.doesNotMatch(text, /\+-{10}/);
});

test('standup box fits an 80 column terminal by wrapping the role', () => {
  const long = new Map([['builder', { role: 'keeps customer commitments visible, spots retention…', ovr: '84', engine: 'claude opus 5.5' }]]);
  const lines = memberStandupLines(standup.slice(0, 1), { bordered: true, width: 80, cells: long });
  const box = lines.filter(line => /^ {2}[┌│├└]/.test(line));
  assert.ok(box.length > 5, 'the long role wraps onto more lines');
  assert.ok(box.every(line => line.length <= 80), box.find(line => line.length > 80));
  assert.match(lines.join('\n'), /│ claude opus 5\.5 │/);
});

test('standup keeps the old boxes when the terminal is too narrow, output is piped, or no cells were read', () => {
  const narrow = memberStandupLines(standup, { bordered: true, width: 30, cells });
  const piped = memberStandupLines(standup, { bordered: false, width: 120, cells });
  const unread = memberStandupLines(standup, { bordered: true, width: 120 });
  for (const lines of [narrow, piped, unread]) {
    assert.equal(lines[1], '| 1. BUILDER (Builder) · running · engine:claude');
    assert.equal(lines[2], '|    Found:   shipped the board');
    assert.doesNotMatch(lines.join('\n'), /│/);
  }
});
