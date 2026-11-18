'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const trace = require('../scripts/gm-phone-trace');
const CHROME = trace.findChrome();

test('browser: the team table at phone and laptop size: five divided columns, nothing squashed, sideways scroll only on the phone, and a tap and Esc still work', { skip: !CHROME && 'no chrome on this machine', timeout: 120000, concurrency: 2 }, async t => {
  await Promise.all([trace.PHONE, trace.SMALL_PHONE, trace.LAPTOP].map(viewport => t.test(`${viewport.width}x${viewport.height}`, async () => {
    const out = await trace.teamTableTrace({ chromePath: CHROME, viewport });
    const at = out.viewport;
    const look = out.look;
    assert.ok(look, `${at}: the table shows`);
    assert.deepEqual(look.heads, ['member', 'role', 'ovr', 'engine', 'status'], at);
    // the headers the owner reads are ovr and engine, the same as the terminal's team tables
    assert.deepEqual(look.head_words, ['member', 'role', 'ovr', 'engine', 'status'], at);
    assert.equal(look.rows, 5, at);
    // a line between every pair of columns and every pair of rows
    assert.deepEqual([look.lines.missing_right, look.lines.missing_bottom], [0, 0], at);
    assert.deepEqual([look.lines.inner_right, look.lines.inner_bottom], [20, 20], at);
    // no words spill out of a cell, and names, ratings, and models stay on one line
    assert.deepEqual(look.spills, [], at);
    assert.deepEqual(look.wrapped, [], at);
    // the status column keeps its width on a laptop; on a phone it fills the room beside the held
    // names and no more, so swiped all the way none of it sits under them (before: 256px of 187 at 390)
    if (at === '1280x800') assert.ok(look.narrowest.status >= 250, `${at}: the status column keeps its width (${look.narrowest.status}px)`);
    else assert.ok(look.narrowest.status >= 110 && look.narrowest.status <= look.grid_width - 2 - look.narrowest.member + 1, `${at}: the status column is ${look.narrowest.status}px beside ${look.narrowest.member}px of names in a ${look.grid_width}px box`);
    assert.ok(look.narrowest.role >= 140, `${at}: the role column keeps its width (${look.narrowest.role}px)`);
    // the page itself never scrolls sideways; only the table box does, and only on the phone
    assert.equal(look.page_scrolls_sideways, false, at);
    assert.equal(look.scrolls_sideways, at !== '1280x800', at);
    assert.equal(look.name_column_moved_px, 0, `${at}: the name column stays put`);
    assert.equal(look.name_header_moved_px, 0, `${at}: its header stays over it`);
    // a model brought into view lands beside the held names, never under them (all five did at 320)
    assert.deepEqual(look.models_under_names, [], at);
    // the ovr header lines up with the ratings under it, on their right edge
    assert.ok(look.ovr_head_off_px <= 0.5, `${at}: the ovr header sits ${look.ovr_head_off_px}px off its ratings`);
    // on a phone the right edge fades while more of the table is off to the right, and not once scrolled there; a laptop has none
    const phone = at !== '1280x800';
    assert.deepEqual(look.fade, { at_rest: phone, at_end: false, back: phone }, at);
    // the footer never offers the page already open; back on the first card, the team link is there again
    assert.deepEqual([out.footer.team, out.footer.card], [[], ['the team']], at);
    assert.ok(look.smallest_font_px >= 17, at);
    assert.deepEqual(look.moving, [], `${at}: nothing on the table moves or glows`);
    assert.ok(look.statuses.every(t => t === t.toLowerCase()), at);
    // a tap on a row opens that member's talk card; Esc goes back to the team, then to the first card
    assert.deepEqual([out.talk.kind, out.talk.title, out.talk.table], ['member', 'builder', false], at);
    assert.deepEqual([out.back.kind, out.back.table], ['team', true], at);
    assert.equal(out.closed.kind, 'idea', at);
    // on a phone every move around the team pages is one turn in place, not the spiral;
    // on a laptop a move between a wide table card and a plain card still goes through the sphere
    const turn = at !== '1280x800';
    for (const m of [out.talk.moved, out.back.moved, out.closed.moved]) assert.equal(m.plan === 'hold 150, turn 420', turn, `${at}: ${m.plan}`);
    // the footer's team link from a talk card goes to the same place the same way
    assert.equal(out.footerTeam.kind, 'team', at);
    assert.equal(out.footerTeam.moved.plan === 'turn 420', turn, `${at}: ${out.footerTeam.moved.plan}`);
  })));
});

test('browser: a long member name never takes over a phone: the held column stops short and the name breaks only at its hyphens', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const rows = [
    { member: 'customer-success-lead', role: 'answers customers', ovr: '··', engine: 'tool one m-one', status: 'idle', sentence: 'idle: no work in the last day' },
    { member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'working', sentence: 'working: the try page, about 4 hours left' },
    { member: 'auto-improver', role: 'continuous improver', ovr: 'new', engine: 'tool one m-one', status: 'idle', sentence: 'idle: no work in the last day' },
  ];
  for (const viewport of [trace.SMALL_PHONE, trace.PHONE]) {
    const out = await trace.teamTableTrace({ chromePath: CHROME, viewport, rows });
    const at = out.viewport;
    const lines = out.look.name_lines;
    // the long name wraps (it held 222px of the box on one line), and only after a hyphen
    assert.ok(out.look.narrowest.member <= 185, `${at}: the held column is ${out.look.narrowest.member}px`);
    assert.ok(lines['customer-success-lead'].length > 1, `${at}: ${JSON.stringify(lines)}`);
    for (const line of lines['customer-success-lead'].slice(0, -1)) assert.match(line, /-$/, `${at}: ${JSON.stringify(lines)}`);
    // a name that fits stays on one line
    assert.deepEqual([lines.builder, lines['auto-improver']], [['builder'], ['auto-improver']], at);
    assert.equal(out.talk.kind, 'member', at);
  }
});

test('browser: a tap on an engine cell opens the swap card: the short list, more models on the same card, who it is for, and one tap swaps and brings the team back', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  for (const viewport of [trace.PHONE, trace.LAPTOP]) {
    const out = await trace.engineCardTrace({ chromePath: CHROME, viewport });
    const at = out.viewport;
    // the list as the roster gives it: the Atris model, the pick, more models, who it is for, and the way back
    assert.deepEqual(out.short.buttons, ['atris fastatris', 'm-onenow', 'more models', 'only builder', 'everyone doing builder\'s kind of work', 'back to the team'], at);
    // more models: a new card with every model, and each model keeps its own option id
    assert.notEqual(out.full.card, out.id, at);
    assert.deepEqual(out.full.buttons.slice(0, 3), ['atris fastatris', 'm-onenow', 'm-twotool two, 2 of 2 finished this week'], at);
    assert.deepEqual(out.full.options.slice(0, 2), out.short.options.slice(0, 2), at);
    // the models already shown stay exactly where they were; the new ones come in under them
    assert.ok(out.kept_moved_px <= 0.5, `${at}: shown models moved ${out.kept_moved_px}px`);
    // who the swap is for: the one set now reads in full color over an amber line, the other stays quiet, and a tap moves it
    for (const [now, set, other] of [[out.scopes.short, 'scope:member', 'scope:job'], [out.scopes.scoped, 'scope:job', 'scope:member']]) {
      assert.deepEqual([now[set].chosen, now[set].line, now[other].chosen], [true, 'rgb(255, 140, 66)', false], `${at}: ${JSON.stringify(now)}`);
      assert.notEqual(now[set].color, now[other].color, at);
      assert.notEqual(now[other].line, 'rgb(255, 140, 66)', at);
    }
    assert.ok(!out.full.options.includes('more'), at);
    // one tap, no yes card: the swap goes to the desk with who it is for, and the team comes back with one line
    assert.deepEqual(out.swaps, [{ member: 'builder', engine: 'two', model: 'm-two', scope: 'job' }], at);
    assert.deepEqual([out.after.kind, out.after.said], ['team', 'builder now runs on two m-two.'], at);
    assert.equal(out.engine, 'two m-two', at);
    // on a phone the swap card opens, and the team comes back after a swap, in one turn in place
    if (at === '390x844') assert.deepEqual([out.opened.plan, out.swapped.plan], ['hold 150, turn 420', 'hold 150, turn 420'], at);
    // the line about the swap is the first thing under the title, above the table, on screen, and said once
    assert.deepEqual([out.news.under_title, out.news.above_table, out.news.bottom <= out.news.screen], [true, true, true], `${at}: ${JSON.stringify(out.news)}`);
    assert.ok(!/\bline\b/.test(out.swapped.plan), `${at}: no line under the orb first (${out.swapped.plan})`);
  }
});

test('browser: the job deck flips one card at a time in the same spot, a yes sends what its card binds, and Esc goes back to the whole team', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const out = await trace.deckTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.first.kind, out.first.title], ['deck', 'navigator wants to publish the pricing page'], show);
  // previous and next sit at the top beside the count, the answers and the way back below
  assert.deepEqual(out.first.buttons, ['previous', 'next', 'yes', 'no', 'not now', 'back to the team', 'talk to navigator'], show);
  assert.deepEqual(out.counts, ['job 2 of 3', 'job 3 of 3', 'job 1 of 3', 'job 3 of 3'], show);
  // on every card, with or without a yes, previous and next are in the same spot, so a thumb never chases them
  for (const at of out.pager) assert.deepEqual(at, out.pager[0], `previous and next stay put: ${JSON.stringify(out.pager)}`);
  assert.equal(out.pager[0][0].y, out.pager[0][1].y, 'previous and next share one line');
  // on a phone the job's one row stacks, one line per column: nothing scrolls sideways and every value is in view
  assert.equal(out.row.scrolls_sideways, false, show);
  assert.deepEqual(out.row.cells.map(c => c.col), ['work', 'member', 'role', 'status'], show);
  assert.ok(out.row.cells.every(c => c.inside && !c.spills), show);
  // a job that needs the owner says so in amber in its row too, as on the team page and above the title
  assert.equal(out.row.cells.find(c => c.col === 'status').color, 'rgb(255, 140, 66)', show);
  // on the deck the footer offers the team, not the deck again
  assert.deepEqual(out.footer, ['the team'], show);
  assert.ok(out.moved_px <= 1, `the card stays in one spot (${out.moved_px}px)`);
  assert.equal(out.ghost_seen, true, 'a flip is the turn in place');
  assert.equal(out.swiped, 'job 1 of 3', 'a sideways swipe flips');
  assert.equal(out.scrolled, 'job 1 of 3', 'an up and down swipe does not flip');
  assert.equal(out.typing_arrow, 'job 1 of 3', 'the arrows type while the box has the cursor');
  // one tap arms only this card's yes; a flip draws a fresh card, so nothing is left armed
  const yesOf = buttons => buttons.find(t => t === 'yes' || t === 'tap again to say yes');
  assert.equal(yesOf(out.armed_a), 'tap again to say yes', show);
  assert.equal(yesOf(out.fresh_b), 'yes', show);
  assert.equal(yesOf(out.fresh_a), 'yes', show);
  // the yes sends the job and the hash its card binds, once
  assert.deepEqual(out.yes_sent, [{ job: 'm-nav', key: 'm-nav:step-2:abc', hash: 'abc' }], show);
  assert.equal(out.yes_line, 'told navigator yes.');
  assert.deepEqual(out.moving, []);
  assert.equal(out.back.kind, 'team', show);
});

test('browser: the team opened from the big orb closes back to the big orb, and opened from a card closes back to the card', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.teamFromHomeTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.team.kind, out.team.title], ['team', 'the team'], show);
  // Esc on the team: the big orb, where the owner was, and nothing is asked of the Mac yet
  assert.deepEqual([out.closed.has_card, out.closed.line, out.closed.asked], [false, 'tap to think', 0], show);
  // the big orb brings the next card as it always does
  assert.deepEqual([out.tapped.has_card, out.tapped.asked], [true, 1], show);
  // opened from a card, Esc goes back to a card
  assert.deepEqual([out.fromCard.has_card, out.fromCard.kind], [true, 'idea'], show);
  // from the big orb, to a talk card and back through the footer: Esc still goes to the big orb
  assert.deepEqual([out.viaTalk.has_card, out.viaTalk.line], [false, 'tap to think'], show);
});

test('browser: the team closed over the calm line goes back into it the way the orb does: the dots, a note that folds in and clears, and the idea out of the dots on its own, with and without motion', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  for (const reduced of [false, true]) {
    const out = await trace.teamOverWaitTrace({ chromePath: CHROME, reduced });
    const show = JSON.stringify(out, null, 1);
    // back on the calm line: its sphere and its open box, not a plain card
    assert.deepEqual([out.back.kind, out.back.waiting, out.back.sphere, out.back.box_open], ['wait', true, true, true], show);
    // a note sent there folds in, and its box clears
    assert.deepEqual([out.noted.words, out.noted.notes], ['', ['make it about schools', "got it, i'll fold that in."]], show);
    // once the idea is ready it shows on its own
    assert.deepEqual([out.landed.kind, out.landed.title], ['idea', trace.CARDS.b1.title], show);
  }
});

test('browser: a swap whose answer was lost: the next tap draws the team the Mac has at once, with one line why, and never posts the old swap card again', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.swapLostTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  // the answer never came: the swap card stays, with a line why
  assert.deepEqual([out.lost.kind, out.lost.line], ['swap', 'that did not go through. try again.'], show);
  // the next tap is refused with the team the desk has, and that team is drawn right away, with the swap on it and the line why
  assert.deepEqual([out.after.kind, out.after.said, out.after.line], ['team', 'builder now runs on two m-two.', 'that card changed, so nothing was done. here is the one on screen now.'], show);
  assert.ok(out.after.ms < 2000, `the team came at once, not on the page's next look (${out.after.ms}ms)`);
  // the old swap card is posted once on the retry, and never again
  assert.equal(out.posts.filter(x => /^swap~/.test(x.card)).length, 2, show);
});
