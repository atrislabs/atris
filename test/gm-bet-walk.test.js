'use strict';

const { everyCard } = require('./helpers/gm-bet-fixtures');

const test = require('node:test');
const assert = require('node:assert/strict');

const gmCard = require('../lib/gm-card');

const walk = require('../scripts/gm-phone-trace');
const WALK_CHROME = walk.findChrome();

test('browser: every kind of card, one after another, as the desk served it: the page draws exactly that card\'s options and its box, and nothing from the card before', { skip: !WALK_CHROME && 'no chrome on this machine', timeout: 240000 }, async () => {
  const ids = new Set();
  const cards = (await everyCard()).map(c => c.card).filter(c => !ids.has(c.id) && ids.add(c.id));
  const seen = await walk.walkTrace({ chromePath: WALK_CHROME, cards });
  const show = JSON.stringify(seen, null, 1);
  assert.equal(seen.length, cards.length, show);
  for (const s of seen) {
    assert.deepEqual(s.shown.options, s.want.options, `${s.kind}: ${show}`);
    assert.equal(s.shown.box, s.want.box, `${s.kind}: ${show}`);
    assert.equal(s.shown.title, s.want.title, `${s.kind}: ${show}`);
  }
  for (const k of gmCard.KINDS) assert.ok(seen.some(s => s.kind === k), `the walk never showed a ${k} card`);
});
