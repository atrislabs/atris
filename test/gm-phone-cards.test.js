'use strict';

// Typing, the team, the job deck and card recovery on the real phone page in Chrome.
const test = require('node:test');
const assert = require('node:assert/strict');
const trace = require('../scripts/gm-phone-trace');

const CHROME = trace.findChrome();

test('browser: the tapped spot becomes the field, holds as chosen, and the next title lands where the old one was', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.trace({ chromePath: CHROME });
  assert.equal(out.failed, null, JSON.stringify(out.stretches));
  const [typed, said, answered, idea] = out.stretches;
  const show = s => JSON.stringify(s);
  // one: "something else" turns into the field at the same size and spot, the
  // cursor already in it; the other answers dim and stay put
  assert.deepEqual(typed.field_vs_button_px, { moved: 0, resized: 0 }, show(typed));
  assert.equal(typed.cursor_in_field, true);
  assert.ok(typed.others_dimmed_to < 0.6, show(typed));
  // "or say something" does the same in its own spot, at the same height
  assert.deepEqual(said.field_vs_button_px, { center_moved: 0, height_change: 0 }, show(said));
  assert.equal(said.cursor_in_field, true);
  for (const s of [typed, said, answered, idea]) {
    // the typed words or the tapped answer hold in that spot, styled as
    // chosen, for a beat, and nothing else on the card moves
    assert.equal(s.held_as_chosen, true, show(s));
    assert.equal(s.held_moved_px, 0, show(s));
    assert.equal(s.others_moved_px, 0, show(s));
    assert.ok(s.hold_ms >= 120 && s.hold_ms <= 600, show(s));
    // then one motion: the card goes into the sphere and the next one comes out of it,
    // its title landing where the old title was, a few pixels of drift at most
    assert.equal(s.through_sphere, true, show(s));
    assert.ok(s.title_max_px <= 5, show(s));
    assert.equal(s.title_rest_px, 0, show(s));
    assert.ok(s.largest_frame_step_px <= 5, show(s));
    // tap to the next card fully in: about a second, step by step as the page
    // sets its motion, so a busy machine's late frames never count against it.
    // each step runs for real, at least about half of what it is set to today,
    // so a step cut to nothing fails even when the order and the total fit
    const floors = { hold: 120, glide: 130, beat: 50, spiral: 150, bloom: 70, fade: 150 };
    assert.deepEqual(s.motion.map(([step]) => step), Object.keys(floors), show(s));
    for (const [step, ms] of s.motion) assert.ok(ms >= floors[step], `${step} ${ms}ms: ${show(s)}`);
    assert.ok(s.motion_ms >= 900 && s.motion_ms <= 1250, show(s));
    // the clock is the motion plus the wait on the stub desk (its own speed,
    // left out) plus late timers and frames. it never beats the motion by
    // more than the one frame the spiral can start into. what a slow machine
    // adds stays within a dozen frames at its pace (about how many times the
    // motion waits on a timer or a frame), and never past twice the motion
    // whatever the frames, so a page that freezes fails. 16 times slower, the
    // machine added at most 1.7 seconds
    assert.ok(Number.isFinite(s.reveal_ms) && Number.isFinite(s.waited_ms), show(s));
    assert.ok(s.late_ms >= -s.slowest_frame_ms, show(s));
    // one stalled frame is the machine, not the page: it gets its own room on top
    const stall = Math.max(0, s.slowest_frame_ms - s.pace_frame_ms);
    assert.ok(s.late_ms <= Math.min(12 * s.pace_frame_ms + stall, 2 * s.motion_ms), show(s));
  }
  for (const s of [answered, idea]) assert.ok(s.others_dimmed_to < 0.6, show(s));
  // a reply instead of a card takes the title's spot; it only explains, so the
  // idea's own options are on it once, with the answers it adds and its box
  assert.equal(said.next_title, trace.REPLY);
  assert.deepEqual(said.reply.buttons, ['do it', 'sounds good', 'make it shorter', 'sharpen it', 'not now', 'or say something']);
});

test('browser: Esc cancels the typing, then steps back one card at a time, and does nothing on a card with no way back', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const { steps } = await trace.escapeTrace({ chromePath: CHROME });
  const show = JSON.stringify(steps, null, 1);
  const at = did => {
    const s = steps.find(x => x.did === did);
    assert.ok(s, `no step ${did}: ${show}`);
    const { did: _, under_orb: __, ...rest } = s;
    return rest;
  };
  const card = at('the card');
  assert.equal(card.kind, 'question', show);
  // on the first card Esc does nothing at all
  assert.deepEqual(at('esc on the card'), card, show);
  // the team is a card; a row opens the talk card; typing there
  assert.deepEqual([at('opened the team').kind, at('opened the team').title], ['team', 'the team'], show);
  const typing = at('typing to builder');
  assert.deepEqual([typing.kind, typing.typing, typing.words], ['member', true, 'take the readme first'], show);
  // Esc while typing: the words go and the cursor leaves; the talk card stays
  const cancelled = at('esc while typing');
  assert.deepEqual([cancelled.kind, cancelled.field_open, cancelled.typing], ['member', false, false], show);
  // the words sent ask for a second tap to start builder, on a card of their own
  assert.deepEqual(at('sent to builder').buttons.slice(0, 3), ['start it', 'keep it as a note instead', 'back'], show);
  // then one card back per press: the talk card, the team, the first card, and nothing more
  assert.equal(at('esc 1').kind, 'member', show);
  assert.equal(at('esc 2').kind, 'team', show);
  assert.deepEqual(at('esc 3'), card, show);
  assert.deepEqual(at('esc 4'), card, show);
});

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

test('browser: a long member name never takes over a phone: the held column stops short and the name breaks only at its hyphens', { skip: !CHROME && 'no chrome on this machine', timeout: 120000, concurrency: 2 }, async t => {
  const rows = [
    { member: 'customer-success-lead', role: 'answers customers', ovr: '··', engine: 'tool one m-one', status: 'idle', sentence: 'idle: no work in the last day' },
    { member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'working', sentence: 'working: the try page, about 4 hours left' },
    { member: 'auto-improver', role: 'continuous improver', ovr: 'new', engine: 'tool one m-one', status: 'idle', sentence: 'idle: no work in the last day' },
  ];
  await Promise.all([trace.SMALL_PHONE, trace.PHONE].map(viewport => t.test(`${viewport.width}x${viewport.height}`, async () => {
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
  })));
});

test('browser: a tap on an engine cell opens the swap card: the short list, more models on the same card, who it is for, and one tap swaps and brings the team back', { skip: !CHROME && 'no chrome on this machine', timeout: 120000, concurrency: 2 }, async t => {
  await Promise.all([trace.PHONE, trace.LAPTOP].map(viewport => t.test(`${viewport.width}x${viewport.height}`, async () => {
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
  })));
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

test('browser: after a lost answer, a tap on the old card does nothing and the page shows the card the Mac has, with one line why', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.staleAnswerTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  // the answer saved and the desk moved on, but the page never heard: the old card is back with a plain line
  assert.equal(out.after_lost.title, 'who uses the phone page most?', show);
  assert.equal(out.after_lost.line, 'that did not go through. try again.', show);
  // both taps name the card the owner saw
  assert.deepEqual(out.posts, [{ card: 'question:q1', option: 'a2' }, { card: 'question:q1', option: 'a2' }], show);
  // only the answer to the question on screen is saved; fewer mistakes never is
  assert.deepEqual(out.saved, [{ question: 'who uses the phone page most?', answer: 'small teams' }], show);
  // the second tap is refused, and the page lands on the card the Mac has, saying so
  assert.equal(out.at_end.title, 'what would make a small team pay?', show);
  assert.equal(out.at_end.line, 'that card changed, so nothing was done. here is the one on screen now.', show);
});

test('browser: say something that does not send comes back on its card with the words and the cursor in the box, and Enter tries again', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.unsentSayTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  const kept = { kind: 'idea', title: 'Write a getting started page for the phone', field_open: true, words: out.words, typing: true };
  const pick = l => ({ kind: l.kind, title: l.title, field_open: l.field_open, words: l.words, typing: l.typing });
  // the network is off: the card comes back, the words and the cursor in its box, and a line says so
  assert.deepEqual(pick(out.offline), kept, show);
  assert.equal(out.offline.line, 'that did not reach the mac. try again.', show);
  // Enter again reaches the desk, which could not pass it on: the same, with why
  assert.deepEqual(pick(out.refused), kept, show);
  assert.equal(out.refused.line, 'it did not reach them. try again in a minute.', show);
  // Enter once more goes through: the next card
  assert.equal(out.sent.title, 'Record a two minute demo video', show);
  // the desk got the same words twice
  assert.deepEqual(out.calls, [{ action: 'say', text: out.words }, { action: 'say', text: out.words }], show);
});

test('browser: words no model heard come back in their box on the card that says so, and Enter sends them again', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const runs = await trace.unheardKeepTrace({ chromePath: CHROME });
  const show = JSON.stringify(runs, null, 1);
  for (const r of runs) {
    // the reply says the model did not answer, and his words are in the box, ready to send
    assert.equal(r.unheard.title, 'the model did not answer this time, so nothing was saved. try again in a moment.', `${r.card}: ${show}`);
    assert.equal(r.unheard.field_open, true, `${r.card}: ${show}`);
    assert.equal(r.unheard.words, r.words, `${r.card}: ${show}`);
    // the card already says why: no second line under it
    assert.equal(r.unheard.line, null, `${r.card}: ${show}`);
    // one Enter sends the same words again, and the next card comes
    assert.deepEqual(r.calls.map(c => c.text), [r.words, r.words], `${r.card}: ${show}`);
    assert.equal(r.sent.title, 'Record a two minute demo video', `${r.card}: ${show}`);
  }
});
