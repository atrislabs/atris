'use strict';

// The one page gm phone serves. Plain html, css, and vanilla js, no build
// step. Every piece of text from the task list goes in with textContent,
// never as html. The nonce matches the page's content security policy.
//
// One theme, the homepage letter's (atrisos-web LetterHome.tsx, dark values
// from app/config/theme-css.ts .dark): the
// brand colors, the letter serif, and the lava orb's amber as the only
// accent. The orb is a port of the landing orb (StippleOrb.tsx, LavaOrb.tsx,
// orb.module.css, LetterOrb.tsx) with the homepage tap 1:1: the dots spiral
// into one bright point and the lava orb is born there and grows. Here it
// then settles small at the top and the card fades up. Tap again and the
// card dissolves, the lava melts back into the sphere, and the next bet plays.
// Bets wait in a queue on the Mac, so a tap rarely waits; when it does, the
// spiral follows the real progress. Once a card is up nothing moves, but
// while the next card is on its way the dots never stop: after an answer
// they swarm in the sphere until it lands, and on the calm line (writing
// your next idea) the sphere stays above the card, swarming, its box open
// for a note, until the idea grows out of the dots. The footer is only the
// count of jobs the team is working on.
//
// Every card is big type in two parts: what is going on, and why it matters
// to the business. Nothing about how work is run or checked reaches the page.

function phonePage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#141110">
<title>front office</title>
<style nonce="${nonce}">
:root {
  --bg: #141110;
  --text: #eae3d9;
  --text-2: #a39b92;
  --text-3: #9a9187;
  --line: #3d332d;
  /* the edge of a box you type in: 3.2:1 on the page, past WCAG AA's 3:1 for a text box */
  --edge: #6e635b;
  --amber: rgb(255, 140, 66);
  --amber-ink: #1a0f06;
  --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
  /* the notch: the small orb rests below it, the same gap above the title as on a phone without one */
  --safe-top: env(safe-area-inset-top, 0px);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
/* a phone turned on its side keeps the page's type sizes; Safari would scale the words up */
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  font: 17px/1.5 var(--serif);
  min-height: 100vh;
  min-height: 100svh;
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
:focus-visible { outline: 1px solid var(--amber); outline-offset: 4px; }
[hidden] { display: none !important; }

/* ---- the screen: the orb in the middle, one line under it ---- */
.screen {
  position: relative;
  min-height: 100vh; min-height: 100svh;
  max-width: 34rem; margin: 0 auto;
  padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.stage { position: relative; width: min(72vmin, 520px); aspect-ratio: 1 / 1; }
/* on a short screen (a phone on its side) the orb leaves room for its line and the footer */
.stage { width: min(72vmin, 520px, 100svh - 200px); }
.stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; touch-action: none; cursor: pointer; }
.stage canvas:focus-visible { outline-offset: -8%; }
.line {
  min-height: 3em; margin: 4px 0 0; max-width: 22em; text-align: center;
  color: var(--text-3); font-size: 17px; line-height: 1.5; letter-spacing: -0.005em;
  opacity: 1; transition: opacity 0.28s ease;
}
.line.out { opacity: 0; }
.line.bad { color: var(--text-2); }
.foot { position: absolute; left: 0; right: 0; bottom: max(20px, env(safe-area-inset-bottom)); text-align: center; transition: opacity 0.3s ease-out 0.1s; }
/* while a card moves the footer steps aside, so it never jumps between the
   bottom of the screen and the end of a card; it comes back at rest */
body[data-busy]:not([data-in-place]) .foot { opacity: 0; transition: opacity 0.15s ease-in; }
/* the yeses still waiting: a small line beside the team, never a card on its own */
#needs { margin-right: 20px; color: var(--amber); }
.quiet { color: var(--text-2); font-size: 17px; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 44px; }
/* a card with a table (the team, one job) is wider, and at phone width the
   table scrolls sideways with the name column held in place; a line between
   every column and every row, and no column narrower than its words */
body.wide .screen { max-width: 64rem; }
.grid { margin: 14px 0 0; overflow-x: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; border: 1px solid var(--line); border-radius: 14px; }
.bet table { width: 100%; min-width: 44rem; border-collapse: separate; border-spacing: 0; font-size: 17px; line-height: 1.35; }
.bet table.k-deck { min-width: 56rem; }
.bet th, .bet td { padding: 10px 14px; text-align: left; vertical-align: baseline; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.bet th:last-child, .bet td:last-child { border-right: 0; }
.bet tbody tr:last-child td { border-bottom: 0; }
.bet th { color: var(--text-2); font-weight: 400; white-space: nowrap; }
.bet tr.row { cursor: pointer; }
@media (hover: hover) { .bet tr.row:hover td { background: #1c1816; } }
.bet td.member { position: sticky; left: 0; z-index: 1; background: var(--bg); white-space: nowrap; }
.bet td.member button { font-size: 18px; font-weight: 700; text-align: left; min-height: 32px; }
.bet td.role { min-width: 9rem; color: var(--text-2); }
.bet td.ovr { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.bet td.engine, .bet td.done { white-space: nowrap; }
.bet td.engine button { text-align: left; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 32px; }
.bet td.status { min-width: 16rem; color: var(--text-2); }
.bet td.status.working { color: var(--text); }
.bet td.status.waiting-for-your-yes, .bet td.status.needs-you { color: var(--amber); }
.bet td.work { min-width: 14rem; }
/* a job deck card: its place in the deck and its status above the title */
.bet .count, .bet .label, .bet .time { display: block; font-size: 17px; color: var(--text-2); }
.bet .label.needs-you { color: var(--amber); }
.bet .time { margin: 10px 0 0; }
.jobline { margin: 10px 0 0; color: var(--text-2); font-size: 17px; }
.thread { margin: 12px 0 0; }
.sayline { margin: 10px 0 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.sayline .thread, .sayline .reply { width: 100%; text-align: left; margin: 0; }
.unsent { margin: 0; text-align: center; }
.act > .links:empty { display: none; }
.turn { margin: 0 0 6px; font-size: 17px; line-height: 1.4; }
.turn.you { color: var(--text-2); }
.turn.orb { color: var(--text); }
.say { width: 100%; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; font-size: 18px; line-height: 1.4; resize: none; }

/* the lava orb, LavaOrb variant sm: three drifting blobs, transform and opacity only */
.lava {
  position: absolute; left: 0; top: 0; width: 280px; height: 280px; z-index: 5;
  border-radius: 50%; overflow: hidden; pointer-events: none;
  visibility: hidden; opacity: 0;
  background: rgb(20, 18, 16);
  box-shadow: 0 0 40px rgba(255, 140, 66, 0.1);
  filter: saturate(1.3);
  transform-origin: 50% 50%;
  will-change: transform, opacity;
}
.lava .tx, .lava .ty { position: absolute; inset: 0; will-change: transform; }
.lava .blob { position: absolute; will-change: transform; }
/* one pass only: the lava drifts while it is born, never on a loop */
.lava.alive .tx { animation: sine-x var(--dur) ease-in-out var(--delay) 1 both; }
.lava.alive .ty { animation: sine-y var(--dur) ease-in-out var(--delay) 1 both; }
.lava.alive .blob { animation: spin var(--spin) linear 1 both; }
.lava.alive .blob.rev { animation-direction: reverse; }
.lava .b1 { width: 70%; height: 45%; left: 20%; top: 25%; background: rgba(255, 140, 66, 0.55); border-radius: 60% 40% 50% 70% / 50% 60% 40% 50%; filter: blur(24px); }
.lava .b2 { width: 55%; height: 60%; left: 35%; top: 40%; background: rgba(255, 100, 50, 0.45); border-radius: 40% 60% 70% 30% / 60% 40% 60% 40%; filter: blur(24px); }
.lava .b3 { width: 50%; height: 40%; left: 10%; top: 50%; background: rgba(255, 180, 100, 0.4); border-radius: 50% 70% 30% 60% / 40% 50% 60% 50%; filter: blur(16px); }
.lava .core { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle, rgba(255,232,170,0.95) 0%, rgba(251,150,44,0.6) 30%, rgba(251,130,36,0) 62%); }
.lava .dim { position: absolute; inset: 0; border-radius: 50%; background: var(--bg); opacity: 0; }
.lava.tap { pointer-events: auto; cursor: pointer; }
.lava.still .tx, .lava.still .ty, .lava.still .blob { animation-play-state: paused; }
@keyframes sine-x { 0%, 100% { transform: translate3d(calc(var(--amp) * -1), 0, 0); } 50% { transform: translate3d(var(--amp), 0, 0); } }
@keyframes sine-y { 0%, 100% { transform: translate3d(0, calc(var(--amp) * -1), 0); } 50% { transform: translate3d(0, var(--amp), 0); } }
@keyframes spin { from { transform: rotate(var(--rot0, 0deg)); } to { transform: rotate(calc(var(--rot0, 0deg) + 360deg)); } }

/* ---- the card: same dark page, the lava orb small on top ---- */
body.has-card .screen { justify-content: flex-start; padding-top: calc(max(16px, env(safe-area-inset-top)) + 76px); }
body.has-card .stage, body.has-card .line { display: none; }
/* the footer sits at the bottom of the screen on a card too, where it is on the big orb, and only
   moves below a card taller than the screen, 28px under it */
body.has-card .foot { position: static; margin-top: auto; padding-top: 28px; }
body.has-card:not(.waiting) .screen { padding-bottom: max(20px, env(safe-area-inset-bottom)); }
.bet { width: 100%; opacity: 0; transform: translateY(20px); transition: opacity 0.45s ease-out, transform 0.55s cubic-bezier(0.22, 1, 0.36, 1); }
.bet.up { opacity: 1; transform: none; }
.bet.quick { transition-duration: 0.4s, 0.5s; }
/* after an act the next card fades up as the sphere settles, so the whole motion is about a
   second, and its title drifts only a few pixels into the spot the last title had */
.bet.acted { transform: translateY(4px); transition-duration: 0.3s, 0.38s; }
.bet.acted.up { transform: none; }
/* card to card: a crossfade in place. the old card is a still copy that
   fades over the box while the new card fades in under it from a small
   drift, its title landing where the old title was; the box eases to the
   new height */
.bet.ghost { position: absolute; z-index: 1; margin: 0; pointer-events: none; transition: opacity 0.2s ease-out; }
.bet.ghost.gone { opacity: 0; }
.bet.turning { overflow: hidden; transition: opacity 0.32s ease-out 0.08s, transform 0.32s cubic-bezier(0.22, 1, 0.36, 1) 0.08s, height 0.36s cubic-bezier(0.4, 0, 0.2, 1); }
.bet.turn-in { opacity: 0; transform: translateY(4px); transition: none; }
/* leaving: a soft fade in place, never a cut */
.bet.leave { opacity: 0; transform: none; transition: opacity 0.4s ease-out; }
.bet h1 { margin: 0; font-size: clamp(23px, 6.2vw, 30px); line-height: 1.12; font-weight: 700; letter-spacing: -0.03em; text-align: left; }
.why { margin: 14px 0 0; color: var(--text); font-size: 20px; line-height: 1.4; }
/* titles and labels wrap into even lines, and words to read never leave one word alone on the last line */
.bet h1, .option .t, .choice { text-wrap: balance; }
.why, .mission, .jobline, .turn, .option .w, .choice .w { text-wrap: pretty; }
/* a word longer than the screen (an email address) breaks instead of pushing the page sideways; the table keeps its own widths */
.bet, .line { overflow-wrap: anywhere; }
.bet .grid { overflow-wrap: normal; }
.act { margin: 18px 0 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.pill {
  min-width: 12rem; height: 44px; padding: 0 28px; border-radius: 22px;
  background: var(--amber); color: var(--amber-ink); font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
}
.pill.armed { background: var(--text); color: var(--bg); }
.links { color: var(--text-2); font-size: 17px; text-align: center; }
/* a dot between two small links that falls where the row wraps becomes the break itself */
.links .sep.cut { display: block; height: 0; overflow: hidden; }
.links button { color: var(--text-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 44px; padding: 0 6px; }
.links .pill { color: var(--amber-ink); text-decoration: none; padding: 0 28px; }
.mission { margin: 32px 0 0; padding: 16px 0 0; border-top: 1px solid var(--line); color: var(--text); font-size: 20px; line-height: 1.4; text-align: center; }
/* a choice: two or three ideas to tap, each a big title and one plain line of why */
.options { margin: 14px 0 0; display: flex; flex-direction: column; gap: 10px; }
.option { width: 100%; text-align: left; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line); color: var(--text); }
.option .t { display: block; font-size: 20px; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; }
.option .w { display: block; margin-top: 4px; font-size: 17px; line-height: 1.3; color: var(--text-2); }
/* a question card: the answers stack full width under the question */
.act.answers { align-items: stretch; gap: 10px; }
.act.answers .links { text-align: center; }

/* an answer to a question card */
.choice { width: 100%; min-height: 52px; text-align: left; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line); color: var(--text); font-size: 20px; }
/* an answer with a note (a model and its record): the name on its line, the note quiet under it */
.choice .t { display: block; }
.choice .w { display: block; margin-top: 2px; font-size: 17px; line-height: 1.3; color: var(--text-2); }
/* an answer that wraps keeps its lines together, like an idea's title */
.choice { line-height: 1.3; }

/* typing in place: the tapped answer becomes this box at its own size and
   spot, the cursor in it, and the rest of the card dims and stays put */
.field { position: relative; display: block; width: 100%; padding: 0; border: 1px solid var(--line); border-radius: 14px; color: var(--text); }
.field { border-color: var(--edge); }
.field input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0 76px 0 16px; border: 0; border-radius: 14px; background: transparent; color: var(--text); font: inherit; outline: none; }
.field input::placeholder { color: var(--text-2); opacity: 1; }
.field:focus-within { border-color: var(--text-2); }
.field .send { position: absolute; top: 0; right: 0; bottom: 0; min-width: 64px; padding: 0 14px; color: var(--text-2); font-size: 17px; text-decoration: none; }
.sayline .field input { padding: 0 76px; text-align: center; }
/* on a narrow phone its words start at the left, so the hint and what is typed have room beside send */
.sayline .field { container-type: inline-size; }
@container (max-width: 335px) { .sayline .field input { padding-left: 16px; text-align: left; } }
/* a chosen answer holds its spot with an amber edge, and the card takes no taps */
.choice.chosen, .option.chosen, .field.chosen { border-color: var(--amber); background: rgba(255, 140, 66, 0.1); }
.chosen .send { visibility: hidden; }
.chosen .send.reading { visibility: visible; }
.bet h1.said { font-size: 20px; line-height: 1.4; font-weight: 400; letter-spacing: 0; }
.bet.holding { pointer-events: none; }
.muted { opacity: 0.35; transition: opacity 0.2s ease; }
/* after an act the card fades all the way before it leaves the page, never cut mid fade */
.bet.leave.fast { transition: opacity 0.2s ease-in-out; }

/* ---- the calm line: the sphere stays, a little smaller and higher, its dots
   moving the whole time. The card under it takes no room of its own, so the
   sphere never jumps when the card comes or goes; it glides. ---- */
.stage { transform-origin: 50% 0; transition: transform 0.6s cubic-bezier(0.65, 0, 0.35, 1); }
body.has-card.waiting .screen { justify-content: center; padding-top: max(24px, env(safe-area-inset-top)); }
body.has-card.waiting .stage { display: block; transform: translateY(var(--wait-dy, 0px)) scale(var(--wait-k, 1)); }
body.has-card.waiting .line { display: block; }
body.has-card.waiting .foot { position: absolute; margin-top: 0; padding-top: 0; }
body.waiting .bet { position: absolute; left: 24px; right: 24px; width: auto; top: var(--wait-top, 62%); padding-bottom: 76px; }
.bet.wait-in { transform: translateY(8px); transition: opacity 0.4s ease-out 0.28s, transform 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.28s; }
.bet.wait-in.up { transform: none; }
.bet[data-kind="wait"] h1 { text-align: center; }
.waitstep { margin: 10px 0 0; min-height: 1.5em; text-align: center; color: var(--text-2); font-size: 17px; transition: opacity 0.26s ease; }
.waitstep.out { opacity: 0; }
.waittime { display: block; min-height: 1.5em; text-align: center; color: var(--text-3); font-size: 17px; }
.waitnotes { margin: 6px 0 0; overflow: hidden; transition: height 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
.waitnotes .turn { text-align: center; transition: opacity 0.3s ease-out; }
.waitnotes .turn.fresh { opacity: 0; }
.field.stay { height: 52px; }

@media (prefers-reduced-motion: reduce) {
  .lava .tx, .lava .ty, .lava .blob { animation: none !important; }
  .bet { transform: none; transition: opacity 0.2s linear; }
  .line { transition: none; }
  /* no travel and no swarm: every card change is a plain fade */
  .stage, .waitstep, .waitnotes, .waitnotes .turn { transition: none; }
  .bet.quick, .bet.acted, .bet.leave, .bet.leave.fast, .bet.wait-in { transform: none; transition: opacity 0.2s linear; }
  .lava { transition: opacity 0.2s linear; }
}
</style>
</head>
<body>
<main class="screen" id="screen">
  <div class="stage" id="stage">
    <canvas id="orb" tabindex="0" role="button" aria-label="the atris orb. tap to think of one new idea for the business"></canvas>
  </div>
  <p class="line" id="line" aria-live="polite">tap to think</p>
  <article class="bet" id="bet" hidden></article>
  <div class="foot" id="foot"><button type="button" class="quiet" id="needs" hidden></button><button type="button" class="quiet" id="working">the team</button></div>
</main>
<div class="lava" id="lava" role="button" tabindex="-1" aria-label="the atris orb. tap to go back to the big orb">
  <div class="tx" style-vars="15%,8.4s,-2.1s"><div class="ty" style-vars="12%,10.1s,-5.1s"><div class="blob b1" spin-vars="36s,0deg"></div></div></div>
  <div class="tx" style-vars="18%,12.6s,-7.2s"><div class="ty" style-vars="15%,7.2s,-4.7s"><div class="blob b2 rev" spin-vars="48s,45deg"></div></div></div>
  <div class="tx" style-vars="12%,7.2s,-6.4s"><div class="ty" style-vars="18%,10.1s,-9.9s"><div class="blob b3" spin-vars="57.6s,90deg"></div></div></div>
  <div class="core" id="lava-core"></div>
  <div class="dim" id="lava-dim"></div>
</div>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get('t') || '';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function api(path, body) {
    var opts = { headers: { 'x-gm-token': token } };
    if (body) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path + (body ? '' : '?t=' + encodeURIComponent(token)), opts)
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (j) { j.http = r.status; if (typeof j.needs_you === 'number') drawNeeds(j.needs_you); return j; }); });
  }

  // The yeses still waiting past the card on screen: one small line, and a
  // tap opens the job deck with the ones that need the owner first.
  function drawNeeds(n) {
    var btn = document.getElementById('needs');
    btn.hidden = !n;
    btn.textContent = n ? (n === 1 ? '1 needs you' : n + ' need you') : '';
  }

  // ---- the one line under the orb: fades out, changes, fades in ------------------
  var line = (function () {
    var node = document.getElementById('line');
    var want = null, busy = false;
    function next() {
      if (busy || want == null) return;
      var w = want; want = null;
      if (w.text === node.textContent && w.bad === node.classList.contains('bad')) return;
      if (reduced) { node.textContent = w.text; node.classList.toggle('bad', w.bad); return; }
      busy = true;
      node.classList.add('out');
      setTimeout(function () {
        node.textContent = w.text;
        node.classList.toggle('bad', w.bad);
        node.classList.remove('out');
        // each line stays long enough to read before the next one
        setTimeout(function () { busy = false; next(); }, 650);
      }, 280);
    }
    return {
      set: function (text, bad) { want = { text: text, bad: Boolean(bad) }; next(); },
      // the page just opened: no fade to wait out, so the next line comes at once
      clear: function () { if (busy) { line.set('', false); return; } want = null; node.textContent = ''; node.classList.remove('bad', 'out'); },
    };
  })();

  // ---- the orb: StippleOrb (tone dark) and LetterOrb's tap, ported 1:1 -----------
  // StippleOrb: the pull runs per dot over 0.75s after a delay (outer dots
  // first), the bright point arrives from 0.3s to 1.0s, and the lava is born
  // at 1.05s. LetterOrb: the lava grows for GROW_MS from 30px toward the
  // farthest corner (at most MAX_SCALE), with the same ease and smooth curves.
  // Here the grown lava then settles small at the top and the card fades up.
  var orb = (function () {
    var canvas = document.getElementById('orb');
    var lava = document.getElementById('lava');
    var core = document.getElementById('lava-core');
    var dim = document.getElementById('lava-dim');
    var ctx = canvas.getContext('2d');
    var SPRING = 0.07, DAMP = 0.8;
    // StippleOrb's pointer: dots within RADIUS of it are pushed out by PUSH
    // and spring home; a ripple runs out at WAVE_SPEED from where it came in
    var RADIUS = 90, PUSH = 14;
    var WAVE_SPEED = 620, WAVE_WIDTH = 70, WAVE_LIFE = 1.6;
    var GROW_MS = 1050, MAX_SCALE = 3.2;
    var SETTLE_MS = 900;
    // a tap on a card: the card fades for LEAVE_MS while the small orb glides
    // to the centre for GLIDE_MS, then the sphere grows back out of it and
    // holds for BEAT_MS before the next reveal starts from it
    var LEAVE_MS = 400, GLIDE_MS = 520, BEAT_MS = 340, BRIDGE_MS = 340;
    // the fast reveal stays contained: the lava grows to BLOOM of the smaller
    // window side and never washes the page
    var FAST_GROW_MS = 460, FAST_SETTLE_MS = 440, BLOOM = 0.72;
    // the owner acted on a card: one motion of about a second when the answer
    // is in. The card fades all the way while the small orb glides into the
    // sphere, the dots spiral in at ACT_PACE, and the next card grows out of
    // the point: the lava swells to ACT_BLOOM and is already drifting up as
    // it does, so its size and place never stop or snap on the way.
    var ACT_LEAVE_MS = 220, ACT_GLIDE_MS = 260, ACT_BEAT_MS = 100, ACT_PACE = 0.28, ACT_GROW_MS = 140, ACT_SETTLE_MS = 420, ACT_BLOOM = 0.56;
    var quick = false;
    // the swarm: while the next card is on its way the dots never stop. The
    // sphere turns at SWARM_SPIN and every dot wanders a slow loop of its
    // own, WANDER of the radius, springing after it. In and out of it the
    // motion eases over about a second, and it ends the moment a card lands.
    var IDLE_SPIN = 0.15, SWARM_SPIN = 0.5, WANDER = 0.1, SWARM_EASE = 0.04;
    var swarmK = 0, spin = IDLE_SPIN, clock = 0;
    // when a spiral starts, each dot keeps the speed it had and lets it fade
    // at CARRY a frame, so the dots turn inward without a stop
    var CARRY = 0.82;
    // what the dots did on the last frame, kept on the canvas so the motion can be
    // measured, and ms: how much of the dots' own clock that frame was, which is
    // at most 50ms however long the frame took
    var stats = { frame: 0, mode: 'idle', step: 0, mean: 0, ms: 0 };
    canvas.__orb = stats;
    // Two speeds, chosen by truth. A bet already waiting in the queue plays
    // the same curves at FAST of their length (tap to card in about two seconds, unhurried).
    // A bet still being made plays the full landing length, and the spiral
    // holds on the real progress until it passes.
    var FAST = 0.4;
    var pace = 1;
    var bridgeAt = 0;
    var REST = 56;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var count = window.innerWidth < 768 ? 5500 : 11000;
    var w = 0, h = 0, R = 0, cx = 0, cy = 0;
    var dots = [];
    // idle: the sphere drifts. pull: the dots spiral in by age. card: still.
    var mode = 'idle';
    var angle = 0;
    var age = -1, ageTo = 0, timed = false, fired = false;
    var raf = 0, lastT = 0;
    var onBorn = null;
    var base = 280, origin = { x: 0, y: 0 };
    // the light eases toward the pointer; at rest it comes from the upper left
    var light = { x: -0.5, y: -0.6, tx: -0.5, ty: -0.6 };
    var lz = Math.sqrt(1 - light.x * light.x - light.y * light.y);
    var pointer = { x: -9999, y: -9999, inside: false };
    var wave = { x: 0, y: 0, age: 99 };
    var ease = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
    var smooth = function (a, b, v) { var t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

    // the lava blobs take their drift numbers from the markup
    Array.prototype.forEach.call(lava.querySelectorAll('[style-vars]'), function (n) {
      var v = n.getAttribute('style-vars').split(',');
      n.style.setProperty('--amp', v[0]); n.style.setProperty('--dur', v[1]); n.style.setProperty('--delay', v[2]);
    });
    Array.prototype.forEach.call(lava.querySelectorAll('[spin-vars]'), function (n) {
      var v = n.getAttribute('spin-vars').split(',');
      n.style.setProperty('--spin', v[0]); n.style.setProperty('--rot0', v[1]);
    });

    function measure() {
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = Math.min(w, h) * 0.42; cx = w / 2; cy = h / 2;
    }

    function seed() {
      // random points on a sphere (normalised gaussians), so it reads as stipple
      var gauss = function () { return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random()); };
      dots = [];
      for (var i = 0; i < count; i++) {
        var gx = gauss(), gy = gauss(), gz = gauss();
        var n = Math.hypot(gx, gy, gz) || 1;
        dots.push({
          x: gx / n, y: gy / n, z: gz / n, sx: cx, sy: cy, vx: 0, vy: 0, r: 0.4 + Math.random() * 0.7, bx: 0, by: 0, dl: 0, kx: 0, ky: 0,
          // its own slow loop in the swarm
          f1: 0.5 + Math.random() * 0.8, f2: 0.5 + Math.random() * 0.8, p1: Math.random() * 6.283, p2: Math.random() * 6.283,
        });
      }
    }

    // StippleOrb startBoom: each dot remembers where it starts, and the outer
    // dots go first. The start is the sphere itself, so a page that opens
    // mid-thought still spirals from the whole orb.
    // fromHere: start from where the dots are now (a quick re-tap, mid re-form)
    function startPull(fromHere) {
      var cosA = Math.cos(angle), sinA = Math.sin(angle);
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        if (fromHere) { d.bx = d.sx; d.by = d.sy; } else { d.bx = cx + (d.x * cosA + d.z * sinA) * R; d.by = cy + d.y * R; d.vx = 0; d.vy = 0; }
        d.kx = 0; d.ky = 0;
        var len = Math.hypot(d.bx - cx, d.by - cy);
        d.dl = (1 - Math.min(1, len / R)) * 0.28 + Math.random() * 0.05;
      }
      age = 0; ageTo = 0; fired = false;
      mode = 'pull';
    }

    function frame(now) {
      var dt = Math.min(0.05, (now - (lastT || now)) / 1000);
      lastT = now;
      ctx.clearRect(0, 0, w, h);
      var swarming = mode === 'swarm' && !reduced;
      var toward = 1 - Math.pow(1 - SWARM_EASE, dt * 60);
      swarmK += ((swarming ? 1 : 0) - swarmK) * toward;
      spin += ((swarming ? SWARM_SPIN : IDLE_SPIN) - spin) * toward;
      clock += dt;
      if (!reduced && (mode === 'idle' || mode === 'swarm')) angle += dt * spin;
      wave.age += dt;
      light.x += (light.tx - light.x) * 0.06;
      light.y += (light.ty - light.y) * 0.06;
      lz = Math.sqrt(Math.max(0, 1 - light.x * light.x - light.y * light.y));
      var r2 = RADIUS * RADIUS;
      var waveFront = wave.age * WAVE_SPEED;
      var waveOn = mode === 'idle' && wave.age < WAVE_LIFE && !reduced;
      var waveGain = waveOn ? 1 - wave.age / WAVE_LIFE : 0;
      if (mode === 'pull') {
        // ready: the age runs on the clock, as on the homepage. Waiting: it
        // follows the real progress and stops short of the point.
        if (timed) age += dt / pace;
        else age += (ageTo - age) * 0.05;
      }
      var cosA = Math.cos(angle), sinA = Math.sin(angle);
      var most = 0, sum = 0, wander = WANDER * R * swarmK;
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        var fade = 1, shrink = 1;
        var x0 = d.sx, y0 = d.sy;
        var rx = d.x * cosA + d.z * sinA;
        var rz = -d.x * sinA + d.z * cosA;
        if (mode === 'idle' || mode === 'swarm') {
          var homeX = cx + rx * R, homeY = cy + d.y * R;
          if (wander > 0.05) {
            homeX += Math.sin(clock * d.f1 + d.p1) * wander;
            homeY += Math.sin(clock * d.f2 + d.p2) * wander;
          }
          if (waveOn) {
            var wx = homeX - wave.x, wy = homeY - wave.y;
            var wd = Math.sqrt(wx * wx + wy * wy) || 1;
            var off = (wd - waveFront) / WAVE_WIDTH;
            if (off > -1 && off < 1) {
              var bump = Math.cos(off * Math.PI * 0.5) * 22 * waveGain;
              homeX += (wx / wd) * bump;
              homeY += (wy / wd) * bump;
            }
          }
          if (pointer.inside && !reduced) {
            var dx = d.sx - pointer.x, dy = d.sy - pointer.y;
            var dist2 = dx * dx + dy * dy;
            if (dist2 < r2 && dist2 > 0.01) {
              var dist = Math.sqrt(dist2);
              var f = (1 - dist / RADIUS) * PUSH;
              d.vx += (dx / dist) * f * 0.2;
              d.vy += (dy / dist) * f * 0.2;
            }
          }
          d.vx += (homeX - d.sx) * SPRING;
          d.vy += (homeY - d.sy) * SPRING;
          d.vx *= DAMP; d.vy *= DAMP;
          d.sx += d.vx; d.sy += d.vy;
          if (reduced) { d.sx = cx + rx * R; d.sy = cy + d.y * R; }
        } else {
          var t = Math.min(1, Math.max(0, (age - d.dl) / 0.75));
          var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          var ox = (d.bx - cx) * (1 - e), oy = (d.by - cy) * (1 - e);
          var turn = e * 1.5;
          // the speed it had carries on and fades, then the spiral has it
          d.kx += d.vx; d.ky += d.vy; d.vx *= CARRY; d.vy *= CARRY;
          d.sx = cx + ox * Math.cos(turn) - oy * Math.sin(turn) + d.kx * (1 - e);
          d.sy = cy + ox * Math.sin(turn) + oy * Math.cos(turn) + d.ky * (1 - e);
          fade = 1 - Math.pow(Math.max(0, (e - 0.8) / 0.2), 1.5);
          shrink = 1 - 0.35 * e;
        }
        if (i < 64) { var stepped = Math.max(Math.abs(d.sx - x0), Math.abs(d.sy - y0)); if (stepped > most) most = stepped; sum += stepped; }
        // front dots are lit; the back half is a dim ghost. amber in shadow, cream where lit.
        var lit = rx * light.x + d.y * light.y + rz * lz;
        var front = rz > 0;
        var l = Math.max(0, lit);
        var a = (front ? 0.16 + Math.pow(l, 1.3) * 0.84 : 0.05 + l * 0.08) * fade;
        if (a <= 0.003) continue;
        ctx.fillStyle = l > 0.93 ? 'rgba(253, 196, 84, ' + a.toFixed(3) + ')' : 'rgba(251, 130, 36, ' + a.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(d.sx, d.sy, d.r * (front ? 0.6 + l * 0.7 : 0.6) * shrink, 0, Math.PI * 2);
        ctx.fill();
      }
      stats.frame += 1; stats.mode = mode; stats.step = most; stats.mean = sum / Math.min(64, dots.length || 1); stats.ms = dt * 1000;
      if (mode === 'pull') {
        // where the dots land: one bright point that swells until the lava is born
        var arrived = Math.min(1, Math.max(0, (age - 0.3) / 0.7));
        if (arrived > 0) point(arrived, timed ? 0.88 + 0.12 * Math.sin(age * 5) : 1);
        if (timed && !fired && age > 1.05) { fired = true; grow(); }
      } else if (bridgeAt) {
        // the melted lava's bright point fades as the sphere grows out of it
        var left = 1 - (now - bridgeAt) / BRIDGE_MS;
        if (left > 0) point(left, 1); else bridgeAt = 0;
      }
      // still once a card is up, and under reduced motion the sphere is drawn once and holds
      if (mode === 'card' || (reduced && (mode === 'idle' || mode === 'swarm'))) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }

    // one bright point at the centre with its glow, at strength arrived
    function point(arrived, breath) {
      var coreR = (2 + 5 * arrived) * breath;
      var glowR = (10 + 46 * arrived) * breath;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      g.addColorStop(0, 'rgba(255, 232, 170, ' + (0.9 * arrived).toFixed(3) + ')');
      g.addColorStop(0.35, 'rgba(251, 150, 44, ' + (0.4 * arrived).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(251, 130, 36, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, glowR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255, 244, 214, ' + arrived.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    }

    function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

    // at: the frame time this place is for, when it is a step of a motion, kept on
    // the lava so the motion can be measured on the clock it runs on
    function place(s, x, y, at) { lava.style.transform = 'translate(' + (x - base / 2) + 'px, ' + (y - base / 2) + 'px) scale(' + s + ')'; lava.__at = at; }
    function restPoint() {
      var top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;
      return { x: document.documentElement.clientWidth / 2, y: window.scrollY + Math.max(16, top) + 8 + REST / 2 };
    }

    // LetterOrb grow, then the settle: the lava is born at the point, grows
    // toward the farthest corner as the page dims to its own dark, then
    // shrinks back to a small orb at the top. After that nothing moves.
    // A queued bet (the fast pace) blooms contained: the lava grows to BLOOM
    // of the smaller window side, the page never dims, and it settles.
    function grow() {
      // fixed while it grows past the screen, so the page never scrolls sideways
      window.scrollTo(0, 0);
      var rect = canvas.getBoundingClientRect();
      var contained = pace < 1;
      var growMs = quick ? ACT_GROW_MS : contained ? FAST_GROW_MS : (GROW_MS * pace);
      var settleMs = quick ? ACT_SETTLE_MS : contained ? FAST_SETTLE_MS : (SETTLE_MS * pace);
      // after an act the card comes up at the bloom's peak; any other card once the lava has settled
      planned('bloom', growMs);
      if (!quick) planned('settle', settleMs);
      // the point the dots drew, where the sphere is on screen (smaller and higher on the calm line)
      var vx = rect.left + rect.width / 2, vy = rect.top + rect.height / 2;
      var bloom = quick ? ACT_BLOOM : BLOOM;
      var reach = contained
        ? bloom * Math.min(window.innerWidth, window.innerHeight) / 2
        : Math.hypot(Math.max(vx, window.innerWidth - vx), Math.max(vy, window.innerHeight - vy)) * 1.08;
      base = Math.round(Math.min(1000, Math.max(280, (2 * reach) / MAX_SCALE)));
      var sMax = (2 * reach) / base;
      var sMin = 30 / base;
      var rest = REST / base;
      lava.style.width = base + 'px';
      lava.style.height = base + 'px';
      origin = { x: vx, y: vy };
      lava.style.position = 'fixed';
      lava.style.opacity = '0';
      place(sMin, origin.x, origin.y);
      lava.style.visibility = 'visible';
      lava.classList.remove('still', 'alive', 'tap');
      void lava.offsetWidth;
      lava.classList.add('alive');
      if (contained) { rise(growMs, settleMs, sMin, sMax, rest); return; }
      var t0 = performance.now();
      var step = function (now) {
        var t = Math.min(1, (now - t0) / growMs);
        place(sMin + (sMax - sMin) * ease(t), origin.x, origin.y, now);
        lava.style.opacity = String(smooth(0.02, 0.22, t));
        core.style.opacity = String(1 - smooth(0.05, 0.4, t));
        dim.style.opacity = contained ? '0' : String(smooth(0.88, 1, t));
        if (t < 1) { requestAnimationFrame(step); return; }
        mode = 'card';
        stop();
        ctx.clearRect(0, 0, w, h);
        canvas.style.visibility = 'hidden';
        if (onBorn) onBorn('cover');
        var p = restPoint();
        var s0 = performance.now();
        var settle = function (n2) {
          var u = ease(Math.min(1, (n2 - s0) / settleMs));
          place(sMax + (rest - sMax) * u, origin.x + (p.x - origin.x) * u, origin.y + (p.y - origin.y) * u, n2);
          dim.style.opacity = contained ? '0' : String(1 - smooth(0.35, 0.85, u));
          if (u < 1) { requestAnimationFrame(settle); return; }
          settled();
        };
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(step);
    }

    // A contained bloom is one motion. The lava is born at the point and
    // swells for growMs on a soft curve while it already drifts up, then
    // eases down into the small orb at the top over settleMs. Its size turns at the peak with no
    // stop, and its place moves on one curve the whole way, so nothing snaps.
    // The card fades up under it from the peak.
    function rise(growMs, settleMs, sMin, sMax, rest) {
      var total = growMs + settleMs, k = growMs / total;
      var p = restPoint();
      var covered = false;
      var t0 = performance.now();
      var step = function (now) {
        var u = Math.min(1, (now - t0) / total);
        var s = u < k ? sMin + (sMax - sMin) * (0.5 - 0.5 * Math.cos(Math.PI * u / k)) : sMax + (rest - sMax) * ease((u - k) / (1 - k));
        var m = ease(u);
        place(s, origin.x + (p.x - origin.x) * m, origin.y + (p.y - origin.y) * m, now);
        lava.style.opacity = String(smooth(0, 0.1, u));
        core.style.opacity = String(1 - smooth(0.04, 0.5, u));
        dim.style.opacity = '0';
        if (!covered && u >= k) {
          covered = true;
          mode = 'card';
          stop();
          ctx.clearRect(0, 0, w, h);
          canvas.style.visibility = 'hidden';
          if (onBorn) onBorn('cover');
        }
        if (u < 1) { requestAnimationFrame(step); return; }
        settled();
      };
      requestAnimationFrame(step);
    }

    // the small lava orb at the top, still, and itself the next tap
    function settled() {
      var p = restPoint();
      if (base < 280) base = 280;
      lava.style.width = base + 'px';
      lava.style.height = base + 'px';
      // at rest it scrolls with the card
      lava.style.position = 'absolute';
      place(REST / base, p.x, p.y);
      lava.style.visibility = 'visible';
      lava.style.opacity = '1';
      core.style.opacity = '0';
      dim.style.opacity = '0';
      lava.classList.add('still', 'tap');
      mode = 'card';
      stop();
      canvas.style.visibility = 'hidden';
      lava.tabIndex = 0;
      if (onBorn) { var cb = onBorn; onBorn = null; cb('settled'); }
    }

    // a tap on a card: the card fades in place while the small lava orb
    // glides down to where the sphere sits (to), shrinking to a bright point.
    // swap() takes the card off the page once it has faded. At the centre the
    // lava melts and the sphere grows back out of the point, holds for a
    // beat so it reads, then calls back. Reduced motion: no travel.
    // fast: the owner acted, so the glide is the short one
    function melt(cb, to, swap, fast) {
      var leaveMs = fast ? ACT_LEAVE_MS : LEAVE_MS, glideMs = fast ? ACT_GLIDE_MS : GLIDE_MS, beatMs = fast ? ACT_BEAT_MS : BEAT_MS;
      lava.classList.remove('tap', 'alive');
      lava.tabIndex = -1;
      var swapped = false;
      var takeOff = function () { if (!swapped) { swapped = true; swap(); } };
      var reform = function () {
        takeOff();
        canvas.style.visibility = 'visible';
        measure();
        lava.style.visibility = 'hidden';
        lava.style.opacity = '0';
        for (var i = 0; i < dots.length; i++) { dots[i].sx = cx; dots[i].sy = cy; dots[i].vx = 0; dots[i].vy = 0; }
        pointer.inside = false;
        age = -1; timed = false; fired = false;
        // after an act the next card is on its way, so the dots come out swarming and never stop
        mode = fast ? 'swarm' : 'idle';
        bridgeAt = reduced ? 0 : performance.now();
        start();
        if (!reduced) planned('beat', beatMs);
        setTimeout(cb, reduced ? 0 : beatMs);
      };
      if (reduced || lava.style.visibility !== 'visible') { reform(); return; }
      var r = lava.getBoundingClientRect();
      var from = { x: r.left + r.width / 2, y: r.top + r.height / 2, s: r.width / base };
      // fixed while it travels, so the card's scroll and the swap never move it
      lava.style.position = 'fixed';
      place(from.s, from.x, from.y);
      var sEnd = 30 / base;
      planned('glide', glideMs);
      var t0 = performance.now();
      var step = function (now) {
        var k = Math.min(1, (now - t0) / glideMs);
        var t = fast ? 0.5 - 0.5 * Math.cos(Math.PI * k) : ease(k);
        if (now - t0 >= leaveMs) takeOff();
        place(from.s + (sEnd - from.s) * t, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, now);
        core.style.opacity = String(smooth(0.3, 0.9, k));
        lava.style.opacity = String(1 - smooth(0.7, 1, k));
        if (k < 1) { requestAnimationFrame(step); return; }
        reform();
      };
      requestAnimationFrame(step);
    }

    measure();
    seed();
    start();

    // StippleOrb's pointer, ported with trackWindow on, as LetterOrb uses it.
    // Over the sphere the dots part around the pointer and spring back; the
    // light follows the pointer anywhere on the page; a ripple runs out from
    // where the pointer comes in. When it leaves, the dots settle home. On a
    // phone a press and drag pushes the dots, and a tap still thinks. Only
    // the idle sphere answers, and never under reduced motion.
    function local(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    canvas.addEventListener('pointermove', function (e) {
      var p = local(e);
      pointer.x = p.x; pointer.y = p.y; pointer.inside = true;
    });
    canvas.addEventListener('pointerenter', function (e) {
      if (reduced || mode !== 'idle') return;
      var p = local(e);
      wave.x = p.x; wave.y = p.y; wave.age = 0;
    });
    canvas.addEventListener('pointerleave', function () { pointer.inside = false; });
    canvas.addEventListener('pointercancel', function () { pointer.inside = false; });
    function lightFrom(e) {
      var r = canvas.getBoundingClientRect();
      if (!r.width) return;
      var reach = Math.max(280, window.innerWidth * 0.4);
      light.tx = Math.max(-0.9, Math.min(0.9, (e.clientX - (r.left + r.width / 2)) / reach));
      light.ty = Math.max(-0.9, Math.min(0.9, (e.clientY - (r.top + r.height / 2)) / reach));
    }
    window.addEventListener('pointermove', lightFrom);

    return {
      // the bet is ready: the homepage tap, on the clock
      // act: the owner acted on a card, so it is the one quick motion
      play: function (cb, fast, act) {
        onBorn = cb;
        quick = Boolean(act);
        if (reduced) { settled(); return; }
        pace = act ? ACT_PACE : fast ? FAST : 1;
        // after an act the dots spiral in from where the re-formed sphere is
        if (mode !== 'pull') startPull(fast || Boolean(act));
        // the lava is born at 1.05 on the spiral's own clock, which runs at pace
        planned('spiral', Math.max(0, 1.05 - age) * pace * 1000);
        timed = true;
        start();
      },
      // no bet yet: the spiral follows the real progress
      wait: function () {
        pace = 1;
        if (mode !== 'pull') { startPull(false); timed = false; }
        start();
      },
      progress: function (p) {
        if (!timed) ageTo = Math.max(ageTo, 0.62 * Math.min(1, p));
      },
      // generation failed: the dots relax back to the sphere
      relax: function () {
        age = -1; timed = false; fired = false;
        mode = 'idle';
        start();
      },
      // the next card is on its way: the sphere is on the page and its dots keep moving
      swarm: function () {
        if (mode === 'card') {
          canvas.style.visibility = 'visible';
          measure();
          for (var i = 0; i < dots.length; i++) { dots[i].sx = cx; dots[i].sy = cy; dots[i].vx = 0; dots[i].vy = 0; }
          lava.classList.remove('tap', 'still', 'alive');
          lava.style.visibility = 'hidden';
          lava.style.opacity = '0';
          lava.tabIndex = -1;
          age = -1; timed = false; fired = false;
          mode = 'swarm';
        }
        if (mode === 'idle') mode = 'swarm';
        start();
      },
      // nothing is on its way: back to the idle drift under the pointer
      calm: function () { if (mode === 'swarm') mode = 'idle'; start(); },
      melt: melt,
      leaveMs: reduced ? 200 : LEAVE_MS,
      // a bet is already up when the page loads: the settled orb, no motion
      settled: function () { stop(); onBorn = null; settled(); },
      moving: function () { return mode === 'pull'; },
    };
  })();

  // ---- the card: one renderer, one way to act --------------------------------------
  // The page draws exactly the card the Mac served, with draw(card), and
  // nothing else draws a card. Its options and its box come only from that
  // card, and nothing from the card before survives a draw. Every tap posts
  // the card's id and the option's id, or the words typed in its box, to
  // /card; the Mac refuses anything else, and its answer is the next card.
  var bet = { shown: null, watching: null, tapAt: 0, plan: [], waited: 0, noting: false, clock: null };
  // while an act or a turn is under way the card takes no taps; the page
  // marks it on the body too, so anyone reading the page can tell
  var busyNow = false;
  Object.defineProperty(bet, 'busy', { get: function () { return busyNow; }, set: function (v) { busyNow = Boolean(v); document.body.toggleAttribute('data-busy', busyNow); } });
  // how long a line like "builder has it" stays under the orb before the next card
  var AFTER_MS = 1500;
  // a tapped option holds as chosen this long before the motion starts
  var HOLD_MS = 150;
  // what turns in place instead of the spiral: flipping the deck, more
  // models, and who a swap is for are the same card moving, not an answer
  var IN_PLACE = ['flip', 'more', 'scope'];

  function buzz() { if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* not on this device */ } } }

  // a failed fetch reads like a refusal, so nothing ever hangs
  function offline() { return { ok: false, http: 0, message: 'that did not reach the mac. try again.' }; }

  function box() { return document.getElementById('bet'); }

  // ---- draw: the one place a card becomes the page -----------------------------------
  function draw(card) {
    var b = box();
    b.textContent = '';
    b.setAttribute('data-card', card.id);
    b.setAttribute('data-kind', card.kind);
    document.body.classList.toggle('wide', Boolean(card.table));
    if (card.count) b.appendChild(el('span', 'count', card.count));
    if (card.label) b.appendChild(el('span', 'label ' + card.label.replace(/ /g, '-'), card.label));
    var title = b.appendChild(el('h1', null, card.title));
    // a reply of more than one line reads at the body size, in the same spot
    if (card.kind === 'reply') {
      var lines = document.createRange();
      lines.selectNodeContents(title);
      if (lines.getClientRects().length > 1) title.classList.add('said');
    }
    if (card.body) b.appendChild(el('p', 'why', card.body));
    var calm = isWait(card);
    // the calm line: what the writer is doing now, how long it has been, and the notes typed here
    if (calm) { b.appendChild(el('p', 'waitstep')); b.appendChild(el('span', 'waittime')); b.appendChild(el('div', 'waitnotes')); }
    // a reply keeps the title's spot; the turns so far sit quietly under it
    if (!calm && card.thread && card.thread.length) {
      var thread = b.appendChild(el('div', 'thread'));
      card.thread.forEach(function (t) { thread.appendChild(el('p', 'turn ' + (t.who === 'owner' ? 'you' : 'orb'), t.text)); });
    }
    // who it is and what they do; the rating and the model live on the team table
    if (card.job && !card.table && !calm) b.appendChild(el('p', 'jobline', [card.job.member, card.job.role].filter(Boolean).join(' · ')));
    var inCells = card.options.filter(function (o) { return o.cell; });
    if (card.table) b.appendChild(drawTable(card, inCells));
    if (card.time) b.appendChild(el('span', 'time', card.time));
    if (card.line) b.appendChild(el('p', 'mission', card.line));
    // the options in the card's own order; quiet ones next to each other share one line
    var rest = card.options.filter(function (o) { return !o.cell; });
    var quiet = function (o) { return !o.style || o.style === 'quiet'; };
    var act = el('div', 'act' + (rest.some(function (o) { return o.style === 'choice' || o.style === 'option'; }) ? ' answers' : ''));
    var links = null;
    var group = null;
    rest.forEach(function (o) {
      if (!quiet(o)) { links = null; act.appendChild(optionButton(o)); return; }
      // a group of quiet options shares one line, headed by its words
      if (links && (o.group || null) === group) links.appendChild(el('span', 'sep', ' · '));
      else {
        links = act.appendChild(el('div', 'links'));
        group = o.group || null;
        if (group) links.appendChild(document.createTextNode(group + ': '));
      }
      links.appendChild(optionButton(o));
    });
    // a quiet line under the options, empty until something does not go through
    act.appendChild(el('p', 'links note'));
    b.appendChild(act);
    breakLinks(act);
    if (card.input) b.appendChild(inputLine(card.input));
    if (calm) live(card, true);
  }

  // A row of small links that wraps never ends or starts a line with its dot:
  // a dot whose two links sit on different lines becomes the line break.
  function breakLinks(root) {
    var seps = root.querySelectorAll('.links .sep');
    Array.prototype.forEach.call(seps, function (s) { s.classList.remove('cut'); });
    var cut = Array.prototype.filter.call(seps, function (s) {
      var a = s.previousElementSibling, z = s.nextElementSibling;
      return a && z && z.getBoundingClientRect().top > a.getBoundingClientRect().top + 1;
    });
    cut.forEach(function (s) { s.classList.add('cut'); });
  }
  window.addEventListener('resize', function () { breakLinks(box()); });

  // a table: one row per line, a line between every cell; an option with a
  // cell is drawn in that cell, and a tap anywhere on its row opens the
  // row's first option
  function drawTable(card, inCells) {
    var t = card.table;
    var grid = el('div', 'grid');
    var table = grid.appendChild(el('table', 'k-' + card.kind));
    var head = el('tr');
    t.columns.forEach(function (c) { head.appendChild(el('th', c, c)).scope = 'col'; });
    table.appendChild(el('thead')).appendChild(head);
    var body = table.appendChild(el('tbody'));
    t.rows.forEach(function (row, i) {
      var mine = inCells.filter(function (o) { return o.cell.row === i; });
      var tr = body.appendChild(el('tr', mine.length ? 'row' : null));
      row.forEach(function (cell, j) {
        var col = t.columns[j];
        var td = tr.appendChild(el('td', col + (col === 'status' && t.status ? ' ' + String(t.status[i] || '').replace(/ /g, '-') : '')));
        var o = mine.filter(function (x) { return x.cell.column === col; })[0];
        if (o) {
          var btn = td.appendChild(optionButton(o, true));
          btn.addEventListener('click', function (e) { e.stopPropagation(); });
        } else td.textContent = cell;
      });
      if (mine.length) tr.addEventListener('click', function () { var first = tr.querySelector('button'); if (first) first.click(); });
    });
    return grid;
  }

  // One option, as the card says: big or quiet, a second tap when it asks
  // for one, a box when it takes words. bare: no class of its own (in a cell).
  function optionButton(o, bare) {
    var cls = bare ? null : o.style === 'primary' ? 'pill' : o.style === 'choice' ? 'choice' : o.style === 'option' ? 'option' : null;
    var btn = el('button', cls);
    btn.type = 'button';
    btn.setAttribute('data-option', o.id);
    if (o.style === 'option' || (o.detail && o.style === 'choice')) {
      btn.appendChild(el('span', 't', o.label));
      if (o.detail) btn.appendChild(el('span', 'w', o.detail));
    } else btn.textContent = o.label;
    if (o.chosen) btn.classList.add('chosen');
    if (o.type) btn.classList.add('other');
    if (o.action === 'none') { btn.disabled = true; return btn; }
    if (o.confirm) {
      // the first tap arms this one button; the second sends; it goes quiet after five seconds
      var armed = false, quiet = null;
      btn.addEventListener('click', function () {
        if (bet.busy) return;
        buzz();
        if (!armed) {
          armed = true; btn.textContent = o.confirm; btn.classList.add('armed');
          quiet = setTimeout(function () { armed = false; btn.textContent = o.label; btn.classList.remove('armed'); }, 5000);
          return;
        }
        clearTimeout(quiet);
        armed = false;
        send(btn, { option_id: o.id, confirm: true }, o);
      });
      return btn;
    }
    btn.addEventListener('click', function () {
      if (bet.busy) return;
      buzz();
      if (o.type) { typeHere(btn, o.type.placeholder || o.label, o.type.max || 280, function (text, field) { send(field, { option_id: o.id, text: text }, o); }); return; }
      send(btn, { option_id: o.id }, o);
    });
    return btn;
  }

  // the card's box: a quiet line that turns into the field in its own spot.
  // On the calm line it is open from the start and stays open, without
  // taking the cursor, and the words are a note for the idea being written.
  function inputLine(input) {
    var wrap = el('div', 'links sayline');
    var open = wrap.appendChild(el('button', 'quiet', input.label || 'or say something'));
    open.type = 'button';
    open.addEventListener('click', function () {
      if (bet.busy) return;
      typeHere(open, input.placeholder || 'say something', input.max || 280, function (text, field) { send(field, { text: text }, null); });
    });
    if (box().getAttribute('data-kind') === 'wait') typeHere(open, input.placeholder || 'add a note for this idea', input.max || 280, function (text, field) { sendNote(field, text); }, true);
    return wrap;
  }

  // ---- answering in place: the eyes stay in one spot ---------------------------------
  // every row of the card dims but the one in use; no spot, none
  function dimOthers(spot) {
    box().querySelectorAll('.act > *, .act .links > button, .sayline, .grid').forEach(function (n) {
      n.classList.toggle('muted', Boolean(spot) && n !== spot && !n.contains(spot) && !spot.contains(n));
    });
  }

  // the spot holds as chosen and the card takes no taps; returns when it started
  function hold(spot) {
    dimOthers(spot);
    spot.classList.add('chosen');
    box().classList.add('holding');
    var input = spot.querySelector('input');
    if (input) { input.readOnly = true; input.blur(); }
    bet.busy = true;
    var at = tapped();
    planned('hold', HOLD_MS);
    return at;
  }

  function afterHold(heldAt) {
    var left = heldAt ? heldAt + HOLD_MS - performance.now() : 0;
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, left)); });
  }

  // The tapped button becomes the field at its own size and spot, with the
  // cursor already in it, and the other options dim. Enter or send hands
  // the words to sent(text, field). Left empty, it turns back into the button.
  // stay: the calm line's box, open from the start without the cursor, and
  // open after every send.
  function typeHere(btn, placeholder, maxLength, sent, stay) {
    var field = el('div', btn.classList.contains('choice') ? 'choice field' : 'field');
    // its exact height, to the subpixel, so nothing under it moves
    if (stay) field.classList.add('stay'); else field.style.height = btn.getBoundingClientRect().height + 'px';
    var input = el('input');
    input.type = 'text';
    input.maxLength = maxLength;
    input.placeholder = placeholder;
    input.enterKeyHint = 'send';
    input.setAttribute('aria-label', placeholder);
    var go = el('button', 'send', 'send');
    go.type = 'button';
    var submit = function () {
      var text = input.value.trim();
      if (text && !bet.busy && !bet.noting) sent(text, field);
    };
    // a press on send keeps the cursor in the field, so it never closes first
    go.addEventListener('mousedown', function (e) { e.preventDefault(); });
    go.addEventListener('click', function () { buzz(); submit(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    input.addEventListener('blur', function () {
      if (stay || input.value.trim() || field.classList.contains('chosen') || !field.isConnected) return;
      field.replaceWith(btn);
      dimOthers(null);
    });
    field.appendChild(input);
    field.appendChild(go);
    btn.replaceWith(field);
    if (stay) return field;
    dimOthers(field);
    input.focus();
    return field;
  }

  // One id per send: made when these words are first sent from this card's
  // option or box, the same on every retry of them there, and new for any
  // other card, option, or words, so a send whose answer was lost is never
  // sent twice and the same words to someone else always go. getRandomValues
  // works on the plain http of the wifi link, where randomUUID does not.
  var sent = { key: null, id: null };
  function sendId(key) {
    if (sent.key !== key) {
      var n = new Uint32Array(2);
      crypto.getRandomValues(n);
      sent.key = key;
      sent.id = ('000000' + n[0].toString(36)).slice(-7) + ('000000' + n[1].toString(36)).slice(-7);
    }
    return sent.id;
  }

  // ---- acting: one post, then one motion to the next card ------------------------------
  // The option holds as chosen for HOLD_MS. Then the card fades while the
  // small orb glides into the sphere; once the answer is in, the dots
  // spiral in and the next card blooms where they land. An answer that is
  // late leaves the sphere in its idle drift until it lands. A line from the
  // Mac (who has it now) shows under the sphere while it waits. When it did
  // not go through, the same card comes back with the words still in its
  // box and one line why. Flipping the deck turns the card in place.
  function send(spot, body, option) {
    if (!bet.shown) return;
    var from = bet.shown;
    body.card_id = from.id;
    if (body.text) body.send = sendId([from.id, option ? option.id : 'the box', body.text].join(' | '));
    var heldAt = hold(spot);
    var answer = api('/act', body).catch(offline);
    if (option && IN_PLACE.indexOf(option.action) >= 0) {
      document.body.setAttribute('data-in-place', '');
      Promise.all([answer, afterHold(heldAt)]).then(function (both) {
        var r = both[0];
        if (!r.ok || !r.card) { bet.busy = false; document.body.removeAttribute('data-in-place'); unsent(from, r, body.text, option); return; }
        turnTo(r.card);
      });
      return;
    }
    afterHold(heldAt).then(function () { flow(answer, from, body.text, option); });
  }

  function flow(answer, from, typed, option) {
    var landed = null;
    var sphere = false;
    var lineAt = 0, waitFrom = 0;
    var land = function () {
      // the sphere is ready before the answer is in: it waits from now
      if (sphere && !landed) waitFrom = performance.now();
      if (!landed || !sphere) return;
      if (waitFrom) bet.waited += performance.now() - waitFrom;
      var r = landed;
      landed = null;
      var wait = r.ack && lineAt ? Math.max(0, AFTER_MS - (performance.now() - lineAt)) : 0;
      if (wait) planned('line', wait);
      setTimeout(function () {
        // nothing more to show: the sphere stays, with its line, and its dots settle into the idle drift
        if (r.ok && (r.home || !r.card)) { bet.busy = false; bet.shown = null; orb.calm(); line.set(r.home ? 'not now. tap when you want another' : 'tap to think', false); return; }
        // the card the Mac has on screen now is the one that comes back; a
        // refusal comes back on it with one line why
        var then = r.card || from;
        if (!then) { bet.busy = false; orb.calm(); line.set('that did not go through. tap to try again', true); return; }
        if (!r.ok) { spiralTo(then, function () { unsent(then, r, typed, then.id === (from && from.id) ? option : null); }); return; }
        spiralTo(then, null);
      }, wait);
    };
    answer.then(function (r) {
      landed = r;
      if (r.ok && r.ack) { lineAt = performance.now(); line.set(r.ack, false); }
      land();
    });
    leave(function () { sphere = true; land(); }, true);
  }

  // the card fades in place while the small orb glides down and becomes the
  // sphere; the card leaves the page once it has faded all the way. From the
  // calm line the sphere is already there: its words fade and it glides home.
  function leave(then, fast) {
    if (waiting()) { leaveWait(then, fast); return; }
    var b = box();
    var to = sphereSpot();
    b.classList.remove('quick', 'acted', 'up');
    b.classList.add('leave');
    b.classList.toggle('fast', Boolean(fast));
    var swap = function () {
      b.style.minHeight = '';
      b.hidden = true;
      b.classList.remove('leave', 'fast', 'holding');
      document.body.classList.remove('has-card', 'wide');
      window.scrollTo(0, 0);
    };
    // reduced motion: no travel; the card and the small orb fade, then the sphere is there
    if (reduced) {
      document.getElementById('lava').style.opacity = '0';
      planned('leave', 200);
      setTimeout(function () { swap(); stageFade(); orb.melt(then, to, function () {}, fast); }, 200);
      return;
    }
    orb.melt(then, to, swap, fast);
  }

  // under reduced motion the sphere never travels: it fades in where it now sits
  function stageFade() {
    if (!reduced) return;
    var stage = document.getElementById('stage');
    stage.style.transition = 'none';
    stage.style.opacity = '0';
    void stage.offsetWidth;
    stage.style.transition = 'opacity 0.2s linear';
    stage.style.opacity = '';
  }

  // from the sphere: the dots spiral in and the card grows out of the point.
  // The calm line is not a card that blooms: the sphere stays and its dots keep moving.
  function spiralTo(card, after) {
    line.set('', false);
    if (isWait(card)) { enterWait(card); if (after) after(); return; }
    // reduced motion: no spiral; the card fades in where it goes
    if (reduced) { orb.settled(); showCard(card, true); bet.busy = false; if (after) after(); return; }
    orb.play(function (phase) {
      // the card blooms where the dots land; what comes with it (a line why, the words back in their box) comes with it
      if (phase === 'cover') { showCard(card, true, true, true); if (after) after(); }
      if (phase === 'settled') bet.busy = false;
    }, true, true);
  }

  // It did not go through: this card as it was, one line why under its
  // options, and typed words back in their box with the cursor in it.
  function unsent(card, r, typed, option) {
    if (bet.shown !== card || box().getAttribute('data-card') !== card.id) showCard(card, false);
    box().classList.remove('holding');
    var note = box().querySelector('.act .note');
    // the Mac's own refusals are plain words; anything else reads as one plain line
    if (note) note.textContent = (r && r.http === 409 && r.message) || (r && r.http === 0 && r.message) || 'that did not go through. try again.';
    if (!typed) return;
    // the calm line's box is open already: the words go back into it
    var openBox = !option && box().querySelector('.sayline .field.stay input');
    if (openBox) { openBox.value = typed; return; }
    // the words go back where they were typed, or to this card's own box when the card is a new one
    var spot = option ? box().querySelector('[data-option="' + option.id + '"]') : box().querySelector('.sayline .quiet');
    if (!spot) return;
    if (!option && !card.input) return;
    var field = typeHere(spot, (option && option.type && option.type.placeholder) || (card.input && card.input.placeholder) || 'say something', 280, function (text, f) { send(f, option ? { option_id: option.id, text: text } : { text: text }, option); });
    field.querySelector('input').value = typed;
  }

  // ---- showing a card ---------------------------------------------------------------------
  // The time from the tap to the card fully on screen, kept on the page so
  // the speed can be measured. data-reveal-ms is the clock. data-reveal-plan
  // is each step of the motion in order with the length it is set to take,
  // and data-reveal-waited-ms is how long the sphere waited on the Mac's
  // answer, so late frames on a busy machine are told apart from the motion.
  var REVEAL = ['data-reveal-ms', 'data-reveal-plan', 'data-reveal-waited-ms'];
  function tapped() {
    bet.tapAt = performance.now();
    bet.plan = [];
    bet.waited = 0;
    REVEAL.forEach(function (a) { document.body.removeAttribute(a); });
    return bet.tapAt;
  }
  function planned(name, ms) { if (bet.tapAt) bet.plan.push(name + ' ' + Math.round(ms)); }
  function measured() {
    if (bet.tapAt) {
      document.body.setAttribute('data-reveal-plan', bet.plan.join(', '));
      document.body.setAttribute('data-reveal-waited-ms', String(Math.round(bet.waited)));
      document.body.setAttribute('data-reveal-ms', String(Math.round(performance.now() - bet.tapAt)));
    }
    bet.tapAt = 0;
  }
  // how long a card's own fade up is set to take, read from its style
  function fadeMs(n) {
    var s = getComputedStyle(n);
    var i = Math.max(0, s.transitionProperty.split(', ').indexOf('opacity'));
    var at = function (list) { var v = list.split(', '); return (parseFloat(v[i % v.length]) || 0) * 1000; };
    return at(s.transitionDelay) + at(s.transitionDuration);
  }

  // fast: the quick fade from the big orb; act: the short one after an act
  function showCard(card, animate, fast, act) {
    if (isWait(card)) { enterWait(card, !animate); return; }
    var b = box();
    bet.shown = card;
    // where it starts from is set first: drawing measures the title, and a
    // measure is a frame the card would otherwise start from somewhere else
    b.classList.remove('leave', 'fast', 'holding', 'wait-in');
    b.classList.toggle('quick', Boolean(fast) && !act);
    b.classList.toggle('acted', Boolean(act));
    b.classList.toggle('up', !animate);
    // on the page before it is drawn, so a long title can tell it runs past one line
    document.body.classList.remove('waiting');
    document.body.classList.add('has-card');
    b.hidden = false;
    draw(card);
    if (card.watch) watchWait(); else stopWatch();
    if (!animate) { measured(); return; }
    var done = function (e) { if (e.propertyName === 'opacity') { b.removeEventListener('transitionend', done); measured(); } };
    b.addEventListener('transitionend', done);
    void b.offsetWidth;
    requestAnimationFrame(function () { b.classList.add('up'); planned('fade', fadeMs(b)); });
  }

  // ---- the calm line: the dots keep moving while the next idea is written -----------------
  // The sphere stays on the page, a little smaller and higher, and its dots
  // swarm. The card sits under it with what the writer is doing now, and its
  // box is open: words typed there are a note for the idea being written,
  // and the card stays. When the idea lands it grows out of the dots. A tap
  // on the dots goes back to the big orb, as the small orb does on a card.
  function isWait(card) { return Boolean(card && card.kind === 'wait'); }
  function waiting() { return document.body.classList.contains('waiting'); }
  // the calm line is one card while its words change, under any stamp
  function sameCard(a, b) { return Boolean(a && b && (a.id === b.id || (isWait(a) && isWait(b) && String(a.id).split('#')[0] === String(b.id).split('#')[0]))); }

  // the smaller sphere's place: at most 300px, and high enough that the card
  // under it has WAIT_ROOM. It is read from the sphere's own place in the
  // layout, which the calm line keeps and a transform never moves.
  var WAIT_ROOM = 250;
  function placeWait(animate) {
    var stage = document.getElementById('stage');
    var body = document.body;
    var hidden = !stage.offsetHeight;
    if (hidden) body.classList.add('has-card', 'waiting');
    var screenTop = document.getElementById('screen').getBoundingClientRect().top;
    var h = stage.offsetHeight || 1, top0 = screenTop + stage.offsetTop;
    if (hidden) body.classList.remove('waiting');
    // and on a short screen (a phone on its side) small enough that the sphere,
    // the card's room, and a margin above and below fit, so the footer never lands on the card
    var k = Math.min(1, 300 / h, 0.62 * Math.min(window.innerWidth, window.innerHeight) / h, Math.max(80, window.innerHeight - WAIT_ROOM - 48) / h);
    var top = Math.max(24, (window.innerHeight - (k * h + WAIT_ROOM)) / 2);
    var s = body.style;
    s.setProperty('--wait-k', k.toFixed(4));
    s.setProperty('--wait-dy', Math.round(top - top0) + 'px');
    s.setProperty('--wait-top', Math.round(top + k * h + 6 - screenTop) + 'px');
    if (animate) return;
    stage.style.transition = 'none';
    requestAnimationFrame(function () { requestAnimationFrame(function () { stage.style.transition = ''; }); });
  }

  // a turned phone: the calm line's sphere and card find their place again
  window.addEventListener('resize', function () { if (waiting()) placeWait(false); });

  // The calm line's card takes no room of its own. On a screen too short for
  // it (a phone on its side, a note and its answer open) the footer moves
  // into the card's own room under its words instead of sitting on them,
  // and the page scrolls to it; the sphere and the card never move.
  function fitWait() {
    var foot = document.getElementById('foot');
    var b = box();
    var need = waiting() && !b.hidden ? b.offsetTop + b.offsetHeight : 0;
    var over = need > document.getElementById('screen').clientHeight;
    foot.style.top = over ? Math.round(need - 64) + 'px' : '';
    foot.style.bottom = over ? 'auto' : '';
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitWait).observe(box());
  window.addEventListener('resize', fitWait);

  // atOnce: the page opened on it, so it is simply there
  function enterWait(card, atOnce) {
    var b = box();
    var was = waiting() && !b.hidden;
    bet.shown = card;
    if (atOnce) line.clear(); else line.set('', false);
    orb.swarm();
    if (!was) { placeWait(!atOnce && !reduced); stageFade(); }
    b.classList.remove('leave', 'fast', 'holding', 'quick', 'acted', 'up', 'wait-in');
    document.body.classList.add('has-card', 'waiting');
    document.getElementById('orb').setAttribute('aria-label', 'the atris orb, writing your next idea. tap to go back to the big orb');
    b.hidden = false;
    draw(card);
    watchWait();
    bet.busy = false;
    if (was || atOnce) { b.classList.add('up'); return; }
    b.classList.add('wait-in');
    void b.offsetWidth;
    requestAnimationFrame(function () { b.classList.add('up'); });
  }

  // The calm line's live words: what the writer is doing now, how long it
  // has been, and the newest note typed here with the answer to it. draw()
  // puts them on the card; while it shows they are kept fresh in place. Its
  // options and its box never change under one id, so the field, its words,
  // and the cursor in it are never touched.
  function live(card, atOnce) {
    var b = box();
    var step = b.querySelector('.waitstep');
    if (!isWait(card) || !step) return;
    bet.shown = card;
    b.setAttribute('data-card', card.id);
    var h = b.querySelector('h1');
    if (h.textContent !== card.title) h.textContent = card.title;
    var lines = Array.isArray(card.progress) ? card.progress : [];
    var newest = lines.length ? lines[lines.length - 1] : null;
    stepTo(step, newest && typeof newest.line === 'string' ? newest.line : '', atOnce);
    notesTo(b.querySelector('.waitnotes'), card.thread || [], atOnce);
    // the Mac's own count of how long it has been, carried on from when it came
    if (Number.isFinite(card.waited_ms)) waitClock = { key: String(card.id).split('#')[0], ms: card.waited_ms, at: Date.now() };
    tickWait();
  }

  // one line at a time, crossfaded in its own spot, so nothing under it moves
  function stepTo(node, text, atOnce) {
    if (node.getAttribute('data-text') === text) return;
    node.setAttribute('data-text', text);
    clearTimeout(node.fading);
    if (atOnce || reduced || !node.textContent) { node.textContent = text; node.classList.remove('out'); return; }
    node.classList.add('out');
    node.fading = setTimeout(function () { node.textContent = node.getAttribute('data-text'); node.classList.remove('out'); }, 260);
  }

  // the newest note and the answer to it; a new one fades in, and the room it
  // takes opens smoothly
  function notesTo(node, turns, atOnce) {
    var want = turns.slice(-2);
    var had = Array.prototype.map.call(node.children, function (n) { return n.textContent; });
    if (had.join('\\n') === want.map(function (t) { return t.text; }).join('\\n')) return;
    var from = node.offsetHeight;
    node.style.height = '';
    node.textContent = '';
    want.forEach(function (t, i) {
      var p = node.appendChild(el('p', 'turn ' + (t.who === 'owner' ? 'you' : 'orb'), t.text));
      if (!atOnce && !reduced && had[i] !== t.text) p.classList.add('fresh');
    });
    if (atOnce || reduced) return;
    var to = node.offsetHeight;
    if (from !== to) {
      node.style.height = from + 'px';
      void node.offsetHeight;
      node.style.height = to + 'px';
      clearTimeout(node.opening);
      node.opening = setTimeout(function () { node.style.height = ''; }, 340);
    }
    requestAnimationFrame(function () { requestAnimationFrame(function () { Array.prototype.forEach.call(node.querySelectorAll('.fresh'), function (p) { p.classList.remove('fresh'); }); }); });
  }

  // how long the idea has been written, in plain words: the Mac's own count
  // when the card has it, else from when it began on the Mac's clock when
  // that is sane, else from when the page first saw the calm line
  var seen = { key: null, at: 0 };
  var waitClock = { key: null, ms: 0, at: 0 };
  function sinceWords(ms) {
    var s = Math.round(ms / 1000);
    if (!(s >= 5) || s > 3600) return '';
    if (s < 60) return Math.max(5, Math.round(s / 5) * 5) + ' seconds so far';
    var m = Math.round(s / 60);
    return m === 1 ? 'about a minute so far' : 'about ' + m + ' minutes so far';
  }
  function tickWait() {
    var node = box().querySelector('.waittime');
    var card = bet.shown;
    if (!node || !isWait(card) || !waiting()) { clearInterval(bet.clock); bet.clock = null; return; }
    var key = String(card.id).split('#')[0];
    if (seen.key !== key) seen = { key: key, at: Date.now() };
    var began = typeof card.started_at === 'number' ? card.started_at : Date.parse(card.started_at || '');
    var ms = waitClock.key === key ? waitClock.ms + (Date.now() - waitClock.at) : Date.now() - began;
    if (!(ms >= 0 && ms < 3600000)) ms = Date.now() - seen.at;
    var words = sinceWords(ms);
    if (node.textContent !== words) node.textContent = words;
    if (!bet.clock) bet.clock = setInterval(tickWait, 1000);
  }

  // A note on the calm line: the words hold in the box for the moment it
  // takes, then the box clears and stays open, and the note and the answer
  // to it show above. Nothing moves on: the idea that comes in is the one
  // written with it. Words that did not reach the Mac stay in the box.
  function sendNote(field, text) {
    var from = bet.shown;
    var input = field.querySelector('input');
    var body = { card_id: from.id, text: text, send: sendId([from.id, 'the box', text].join(' | ')) };
    bet.noting = true;
    field.classList.add('chosen');
    input.readOnly = true;
    var note = box().querySelector('.act .note');
    if (note) note.textContent = '';
    api('/act', body).catch(offline).then(function (r) {
      bet.noting = false;
      field.classList.remove('chosen');
      input.readOnly = false;
      // the owner went back to the big orb meanwhile: the Mac has the note, and nothing here moves
      if (!waiting()) return;
      if (r.ok && r.card && sameCard(r.card, from)) { input.value = ''; input.blur(); live(r.card); return; }
      // the Mac moved on (the idea landed meanwhile): it comes in, and the words go back in its box
      if (r.card && !sameCard(r.card, from)) { landFromWait(r.card, r.ok ? null : function () { unsent(r.card, r, text, null); }); return; }
      if (note) note.textContent = (r && r.message) || 'that did not go through. try again.';
    });
  }

  // off the calm line, home or to an act's next card: its words fade, then
  // the sphere glides back to its own place and size
  function leaveWait(then, fast) {
    var b = box();
    stopWatch();
    if (!fast) orb.calm();
    b.classList.remove('wait-in');
    b.classList.add('leave', 'fast');
    setTimeout(function () {
      b.hidden = true;
      b.classList.remove('leave', 'fast', 'holding', 'up');
      document.body.classList.remove('has-card', 'wide', 'waiting');
      stageFade();
      document.getElementById('orb').setAttribute('aria-label', 'the atris orb. tap to think of one new idea for the business');
      then();
    }, 220);
  }

  // The idea lands: the calm line's words fade while the dots spiral in
  // from wherever they are, and the card grows out of the point.
  function landFromWait(card, after) {
    var b = box();
    bet.busy = true;
    stopWatch();
    b.classList.remove('wait-in');
    b.classList.add('leave', 'fast');
    var off = function () {
      b.classList.remove('leave', 'fast');
      document.body.classList.remove('waiting');
      document.getElementById('orb').setAttribute('aria-label', 'the atris orb. tap to think of one new idea for the business');
    };
    if (reduced) {
      setTimeout(function () { off(); orb.settled(); showCard(card, true); bet.busy = false; if (after) after(); }, 200);
      return;
    }
    orb.play(function (phase) {
      if (phase === 'cover') { off(); showCard(card, true, true, true); if (after) after(); }
      if (phase === 'settled') bet.busy = false;
    }, true, true);
  }

  // a card the Mac has now that is not the one on screen
  function arrive(card) {
    if (waiting()) { landFromWait(card); return; }
    if (isWait(card)) { leave(function () { enterWait(card); }, true); return; }
    turnTo(card);
  }

  // where the sphere sits once the card is gone, read before anything moves,
  // in page coordinates (the screen's once the page is back at the top)
  function sphereSpot() {
    var b = box();
    var y0 = window.scrollY, was = b.hidden, wide = document.body.classList.contains('wide');
    document.body.classList.remove('has-card', 'wide');
    b.hidden = true;
    var r = document.getElementById('orb').getBoundingClientRect();
    var spot = { x: r.left + r.width / 2, y: r.top + window.scrollY + r.height / 2 };
    document.body.classList.add('has-card');
    if (wide) document.body.classList.add('wide');
    b.hidden = was;
    if (window.scrollY !== y0) window.scrollTo(0, y0);
    return spot;
  }

  // Card to card in place: a still copy of the old card fades over the box
  // while the new card, drawn under it, fades in from DRIFT below over
  // TURN_IN_MS, starting 80ms in, so its title lands where the old title
  // was. The box eases to its new height. No layout jump.
  var TURN_IN_MS = 320, DRIFT = 4;
  function turnTo(card) {
    var b = box();
    b.classList.remove('holding');
    bet.shown = card;
    document.body.setAttribute('data-in-place', '');
    turnInPlace(b, function () { draw(card); }, function () { bet.busy = false; document.body.removeAttribute('data-in-place'); measured(); if (card.watch) watchWait(); else stopWatch(); });
  }

  function turnInPlace(b, paint, after) {
    if (reduced) { b.style.minHeight = ''; paint(); after(); return; }
    var from = b.offsetHeight;
    b.style.height = from + 'px';
    b.style.minHeight = '';
    var ghost = b.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.classList.remove('quick', 'acted', 'turning', 'turn-in');
    ghost.classList.add('up', 'ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    var r = b.getBoundingClientRect(), p = b.offsetParent.getBoundingClientRect();
    ghost.style.top = (r.top - p.top) + 'px';
    ghost.style.left = (r.left - p.left) + 'px';
    ghost.style.width = r.width + 'px';
    b.after(ghost);
    b.classList.remove('quick', 'acted', 'turning');
    paint();
    b.style.height = 'auto';
    var to = b.offsetHeight;
    b.style.height = from + 'px';
    b.classList.add('turn-in');
    void b.offsetHeight;
    b.classList.add('turning');
    b.classList.remove('turn-in');
    b.style.height = to + 'px';
    ghost.classList.add('gone');
    var turnMs = 80 + TURN_IN_MS + 20;
    planned('turn', turnMs);
    setTimeout(function () {
      ghost.remove();
      b.classList.remove('turning');
      b.style.height = '';
      after();
    }, turnMs);
  }

  // While the calm line shows, look every WAIT_LOOK_MS: its live words are
  // kept fresh, even while the owner types, and once the Mac has the idea
  // ready it is asked for the way a tap does and grows out of the dots. It
  // waits while the owner types there (the box has the cursor or any words)
  // or a note is on its way, and on the big orb it waits for their tap.
  var WAIT_LOOK_MS = 1500;
  function typingOnCard() {
    var input = box().querySelector('.field input');
    return Boolean(input && (input === document.activeElement || input.value.trim()));
  }
  function stopWatch() { if (bet.watching) { clearInterval(bet.watching); bet.watching = null; } }
  function watchWait() {
    if (bet.watching) return;
    var quiet = function () { return !bet.busy && !bet.noting && document.body.classList.contains('has-card') && !typingOnCard(); };
    bet.watching = setInterval(function () {
      if (!bet.shown || !bet.shown.watch) { stopWatch(); return; }
      if (bet.busy || bet.noting) return;
      api('/card').then(function (s) {
        if (s.http !== 200 || !s.card || !bet.shown || !bet.shown.watch || bet.busy || bet.noting) return;
        if (sameCard(s.card, bet.shown)) live(s.card);
        else if (quiet()) { bet.busy = true; arrive(s.card); return; }
        if (!quiet() || !(s.queue > 0)) return;
        bet.busy = true;
        api('/act', { orb: true, card_id: bet.shown.id }).catch(offline).then(function (r) {
          if (r.ok && r.card && !sameCard(r.card, bet.shown)) { arrive(r.card); return; }
          bet.busy = false;
          if (r.ok && r.card) live(r.card);
        });
      }).catch(function () { /* the next look tries again */ });
    }, WAIT_LOOK_MS);
  }

  // ---- the orb ----------------------------------------------------------------------------
  // The big orb: the next card, with the spiral, as on page open. An idea
  // that landed behind the calm line is the next one, so it is never passed.
  function think() {
    if (bet.busy) return;
    // on the calm line the dots are the orb on the card: a tap goes back to the big one
    if (waiting()) { goHome(); return; }
    buzz();
    bet.busy = true;
    tapped();
    var failed = function () {
      bet.busy = false;
      orb.relax();
      line.set('that did not go through. tap to try again', true);
    };
    api('/act', { orb: true, card_id: bet.shown ? bet.shown.id : null }).then(function (r) {
      if (r.http !== 200 || !r.card) { if (r.http === 200) { bet.busy = false; orb.relax(); line.set('tap to think', false); return; } failed(); return; }
      line.set('', false);
      // nothing ready yet: the calm line, with the sphere where it is and its dots moving
      if (isWait(r.card)) { enterWait(r.card); return; }
      // the big orb moves once the answer is in
      bet.waited = performance.now() - bet.tapAt;
      orb.play(function (phase) { if (phase === 'settled') { bet.busy = false; showCard(r.card, true, true); } }, true);
    }, failed);
  }

  // The small orb on a card goes back to the big dotted orb, from any card:
  // the card fades, the small orb glides down and the dots form again, idle
  // under the pointer. The card stays where it is on the Mac, so nothing is
  // passed until the big orb is tapped.
  function goHome() {
    if (bet.busy) return;
    buzz();
    bet.busy = true;
    stopWatch();
    // from the calm line the sphere is already there; its line comes once the card's words are gone
    if (waiting()) { leave(function () { line.set('tap to think', false); bet.busy = false; }); return; }
    // the line under the big orb is ready before the sphere is back
    line.set('tap to think', false);
    leave(function () { bet.busy = false; });
  }

  function tapSmallOrb() {
    if (document.body.classList.contains('has-card')) goHome(); else think();
  }

  var canvas = document.getElementById('orb');
  var lavaTap = document.getElementById('lava');
  [[canvas, think], [lavaTap, tapSmallOrb]].forEach(function (pair) {
    pair[0].addEventListener('click', pair[1]);
    pair[0].addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pair[1](); }
    });
  });

  // first look: a card already on screen shows settled, anything else is the sphere
  function firstLook() {
    api('/card').then(function (s) {
      if (s.http !== 200) return;
      if (s.card && isWait(s.card)) { enterWait(s.card, true); return; }
      if (s.card) { orb.settled(); showCard(s.card, false); return; }
      line.set(s.status === 'skipped' ? 'not now. tap when you want another' : 'tap to think', false);
    });
  }

  // ---- the footer: the team and the yeses waiting, both cards like any other ---------------
  // From any card, or the big orb: the Mac serves the team table or the job
  // deck as the next card, and its back option returns to where the owner was.
  function openFrom(which) {
    if (bet.busy) return;
    buzz();
    bet.busy = true;
    tapped();
    var answer = api('/act', { open: which, card_id: bet.shown ? bet.shown.id : null }).catch(offline);
    if (!document.body.classList.contains('has-card')) {
      answer.then(function (r) {
        if (!r.ok || !r.card) { bet.busy = false; line.set((r && r.message) || 'that did not go through. tap to try again', true); return; }
        bet.waited = performance.now() - bet.tapAt;
        spiralTo(r.card, null);
      });
      return;
    }
    flow(answer, bet.shown, null, null);
  }
  document.getElementById('working').addEventListener('click', function () { openFrom('team'); });
  document.getElementById('needs').addEventListener('click', function () { openFrom('deck'); });

  // the option on the card that does this, if it has one
  function optionFor(action, step) {
    if (!bet.shown) return null;
    return bet.shown.options.filter(function (o) { return o.action === action && (step == null || (o.binds && o.binds.step === step)); })[0] || null;
  }
  function useOption(o) {
    var b = o && box().querySelector('[data-option="' + o.id + '"]');
    if (b && !bet.busy) b.click();
  }

  // Esc: words being typed are cancelled and the cursor leaves first; then
  // a card with a way back takes it. On a card with none it does nothing.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.isComposing || !bet.shown || !document.body.classList.contains('has-card')) return;
    var field = document.activeElement;
    if (field && field.tagName === 'INPUT') {
      e.preventDefault();
      field.value = '';
      field.blur();
      return;
    }
    var back = optionFor('back');
    if (back) { e.preventDefault(); useOption(back); }
  }, true);

  // the arrows and a sideways swipe flip the job deck, unless the owner is typing
  document.addEventListener('keydown', function (e) {
    var step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    var field = document.activeElement;
    if (!step || e.isComposing || (field && field.tagName === 'INPUT')) return;
    var o = optionFor('flip', step);
    if (!o) return;
    e.preventDefault();
    useOption(o);
  });
  var swipe = null;
  box().addEventListener('touchstart', function (e) { swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  box().addEventListener('touchend', function (e) {
    if (!swipe) return;
    var dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) useOption(optionFor('flip', dx < 0 ? 1 : -1));
  });

  // the footer: how many members are really working, or the team when none are
  function drawWorking(n) {
    var btn = document.getElementById('working');
    btn.textContent = n ? n + ' working' : 'the team';
  }

  // Every few seconds: the footer counts, and the card on screen. When the
  // Mac's card has changed (a new id: its options are not the ones shown),
  // it turns in place, or grows out of the dots on the calm line, unless the
  // owner is typing or a motion is under way.
  function refresh() {
    return api('/card').then(function (s) {
      if (s.http !== 200) { line.set('this link stopped working. start gm phone again on the mac.', true); return; }
      drawWorking(s.team_working || 0);
      if (s.card && bet.shown && !sameCard(s.card, bet.shown) && !bet.busy && !bet.noting && !typingOnCard() && document.body.classList.contains('has-card')) {
        bet.busy = true;
        arrive(s.card);
      }
    }).catch(function () { /* the next refresh tries again */ });
  }

  firstLook();
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
}

module.exports = { phonePage };
