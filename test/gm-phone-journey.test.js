'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trace = require('../scripts/gm-phone-trace');
const CHROME = trace.findChrome();

// ---- the small orb on a card goes back to the big one ------------------------------

test('browser: the same words to two members are two sends, and each member hears them', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.twoMembersTrace({ chromePath: CHROME });
  assert.deepEqual(out.took, [{ member: 'builder', text: 'pause this' }, { member: 'launcher', text: 'pause this' }], JSON.stringify(out));
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

test('browser: the small orb on any card goes back to the big dotted orb; the big one brings the next, and an idea that landed meanwhile waits for that tap', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const runs = await trace.orbHomeTrace({ chromePath: CHROME });
  const show = JSON.stringify(runs, null, 1);
  const [idea, calm, yes] = runs;
  assert.equal(runs.length, 3, show);
  for (const r of runs) {
    // the card goes, the big orb is back with its line, and nothing new was asked for
    assert.deepEqual(r.home, { has_card: false, big_orb: true, line: 'tap to think', title: null, asked: 0 }, show);
  }
  // from an idea and from a yes card: the big orb's tap asks for the next card, the same as on page open
  for (const r of [idea, yes]) assert.deepEqual([r.tapped.has_card, r.tapped.title, r.tapped.asked], [true, 'Record a two minute demo video', 1], show);
  // from the calm line: the idea that landed waits on the big orb, then the tap brings that idea, not one past it
  assert.deepEqual([calm.stayed.has_card, calm.stayed.asked], [false, 0], show);
  assert.deepEqual([calm.tapped.has_card, calm.tapped.title, calm.tapped.asked], [true, 'Write a getting started page for the phone', 1], show);
});

// ---- typing on the calm line: the idea waits for the owner -------------------------

test('browser: on the calm line the owner types, the idea lands and waits; words sent there are a note, and the idea that comes in is the one written with it; a cleared box lets the waiting idea in', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const gmBet = require('../lib/gm-bet');
  const idea = (title) => ({
    title,
    why_now: 'installs last week were 1,400 and the phone page just went live, so new installs have nothing to try first.',
    expect: '300 more npm installs in the week before nov 1',
    target: { metric: 'installs', baseline: 1400, goal: 1700 },
    check_in_days: 9, metric_source: 'npm installs for atris', verify: 'test -s docs/gm-phone.md', cost: 'about 4 hours of agent time, $0',
    steps: [{ text: 'draft the getting started page', who: 'team', member: 'builder', public: false }],
  });
  const IDEA = idea('write a getting started page for atris gm phone with a 30 second screen recording');
  const NOTED = idea('write a getting started page for schools that try atris gm phone in class');
  const WORDS = 'make it about schools';
  const FOLDED = 'got it, i\'ll fold that in.';
  const runs = [];
  for (const end of ['send', 'clear']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
    const writing = [];
    const said = [];
    const desk = gmBet.createBetDesk({
      workspaceRoot: root, ledgerFile: path.join(root, 'gm-bets.jsonl'), log: () => {}, warmOnCreate: false, choices: false,
      readTeam: () => [{ name: 'builder' }], readMissions: () => ({}), readHandoffs: () => [],
      // like the real writer, a drafting the desk stops ends at once
      generate: o => new Promise((resolve) => { const w = { o, resolve, stopped: false }; writing.push(w); if (o.signal) o.signal.addEventListener('abort', () => { w.stopped = true; resolve({ ok: false, stopped: true }); }); }),
      generateQuestion: () => new Promise(() => {}),
      readSaid: async (p) => { said.push(p); return { ok: true, kind: 'instruction', reply: '' }; },
      runCli: async () => ({ code: 0, stdout: '{}' }),
    });
    // the one generic question is answered, so a tap with nothing ready is the calm line
    desk.next();
    desk.answer({ choice: 'money' });
    assert.equal(desk.next().kind, 'wait');
    // the drafting that began before the answer stopped, and a fresh one knows it
    await new Promise(r => setImmediate(r));
    assert.equal(writing.length, 2);
    runs.push(await trace.onPhone(desk, CHROME, async (p) => {
      const look = () => p.run("(function () { var i = document.querySelector('#bet .field input'); return { title: document.querySelector('#bet h1').textContent, words: i ? i.value : null, notes: Array.prototype.map.call(document.querySelectorAll('#bet .waitnotes .turn'), function (n) { return n.textContent; }), dots: document.getElementById('orb').__orb.frame }; })()");
      const calm = await look();
      // the box is open already; a tap puts the cursor in it
      await p.tap('#bet .sayline .field input');
      await new Promise(r => setTimeout(r, 250));
      await p.type(WORDS);
      // the idea is written while the owner types
      writing[writing.length - 1].resolve({ ok: true, bet: IDEA });
      await new Promise(r => setTimeout(r, 3500));
      const typing = await look();
      const out = { end, calm, typing };
      if (end === 'send') {
        await p.enter();
        await p.until(`Array.prototype.some.call(document.querySelectorAll('#bet .waitnotes .turn'), function (n) { return n.textContent === ${JSON.stringify(FOLDED)}; })`, 'the note folded in', 6000);
        await new Promise(r => setTimeout(r, 300));
        out.folded = await look();
        // the drafting no one asked for is stopped for the note, and one with the note starts;
        // the idea that landed before it waits behind the calm line
        const noted = () => writing.find(w => !w.stopped && w.o.ownerNote);
        for (let i = 0; i < 100 && !noted(); i += 1) await new Promise(r => setTimeout(r, 20));
        out.stopped = writing.filter(w => w.stopped).length;
        await new Promise(r => setTimeout(r, 3200));
        out.held = await look();
        // the idea written with the note is the one that comes in
        out.note = noted().o.ownerNote;
        noted().resolve({ ok: true, bet: NOTED });
      } else await p.run("(function () { var i = document.querySelector('#bet .field input'); if (i) { i.value = ''; i.blur(); } })()");
      await p.until(`document.querySelector('#bet h1').textContent === ${JSON.stringify(end === 'send' ? NOTED.title : IDEA.title)}`, 'the idea', 9000).catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      return { ...out, after: await look(), said: said.length };
    }));
  }
  const show = JSON.stringify(runs, null, 1);
  for (const r of runs) {
    assert.equal(r.calm.title, 'writing your next idea.', show);
    assert.equal(r.calm.words, '', 'the calm line opens with its box open');
    // the idea landed while the owner typed: the words and the calm line stay
    assert.deepEqual([r.typing.title, r.typing.words], ['writing your next idea.', WORDS], show);
    assert.ok(r.typing.dots - r.calm.dots > 60, `the dots kept moving the whole time: ${show}`);
  }
  const [sent, cleared] = runs;
  // sent: a note, read by no model; the box is open again and empty, the card says it is folded in
  assert.deepEqual([sent.folded.title, sent.folded.words, sent.folded.notes], ['writing your next idea.', '', [WORDS, FOLDED]], show);
  assert.equal(sent.said, 0, show);
  // the drafting no one asked for stopped for it; the idea written without it waits,
  // and the one written with it comes in
  assert.ok(sent.stopped >= 2, show);
  assert.equal(sent.held.title, 'writing your next idea.', show);
  assert.equal(sent.note, WORDS, show);
  assert.equal(sent.after.title, NOTED.title, show);
  // cleared and left: the idea that landed comes in
  assert.equal(cleared.after.title, IDEA.title, show);
});

// ---- the wait, frame by frame: no frozen moment and no jump ------------------------------

test('browser: after a typed answer the dots never stop: got it, the calm line with its box open, a note folded in, and the idea grows out of the dots, with no frozen moment and no jump', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const r = await trace.waitTrace({ chromePath: CHROME });
  const show = JSON.stringify(r, null, 1);
  assert.equal(r.reached_idea, true, show);
  // the only still moment is the beat the chosen answer holds; while the owner waits, never
  assert.ok(r.longest_still_ms <= 250, show);
  assert.ok(r.longest_still_waiting_ms <= 150, show);
  // the dots move through the wait: 200 frames at 60fps, as time, so a slower machine reads the same
  assert.ok(r.dots_moving_ms > 200 * 16.7, show);
  // the got it line under the moving sphere, then the calm line's live words, its open box, the note
  assert.ok(r.lines.includes('got it: paying schools.'), show);
  assert.equal(r.calm_box_open, true, show);
  assert.ok(r.calm_steps.length >= 2 && r.calm_steps.every(x => trace.CALM_LINES.includes(x)), show);
  assert.deepEqual(r.calm_notes, ['make it about schools', 'got it, i\'ll fold that in.'], show);
  // the note is a post on the calm line's own id, and the idea comes when asked for from it
  assert.deepEqual(r.posts.map(x => [x.action, x.card]), [['say', 'question:focus'], ['say', 'wait:7'], ['orb', 'wait:7']], show);
  // no jump: nothing leaps in a frame or changes speed in one (per 60fps frame, css pixels,
  // read on the clock each part moves by, so a slower machine reads the same)
  assert.ok(r.lava_max_step_px <= 45, show);
  assert.ok(r.lava_max_size_step_px <= 45, show);
  assert.ok(r.lava_max_speed_change_px <= 15, show);
  assert.ok(r.sphere_max_step_px <= 10, show);
  assert.ok(r.dots_max_speed_change_px <= 10, show);
  assert.ok(r.title_max_step_px <= 5, show);
  assert.equal(r.footer_seen_jump_px, 0, show);
  // the idea is born where the dots were
  assert.ok(r.bloom_from_dots_px <= 3, show);
});

test('browser: the calm line fits every screen: its box is inside the edges with send whole, and its words are centered under the sphere with the team, at 390, 430, and laptop width', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const runs = await trace.calmLayoutTrace({ chromePath: CHROME });
  const show = JSON.stringify(runs, null, 1);
  assert.deepEqual(runs.map(r => r.viewport), ['390x844', '430x932', '1280x800']);
  for (const r of runs) {
    // nothing runs off the side, and the page never scrolls sideways
    assert.equal(r.scroll_w, r.vw, show);
    assert.ok(r.field.left >= 16 && r.field.right <= r.vw - 16, show);
    assert.ok(r.send.right <= r.field.right && r.send.left >= r.field.left, show);
    // the card lines up with every other card: the same column, centered
    assert.ok(Math.abs((r.card.left + r.card.right) / 2 - r.vw / 2) <= 1, show);
    assert.ok(Math.abs(r.title.mid - r.team.mid) <= 4, show);
    assert.ok(Math.abs(r.title.mid - r.vw / 2) <= 4, show);
    // the box sits above the footer
    assert.ok(r.field.bottom < r.foot.top, show);
  }
});

test('browser: under reduced motion the same wait has no swarm and no travel, only plain fades, and the calm line still takes a note',{ skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const r = await trace.waitTrace({ chromePath: CHROME, reduced: true });
  const show = JSON.stringify(r, null, 1);
  assert.equal(r.reached_idea, true, show);
  // the dots are drawn when the sphere changes, and hold: a redraw or two, never a swarm
  assert.ok(r.orb_frames_drawn <= 6, show);
  assert.ok(r.dot_frames <= 2, show);
  // nothing travels: not the lava, not the sphere, not the footer
  assert.deepEqual([r.lava_max_step_px, r.sphere_max_step_px, r.footer_seen_jump_px], [0, 0, 0], show);
  // every card change is a fade
  assert.ok(r.fading_frames >= 6, show);
  assert.equal(r.calm_box_open, true, show);
  assert.deepEqual(r.calm_notes, ['make it about schools', 'got it, i\'ll fold that in.'], show);
});

// ---- the card is the conversation -------------------------------------------------

test('browser: a two-turn chat on the number question: one place to type, the turns kept, the choices once, the sphere while it is read, a long reply at body size, and the owner is you', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const LONG = "I'm asking which number would tell you the overnight work is going well. Pick one of the four buttons, or tell me another number you'd watch.";
  const seen = [];
  const desk = gmBet.createBetDesk({
    workspaceRoot: root, ledgerFile: path.join(root, 'gm-bets.jsonl'), log: () => {}, warmOnCreate: false, choices: false, scoreboard: true, ownerName: 'Keshav',
    generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}),
    suggestScoreboard: async () => ({ ok: true, choices: [{ name: 'weekly installs', up: true }, { name: 'first runs that finished a recap', up: true }, { name: 'overnight changes Keshav redid', up: false }] }),
    // a slow reader that, like the live one, offers the card's own choices back
    readSaid: async (opts) => {
      seen.push(opts.thread.map(t => t.text));
      await new Promise(r => setTimeout(r, 1500));
      return { ok: true, kind: 'question', reply: LONG, suggestions: ['weekly installs', 'first runs that finished a recap', 'overnight changes you redid', 'paying schools'] };
    },
    runCli: async () => ({ code: 0, stdout: '{}' }),
  });
  desk.warm();
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(desk.next().id, 'question:scoreboard');
  const out = await trace.onPhone(desk, CHROME, async (p) => {
    const look = () => p.run(`(function () {
      var box = document.getElementById('bet'), h = box.querySelector('h1');
      return {
        has_card: document.body.classList.contains('has-card') && !box.hidden,
        title: h.textContent, title_top: Math.round(h.getBoundingClientRect().top), title_px: getComputedStyle(h).fontSize,
        buttons: Array.prototype.map.call(box.querySelectorAll('button'), function (b) { return b.textContent; }),
        // something else (or the box it becomes while it is read), or the say line
        places_to_type: box.querySelectorAll('.other, .act .field, .sayline').length,
        ellipses: (box.innerText.match(/\\u2026/g) || []).length,
      };
    })()`);
    const chat = async (words) => {
      await p.run("Array.prototype.find.call(document.querySelectorAll('#bet button'), function (b) { return b.textContent === 'something else'; }).click()");
      await new Promise(r => setTimeout(r, 300));
      await p.type(words);
      await p.enter();
      await new Promise(r => setTimeout(r, 700));
      const loading = await look();
      await p.until(`document.querySelector('#bet h1').textContent === ${JSON.stringify(LONG)} && !document.body.hasAttribute('data-busy') && document.body.classList.contains('has-card')`, 'the reply', 8000);
      await new Promise(r => setTimeout(r, 300));
      return { loading, reply: await look() };
    };
    const before = await look();
    const one = await chat('what');
    const two = await chat('which one is best?');
    return { before, one, two, why_px: await p.run("(function () { var n = document.createElement('p'); n.className = 'why'; document.getElementById('bet').appendChild(n); var px = getComputedStyle(n).fontSize; n.remove(); return px; })()") };
  });
  const show = JSON.stringify({ out, seen }, null, 1);
  // the owner is you, in the choices and everywhere on the card
  assert.ok(out.before.buttons.includes('overnight changes you redid'), show);
  for (const state of [out.before, out.one.reply, out.two.reply]) {
    assert.ok(!state.buttons.some(b => /keshav/i.test(b)), show);
    // one place to type, always: something else on a question card
    assert.equal(state.places_to_type, 1, show);
  }
  for (const turn of [out.one, out.two]) {
    // while the reply is read the card has gone into the sphere: no ellipsis, no thinking words
    assert.equal(turn.loading.has_card, false, show);
    assert.equal(turn.loading.ellipses, 0, show);
    // the choices once, then only the new suggestion
    assert.deepEqual(turn.reply.buttons, ['weekly installs', 'first runs that finished a recap', 'overnight changes you redid', 'something else', 'paying schools'], show);
    // a long reply sits in the title's spot at the body size
    assert.equal(turn.reply.title_top, out.before.title_top, show);
    assert.equal(turn.reply.title_px, out.why_px, show);
  }
  // the second turn continues the same conversation
  assert.deepEqual(seen, [[], ['what', LONG]], show);
});
