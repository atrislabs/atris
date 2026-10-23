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
// spiral follows the real progress. Once a card is up nothing moves. The
// footer is only the count of jobs the team is working on.
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
  --amber: rgb(255, 140, 66);
  --amber-ink: #1a0f06;
  --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
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
  padding: max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom));
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.stage { position: relative; width: min(72vmin, 520px); aspect-ratio: 1 / 1; }
.stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; touch-action: none; cursor: pointer; }
.stage canvas:focus-visible { outline-offset: -8%; }
.line {
  min-height: 3em; margin: 4px 0 0; max-width: 22em; text-align: center;
  color: var(--text-3); font-size: 17px; line-height: 1.5; letter-spacing: -0.005em;
  opacity: 1; transition: opacity 0.28s ease;
}
.line.out { opacity: 0; }
.line.bad { color: var(--text-2); }
.foot { position: absolute; left: 0; right: 0; bottom: max(20px, env(safe-area-inset-bottom)); text-align: center; }
/* the yeses still waiting: a small line beside the team, never a card on its own */
#needs { margin-right: 20px; color: var(--amber); }
.quiet { color: var(--text-2); font-size: 17px; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 44px; }
/* the team: one row per member: who, the role, the rating, the model, and the status */
.team { position: fixed; inset: 0; z-index: 20; overflow-y: auto; background: var(--bg); padding: max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom)); }
.team .inner { max-width: 34rem; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.team .head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.team h1 { margin: 0; font-size: clamp(23px, 6.2vw, 30px); line-height: 1.12; font-weight: 700; letter-spacing: -0.03em; }
.team .inner.wide { max-width: 64rem; }
/* the table: a line between every column and every row. at phone width the
   box scrolls sideways and the name column stays put; no column ever gets
   narrower than its words */
.team .grid { overflow-x: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; border: 1px solid var(--line); border-radius: 14px; }
.team table { width: 100%; min-width: 44rem; border-collapse: separate; border-spacing: 0; font-size: 17px; line-height: 1.35; }
.team th, .team td { padding: 10px 14px; text-align: left; vertical-align: top; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.team th:last-child, .team td:last-child { border-right: 0; }
.team tbody tr:last-child td { border-bottom: 0; }
.team th { color: var(--text-2); font-weight: 400; white-space: nowrap; }
.team .row { cursor: pointer; }
@media (hover: hover) { .team .row:hover td { background: #1c1816; } }
.team .who { position: sticky; left: 0; z-index: 1; background: var(--bg); white-space: nowrap; }
.team .who button { font-size: 18px; font-weight: 700; text-align: left; }
.team .role { min-width: 9rem; color: var(--text-2); }
.team .ovr { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.team .eng { white-space: nowrap; }
.team td.eng button { text-align: left; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 32px; }
/* the engine card: the line, who it is for, then every model on this machine by tool */
.team .done { margin: 0; color: var(--text); font-size: 18px; line-height: 1.4; }
.team .scopes { display: flex; flex-wrap: wrap; gap: 8px; }
.team .scopes button { min-height: 44px; padding: 0 16px; border-radius: 22px; border: 1px solid var(--line); color: var(--text-2); font-size: 17px; }
.team .scopes button.chosen { border-color: var(--amber); background: rgba(255, 140, 66, 0.1); color: var(--text); }
.team .models { display: flex; flex-direction: column; gap: 8px; }
.team .models h2 { margin: 10px 0 0; color: var(--text-2); font-size: 17px; font-weight: 400; }
.team .models .choice { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.team .models .choice .w { color: var(--text-2); font-size: 17px; white-space: nowrap; }
.team .models .choice[disabled] { cursor: default; }
.team td.st { min-width: 16rem; color: var(--text-2); }
.team td.st.working { color: var(--text); }
.team td.st.waiting-for-your-yes { color: var(--amber); }
/* the job deck: one running job at a time, in one spot, with its place in
   the deck. the card is a .bet card, so a flip is the main card's own turn */
.deckspot { position: relative; }
.deckcard { display: flex; flex-direction: column; gap: 12px; touch-action: pan-y; }
.deckcard .count, .deckcard .label, .deckcard .time { font-size: 17px; color: var(--text-2); }
.deckcard .label.needs-you { color: var(--amber); }
.deckcard .why, .deckcard .act, .deckcard .mission { margin: 0; }
.jobs-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; border: 1px solid var(--line); border-radius: 14px; }
.team table.jobs { min-width: 56rem; }
.jobs td.work { min-width: 14rem; }
.jobs td.done, .jobs td.member, .jobs td.engine, .jobs td.status { white-space: nowrap; }
.deckbar { display: flex; justify-content: space-between; gap: 12px; }
.sayline { margin: 10px 0 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.sayline .thread, .sayline .reply { width: 100%; text-align: left; margin: 0; }
.unsent { margin: 0; text-align: center; }
.act > .links:empty { display: none; }
.turn { margin: 0 0 6px; font-size: 18px; line-height: 1.4; }
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
body.has-card .foot { position: static; margin-top: 28px; }
.bet { width: 100%; opacity: 0; transform: translateY(20px); transition: opacity 0.45s ease-out, transform 0.55s cubic-bezier(0.22, 1, 0.36, 1); }
.bet.up { opacity: 1; transform: none; }
.bet.quick { transition-duration: 0.4s, 0.5s; }
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
.act { margin: 18px 0 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.pill {
  min-width: 12rem; height: 44px; padding: 0 28px; border-radius: 22px;
  background: var(--amber); color: var(--amber-ink); font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
}
.pill.armed { background: var(--text); color: var(--bg); }
.links { color: var(--text-2); font-size: 17px; }
.links button { color: var(--text-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 44px; padding: 0 6px; }
.links .pill { color: var(--amber-ink); text-decoration: none; padding: 0 28px; }
.mission { margin: 32px 0 0; padding: 16px 0 0; border-top: 1px solid var(--line); color: var(--text); font-size: 20px; line-height: 1.4; text-align: center; }
/* a choice: two or three ideas to tap, each a big title and one plain line of why */
.options { margin: 14px 0 0; display: flex; flex-direction: column; gap: 10px; }
.option { width: 100%; text-align: left; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); color: var(--text); }
.option .t { display: block; font-size: 20px; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; }
.option .w { display: block; margin-top: 4px; font-size: 17px; line-height: 1.3; color: var(--text-2); }
/* a question card: the answers stack full width under the question */
.act.answers { align-items: stretch; gap: 10px; }
.act.answers .links { text-align: center; }

/* an answer to a question card */
.choice { width: 100%; min-height: 52px; text-align: left; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line); color: var(--text); font-size: 19px; }

/* typing in place: the tapped answer becomes this box at its own size and
   spot, the cursor in it, and the rest of the card dims and stays put */
.field { position: relative; display: block; width: 100%; padding: 0; border: 1px solid var(--line); border-radius: 14px; color: var(--text); }
.field input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0 76px 0 16px; border: 0; border-radius: 14px; background: transparent; color: var(--text); font: inherit; outline: none; }
.field input::placeholder { color: var(--text-2); opacity: 1; }
.field:focus-within { border-color: var(--text-2); }
.field .send { position: absolute; top: 0; right: 0; bottom: 0; min-width: 64px; padding: 0 14px; color: var(--text-2); font-size: 17px; text-decoration: none; }
.sayline .field input { padding: 0 76px; text-align: center; }
/* a chosen answer holds its spot with an amber edge, and the card takes no taps */
.choice.chosen, .option.chosen, .field.chosen { border-color: var(--amber); background: rgba(255, 140, 66, 0.1); }
.chosen .send { visibility: hidden; }
.chosen .send.reading { visibility: visible; }
.bet h1.said { font-size: 20px; line-height: 1.4; font-weight: 400; letter-spacing: 0; }
.bet.holding { pointer-events: none; }
.muted { opacity: 0.35; transition: opacity 0.2s ease; }

@media (prefers-reduced-motion: reduce) {
  .lava .tx, .lava .ty, .lava .blob { animation: none !important; }
  .bet { transform: none; transition: opacity 0.2s linear; }
  .line { transition: none; }
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
  <div class="foot" id="foot"><button type="button" class="quiet" id="needs" hidden></button><button type="button" class="quiet" id="working" aria-haspopup="dialog">the team</button></div>
</main>
<div class="lava" id="lava" role="button" tabindex="-1" aria-label="the atris orb. tap to go back to the big orb">
  <div class="tx" style-vars="15%,8.4s,-2.1s"><div class="ty" style-vars="12%,10.1s,-5.1s"><div class="blob b1" spin-vars="36s,0deg"></div></div></div>
  <div class="tx" style-vars="18%,12.6s,-7.2s"><div class="ty" style-vars="15%,7.2s,-4.7s"><div class="blob b2 rev" spin-vars="48s,45deg"></div></div></div>
  <div class="tx" style-vars="12%,7.2s,-6.4s"><div class="ty" style-vars="18%,10.1s,-9.9s"><div class="blob b3" spin-vars="57.6s,90deg"></div></div></div>
  <div class="core" id="lava-core"></div>
  <div class="dim" id="lava-dim"></div>
</div>
<section class="team" id="team" hidden role="dialog" aria-label="the team"><div class="inner" id="team-inner"></div></section>
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
    return { set: function (text, bad) { want = { text: text, bad: Boolean(bad) }; next(); } };
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
        dots.push({ x: gx / n, y: gy / n, z: gz / n, sx: cx, sy: cy, vx: 0, vy: 0, r: 0.4 + Math.random() * 0.7, bx: 0, by: 0, dl: 0 });
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
        if (fromHere) { d.bx = d.sx; d.by = d.sy; } else { d.bx = cx + (d.x * cosA + d.z * sinA) * R; d.by = cy + d.y * R; }
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
      if (!reduced && mode === 'idle') angle += dt * 0.15;
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
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        var fade = 1, shrink = 1;
        var rx = d.x * cosA + d.z * sinA;
        var rz = -d.x * sinA + d.z * cosA;
        if (mode === 'idle') {
          var homeX = cx + rx * R, homeY = cy + d.y * R;
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
          d.sx = cx + ox * Math.cos(turn) - oy * Math.sin(turn);
          d.sy = cy + ox * Math.sin(turn) + oy * Math.cos(turn);
          fade = 1 - Math.pow(Math.max(0, (e - 0.8) / 0.2), 1.5);
          shrink = 1 - 0.35 * e;
        }
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
      if (mode === 'card' || (reduced && mode === 'idle')) { raf = 0; return; }
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

    function place(s, x, y) { lava.style.transform = 'translate(' + (x - base / 2) + 'px, ' + (y - base / 2) + 'px) scale(' + s + ')'; }
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
      var rect = canvas.getBoundingClientRect();
      var contained = pace < 1;
      var growMs = contained ? FAST_GROW_MS : (GROW_MS * pace);
      var settleMs = contained ? FAST_SETTLE_MS : (SETTLE_MS * pace);
      var vx = rect.left + cx, vy = rect.top + cy;
      var reach = contained
        ? BLOOM * Math.min(window.innerWidth, window.innerHeight) / 2
        : Math.hypot(Math.max(vx, window.innerWidth - vx), Math.max(vy, window.innerHeight - vy)) * 1.08;
      base = Math.round(Math.min(1000, Math.max(280, (2 * reach) / MAX_SCALE)));
      var sMax = (2 * reach) / base;
      var sMin = 30 / base;
      var rest = REST / base;
      lava.style.width = base + 'px';
      lava.style.height = base + 'px';
      // fixed while it grows past the screen, so the page never scrolls sideways
      window.scrollTo(0, 0);
      origin = { x: vx, y: vy };
      lava.style.position = 'fixed';
      lava.style.visibility = 'visible';
      lava.classList.remove('still', 'alive', 'tap');
      void lava.offsetWidth;
      lava.classList.add('alive');
      var t0 = performance.now();
      var step = function (now) {
        var t = Math.min(1, (now - t0) / growMs);
        place(sMin + (sMax - sMin) * ease(t), origin.x, origin.y);
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
          place(sMax + (rest - sMax) * u, origin.x + (p.x - origin.x) * u, origin.y + (p.y - origin.y) * u);
          dim.style.opacity = contained ? '0' : String(1 - smooth(0.35, 0.85, u));
          if (u < 1) { requestAnimationFrame(settle); return; }
          settled();
        };
        requestAnimationFrame(settle);
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
    function melt(cb, to, swap) {
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
        mode = 'idle';
        bridgeAt = reduced ? 0 : performance.now();
        start();
        setTimeout(cb, reduced ? 0 : BEAT_MS);
      };
      if (reduced || lava.style.visibility !== 'visible') { reform(); return; }
      var r = lava.getBoundingClientRect();
      var from = { x: r.left + r.width / 2, y: r.top + r.height / 2, s: r.width / base };
      // fixed while it travels, so the card's scroll and the swap never move it
      lava.style.position = 'fixed';
      place(from.s, from.x, from.y);
      var sEnd = 30 / base;
      var t0 = performance.now();
      var step = function (now) {
        var k = Math.min(1, (now - t0) / GLIDE_MS);
        var t = ease(k);
        if (now - t0 >= LEAVE_MS) takeOff();
        place(from.s + (sEnd - from.s) * t, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
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
      play: function (cb, fast) {
        onBorn = cb;
        if (reduced) { settled(); return; }
        pace = fast ? FAST : 1;
        if (mode !== 'pull') startPull(fast);
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
      melt: melt,
      leaveMs: reduced ? 200 : LEAVE_MS,
      // a bet is already up when the page loads: the settled orb, no motion
      settled: function () { stop(); onBorn = null; settled(); },
      moving: function () { return mode === 'pull'; },
    };
  })();

  // ---- the bet ------------------------------------------------------------------
  var bet = { status: null, polling: false, armed: false, drawn: null, busy: false, last: null, watching: null };
  // how long "builder has it" (or any ack) stays before the next card
  var AFTER_MS = 1500;

  function buzz() { if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* not on this device */ } } }

  // after a yes or a nice, the next card comes the way a re-tap brings it
  function moveOn(ack) {
    var box = document.getElementById('bet');
    box.style.minHeight = box.offsetHeight + 'px';
    var act = box.querySelector('.act');
    var line = box.querySelector('.sayline');
    if (line) line.remove();
    if (act) act.replaceWith(el('p', 'mission', ack));
    else box.appendChild(el('p', 'mission', ack));
    setTimeout(function () { tapOrb(false); }, AFTER_MS);
  }

  // A second tap, armed on this one button: one card and one command. A tap
  // on another card, or a card drawn again after a flip, starts over, and
  // the armed tap goes quiet after five seconds. Once sent, it takes no more.
  function armedTap(go, label, armedLabel, run) {
    var armed = false;
    var quiet = null;
    go.addEventListener('click', function () {
      buzz();
      if (!armed) {
        armed = true; go.textContent = armedLabel; go.className = 'pill armed';
        quiet = setTimeout(function () { armed = false; go.textContent = label; go.className = 'pill'; }, 5000);
        return;
      }
      clearTimeout(quiet);
      armed = false;
      go.disabled = true;
      run();
    });
  }

  // a line that ends like a sentence
  function sentence(t) {
    var s = String(t || '').trim();
    return s && !/[.!?]$/.test(s) ? s + '.' : s;
  }

  // the yes on a yes card: the first tap arms it, the second sends it.
  // done(line, reply) gets the line to show after it.
  function yesPill(post, done) {
    var yes = el('button', 'pill', 'yes');
    yes.type = 'button';
    armedTap(yes, 'yes', 'tap again to say yes', function () {
      post().then(function (r) { done(r.ack || r.message || 'sent', r); });
    });
    return yes;
  }

  // a yes the owner owes, or a finished business move: what is going on,
  // then why it matters, both written by the server
  function drawJobCard(s) {
    var box = document.getElementById('bet');
    box.textContent = '';
    var j = s.job;
    box.appendChild(el('h1', null, j.what));
    if (j.why) box.appendChild(el('p', 'why', j.why));
    var act = el('div', 'act');
    if (s.kind === 'yes') {
      act.appendChild(yesPill(function () { return api('/bet/yes', { confirm: true }); }, moveOn));
      // two quiet ways past it: no tells the job no for this one request, and
      // not now skips it to the back and brings the next card
      var no = el('button', 'quiet', 'no');
      no.type = 'button';
      no.addEventListener('click', function () {
        if (bet.busy) return;
        buzz();
        no.disabled = true;
        api('/bet/no', {}).then(function (r) { moveOn(r.ack || r.message || 'sent'); });
      });
      act.appendChild(no);
      var later = el('button', 'quiet', 'not now');
      later.type = 'button';
      later.addEventListener('click', function () {
        if (bet.busy) return;
        buzz();
        think(false, 0, { later: true });
      });
      act.appendChild(later);
    } else if (s.kind === 'wait') {
      // one calm line: the idea turns in on its own once it is written
      watchWait();
      box.appendChild(sayBox());
      return;
    } else {
      var ok = el('button', 'pill', 'nice');
      ok.type = 'button';
      ok.addEventListener('click', function () {
        buzz();
        api('/bet/nice', {}).then(function (r) { moveOn(r.ack || 'nice.'); });
      });
      act.appendChild(ok);
    }
    box.appendChild(act);
    box.appendChild(sayBox());
  }

  // While the calm line shows, look every WAIT_LOOK_MS for the idea; once the
  // server has one ready, it is asked for the way a tap does and turns in
  // with one crossfade. No tap, and nothing moves on the page while it
  // waits. It also waits while the owner types there (the box has the
  // cursor or any words), so it comes in after they send, or once they
  // clear the box and leave it; and on the big orb, it waits for their tap.
  var WAIT_LOOK_MS = 1500;
  function typingOnCard() {
    var input = document.getElementById('bet').querySelector('.field input');
    return Boolean(input && (input === document.activeElement || input.value.trim()));
  }
  function watchWait() {
    if (bet.watching) return;
    var quiet = function () { return !bet.busy && document.body.classList.contains('has-card') && !typingOnCard(); };
    bet.watching = setInterval(function () {
      if (!bet.last || bet.last.kind !== 'wait') { clearInterval(bet.watching); bet.watching = null; return; }
      if (!quiet()) return;
      api('/bet').then(function (s) {
        if (s.http !== 200 || !quiet() || !bet.last || bet.last.kind !== 'wait') return;
        if (s.id !== bet.last.id && s.kind !== 'wait' && isCard(s)) { bet.status = s.status; turn(s); return; }
        if (s.kind === 'wait' && s.queue > 0) think(false, 0);
      }).catch(function () { /* the next look tries again */ });
    }, WAIT_LOOK_MS);
  }

  // no bet was ready: one question, then what is going on and why the answer matters
  function drawQuestionCard(s) {
    var box = document.getElementById('bet');
    box.textContent = '';
    var q = s.question;
    box.appendChild(el('h1', null, q.ask));
    if (q.line) box.appendChild(el('p', 'why', q.line));
    var act = el('div', 'act answers');
    q.choices.forEach(function (c) {
      var b = el('button', 'choice', c.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        if (bet.busy) return;
        buzz();
        // typed words are read first, so a question back is explained and nothing is saved
        if (c.other) { typeHere(b, c.label, 60, function (text, field) { say(field, { text: text }); }); return; }
        answer(b, { choice: c.id });
      });
      if (c.other) b.classList.add('other');
      act.appendChild(b);
    });
    // a quiet line under the answers, empty until an answer does not go through
    act.appendChild(el('div', 'links'));
    box.appendChild(act);
    // its own something else box is the one place to type
    if (!q.choices.some(function (c) { return c.other; })) box.appendChild(sayBox());
  }

  // ---- answering in place: the eyes stay in one spot ----------------------------
  // A tapped answer, or the words typed in its place, holds that spot as
  // chosen for HOLD_MS while the rest of the card dims and stays put. The
  // next card is asked for during the hold and turns in once it is over.
  var HOLD_MS = 400;

  // a failed fetch reads like a refusal, so a hold never hangs
  function offline() { return { ok: false, http: 0 }; }

  // every answer row of the card dims but the one in use; no spot, none
  function dimOthers(spot) {
    var box = document.getElementById('bet');
    box.querySelectorAll('.act > *, .options > *, .sayline, :scope > .links').forEach(function (n) {
      n.classList.toggle('muted', Boolean(spot) && n !== spot && !n.contains(spot));
    });
  }

  // the spot holds as chosen and the card takes no taps; returns when it
  // started, which is also where the time to the next card counts from
  function hold(spot) {
    var box = document.getElementById('bet');
    dimOthers(spot);
    spot.classList.add('chosen');
    box.classList.add('holding');
    var input = spot.querySelector('input');
    if (input) { input.readOnly = true; input.blur(); }
    bet.busy = true;
    bet.armed = false;
    bet.tapAt = performance.now();
    document.body.removeAttribute('data-reveal-ms');
    return bet.tapAt;
  }

  // it did not go through: the card is as it was
  function unhold() {
    var box = document.getElementById('bet');
    box.classList.remove('holding');
    dimOthers(null);
    box.querySelectorAll('.chosen').forEach(function (n) { n.classList.remove('chosen'); });
    bet.busy = false;
  }

  // resolves once the hold that started at heldAt has run HOLD_MS
  function afterHold(heldAt) {
    var left = heldAt ? heldAt + HOLD_MS - performance.now() : 0;
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, left)); });
  }

  // The tapped button becomes the field at its own size and spot, with the
  // cursor already in it, and the other answers dim. Enter or send hands
  // the words to sent(text, field). Left empty, it turns back into the button.
  function typeHere(btn, placeholder, maxLength, sent) {
    var field = el('div', btn.classList.contains('choice') ? 'choice field' : 'field');
    // its exact height, to the subpixel, so nothing under it moves
    field.style.height = btn.getBoundingClientRect().height + 'px';
    var input = el('input');
    input.type = 'text';
    input.maxLength = maxLength;
    input.placeholder = placeholder;
    input.enterKeyHint = 'send';
    input.setAttribute('aria-label', placeholder);
    var send = el('button', 'send', 'send');
    send.type = 'button';
    var submit = function () {
      var text = input.value.trim();
      if (text && !bet.busy) sent(text, field);
    };
    // a press on send keeps the cursor in the field, so it never closes first
    send.addEventListener('mousedown', function (e) { e.preventDefault(); });
    send.addEventListener('click', function () { buzz(); submit(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { input.value = ''; input.blur(); }
    });
    input.addEventListener('blur', function () {
      if (input.value.trim() || field.classList.contains('chosen') || !field.isConnected) return;
      field.replaceWith(btn);
      dimOthers(null);
    });
    field.appendChild(input);
    field.appendChild(send);
    btn.replaceWith(field);
    dimOthers(field);
    input.focus();
  }

  // An answer to a question holds as chosen while it saves. If it does not
  // go through, the card comes back as it was, the words still in the
  // field, and why takes the hint's line under the answers.
  function answer(spot, body) {
    body.card = shownCard();
    var heldAt = hold(spot);
    api('/bet/answer', body).catch(offline).then(function (r) {
      if (r.ok) { think(false, heldAt); return; }
      unhold();
      var hint = document.getElementById('bet').querySelector('.act .links');
      if (hint) hint.textContent = r.message || 'that did not go through';
      var input = spot.querySelector('input');
      if (input) { input.readOnly = false; dimOthers(spot); input.focus(); }
    });
  }

  // the card the owner is looking at, named with every answer and every
  // word said, so the server acts on that card or on nothing
  function shownCard() { return bet.last && bet.last.id ? bet.last.id : ''; }

  // Words said on a card hold their spot as chosen while the server reads
  // them. An answer or an instruction brings the next card; a question
  // back or a second tap it needs turns in as the orb's reply, in the
  // title's spot. If it did not send, the words stay where they were.
  // One id per typed send: made when these words are first sent from this
  // spot, the same on every retry of them, and new when the words change,
  // so a send whose reply was lost is never sent twice. getRandomValues
  // works on the plain http of the wifi link, where randomUUID does not.
  function sendId(spot, text) {
    if (spot.sendText !== text) {
      var n = new Uint32Array(2);
      crypto.getRandomValues(n);
      spot.sendText = text;
      spot.sendId = ('000000' + n[0].toString(36)).slice(-7) + ('000000' + n[1].toString(36)).slice(-7);
    }
    return spot.sendId;
  }

  // while the words are read, one quiet ellipsis in the held spot: where
  // send was in a box, or after a tapped reply. Nowhere else.
  function reading(spot) {
    var send = spot.querySelector('.send');
    if (send) { send.textContent = '\u2026'; send.classList.add('reading'); return; }
    spot.appendChild(el('span', 'reading', ' \u2026'));
  }
  function doneReading(spot) {
    var send = spot.querySelector('.send.reading');
    if (send) { send.textContent = 'send'; send.classList.remove('reading'); }
    var dots = spot.querySelector('span.reading');
    if (dots) dots.remove();
  }

  function say(spot, body) {
    body.card = shownCard();
    body.send = sendId(spot, body.text);
    var heldAt = hold(spot);
    reading(spot);
    api('/bet/say', body).catch(offline).then(function (r) {
      if (r.ok && !r.stay) { think(false, heldAt); return; }
      if (!r.ok && r.reason !== 'needs_confirm') { unsent(spot, r.message || 'that did not send. tap send to try again'); return; }
      afterHold(heldAt).then(function () { crossfade(function () { drawReply(r, body.text); }); });
    });
  }

  // It did not send: the card is as it was, the words still in the box with
  // the cursor in it, and one short line under it says why, so Enter (or
  // the same tap) tries again. Left empty, the box turns back into the
  // button and the line goes with it.
  function unsent(spot, why) {
    doneReading(spot);
    unhold();
    var note = spot.nextElementSibling;
    var input = spot.querySelector('input');
    if (!note || !note.classList.contains('unsent')) {
      note = el('p', 'links unsent');
      spot.after(note);
      if (input) input.addEventListener('blur', function () { if (!spot.isConnected) note.remove(); });
    }
    note.textContent = why;
    if (input) { input.readOnly = false; dimOthers(spot); input.focus(); }
  }

  // one reply to tap: it holds as chosen and is said
  function sayChoice(label, body) {
    var b = el('button', 'choice', label);
    b.type = 'button';
    b.addEventListener('click', function () {
      if (bet.busy) return;
      buzz();
      say(b, body);
    });
    return b;
  }

  // the orb's reply is the title, with the card's own answer right under it
  // (do it, yes, nice, or the answers), then up to three suggested replies;
  // starting a member who is not running takes one more tap, or it is kept
  // as a note. The say line takes anything else.
  function drawReply(r, said) {
    var box = document.getElementById('bet');
    // a reply never takes the card's own answer away: the card is drawn
    // once more, and its row is kept, buttons and all
    var own = null;
    if (bet.last) { drawBetCard(bet.last); own = box.querySelector(':scope > .act, :scope > .options'); }
    box.textContent = '';
    bet.drawn = null;
    var title = el('h1', null, r.stay ? r.reply : (r.message || 'that did not go through'));
    box.appendChild(title);
    // more than one line reads at the body size, in the same spot
    var lines = document.createRange();
    lines.selectNodeContents(title);
    if (lines.getClientRects().length > 1) title.classList.add('said');
    if (own) box.appendChild(own);
    var act = el('div', 'act answers');
    var have = own ? Array.prototype.map.call(own.querySelectorAll('button'), function (b) { return b.textContent.trim().toLowerCase(); }) : [];
    if (r.stay) (r.suggestions || []).forEach(function (sug) {
      if (have.indexOf(String(sug).trim().toLowerCase()) < 0) act.appendChild(sayChoice(sug, { text: sug }));
    });
    if (r.reason === 'needs_confirm') {
      act.appendChild(sayChoice('start it', { text: said, confirm: true }));
      act.appendChild(sayChoice('keep it as a note instead', { text: said, note: true }));
    }
    box.appendChild(act);
    if (!own || !own.querySelector('.other')) box.appendChild(sayBox());
  }

  // the owner's own number, once a week: one box and one tap to save
  function drawReportCard(s) {
    var box = document.getElementById('bet');
    box.textContent = '';
    box.appendChild(el('h1', null, s.report.what));
    box.appendChild(el('p', 'why', s.report.why));
    var act = el('div', 'act answers');
    var input = el('input', 'say');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', s.report.what);
    var save = el('button', 'pill', 'save');
    save.type = 'button';
    var go = function () {
      if (!String(input.value).trim()) return;
      save.disabled = true;
      api('/bet/report', { value: input.value }).then(function (r) {
        if (r.ok) { moveOn(r.ack); return; }
        save.disabled = false;
        input.value = '';
        input.placeholder = r.message || 'that did not go through';
      });
    };
    save.addEventListener('click', go);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    act.appendChild(input);
    act.appendChild(save);
    // a quiet way out: moves on, saves nothing, and is not asked again today
    var links = el('div', 'links');
    var later = el('button', null, 'not now');
    later.type = 'button';
    later.addEventListener('click', function () { if (bet.busy) return; buzz(); think(false, 0); });
    links.appendChild(later);
    act.appendChild(links);
    box.appendChild(act);
    box.appendChild(sayBox());
  }

  // A conversation in one box. While the words are read the reply spot shows
  // a quiet ellipsis; a question back is answered in place, with the turns so
  // far above it and up to three suggested replies to tap. Starting a member
  // who is not running takes a second tap, or it is kept as a note.
  // post(body) sends it; done(ack) runs when something real came of it.
  function convo(post, done, placeholder) {
    var wrap = el('div', 'links sayline');
    var thread = el('div', 'thread');
    var reply = el('p', 'why reply');
    reply.hidden = true;
    var input = el('input', 'say');
    input.type = 'text';
    input.maxLength = 280;
    input.setAttribute('aria-label', placeholder);
    input.placeholder = placeholder;
    var send = el('button', 'pill', 'send');
    send.type = 'button';
    var extra = el('div', 'links');
    var pending = null;
    // an armed second tap belongs to the words it was asked about: any edit clears it
    function disarm() {
      pending = null;
      send.textContent = 'send';
      send.className = 'pill';
      extra.textContent = '';
      reply.textContent = '';
      reply.hidden = true;
    }
    function drawThread(turns) {
      thread.textContent = '';
      turns.forEach(function (t) { thread.appendChild(el('p', 'turn ' + (t.who === 'owner' ? 'you' : 'orb'), t.text)); });
    }
    function go(more, said) {
      var text = said || input.value.trim();
      if (!text) return;
      send.disabled = true;
      reply.hidden = false;
      reply.textContent = '\u2026';
      extra.textContent = '';
      // the same words carry the same id on every try, so a retry never sends twice
      var body = { text: text, send: sendId(wrap, text) };
      if (more) Object.keys(more).forEach(function (k) { body[k] = more[k]; });
      post(body).catch(offline).then(function (r) {
        if (r.ok && !r.stay) { done(r.ack); return; }
        send.disabled = false;
        if (r.stay) { reply.textContent = r.reply;
          input.value = '';
          drawThread(r.thread.slice(0, -1));
          (r.suggestions || []).forEach(function (sug) {
            var b = el('button', 'quiet', sug);
            b.type = 'button';
            b.addEventListener('click', function () { buzz(); go(null, sug); });
            extra.appendChild(b);
          });
          return;
        }
        if (r.reason === 'needs_confirm') {
          pending = text;
          reply.textContent = r.message;
          send.textContent = 'tap again';
          send.className = 'pill armed';
          var keep = el('button', 'quiet', 'keep it as a note instead');
          keep.type = 'button';
          keep.addEventListener('click', function () { disarm(); go({ note: true }); });
          extra.appendChild(keep);
          return;
        }
        // it did not send: the words are in the box, send works again, and
        // one short line says so
        if (said && !input.value) input.value = said;
        reply.textContent = r.message || 'that did not send. tap send to try again';
        input.focus();
      });
    }
    send.addEventListener('click', function () {
      buzz();
      if (pending) { disarm(); go({ confirm: true }); return; }
      go();
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send.click(); } });
    input.addEventListener('input', function () { if (pending) disarm(); });
    wrap.appendChild(thread);
    wrap.appendChild(reply);
    wrap.appendChild(input);
    wrap.appendChild(send);
    wrap.appendChild(extra);
    return wrap;
  }

  // a quiet line under every card: tap it and the line becomes the box, in
  // its own spot. on a question it is the answer, on an idea a note to
  // rework it, on a yes or a finished job a word to that member; the server
  // reads it first, and a question back is answered
  function sayBox() {
    var wrap = el('div', 'links sayline');
    var open = el('button', 'quiet', 'or say something');
    open.type = 'button';
    open.addEventListener('click', function () {
      if (bet.busy) return;
      typeHere(open, 'say something', 280, function (text, field) { say(field, { text: text }); });
    });
    wrap.appendChild(open);
    return wrap;
  }

  // two or three ideas side by side: one tap picks one and opens its full card
  function drawChoiceCard(s) {
    var box = document.getElementById('bet');
    box.textContent = '';
    box.appendChild(el('h1', null, 'which one next?'));
    var list = el('div', 'options');
    s.choice.options.forEach(function (o) {
      var b = el('button', 'option');
      b.type = 'button';
      b.appendChild(el('span', 't', o.title));
      b.appendChild(el('span', 'w', o.why));
      b.addEventListener('click', function () {
        if (bet.busy) return;
        buzz();
        var heldAt = hold(b);
        api('/bet/pick', { id: o.id }).then(function (r) {
          if (r.http === 200 && r.bet) { afterHold(heldAt).then(function () { turn(r); }); return; }
          think(false, heldAt);
        }, function () { think(false, heldAt); });
      });
      list.appendChild(b);
    });
    box.appendChild(list);
    box.appendChild(sayBox());
  }

  function drawBetCard(s) {
    if (s.kind === 'report') { drawReportCard(s); return; }
    if (s.kind === 'choice') { drawChoiceCard(s); return; }
    if (s.kind === 'question') { drawQuestionCard(s); return; }
    if (s.kind && s.kind !== 'bet') { drawJobCard(s); return; }
    var box = document.getElementById('bet');
    box.textContent = '';
    var b = s.bet;
    box.appendChild(el('h1', null, b.title));
    // why it matters: what is going on and what we expect, in the same big type
    box.appendChild(el('p', 'why', [b.why_now, b.expect].map(sentence).join(' ')));
    if (s.mission) { box.appendChild(el('p', 'mission', s.mission.line)); return; }
    if (s.status === 'starting') { box.appendChild(el('p', 'mission', 'starting now')); return; }
    var act = el('div', 'act');
    var go = el('button', 'pill' + (bet.armed ? ' armed' : ''), bet.armed ? 'tap again to start' : 'do it');
    go.type = 'button';
    go.setAttribute('aria-label', bet.armed ? 'tap again to start the team on this idea' : 'do it. starts the team on the steps; your yes steps wait for you');
    go.addEventListener('click', function () {
      buzz();
      if (!bet.armed) {
        bet.armed = true; drawBetCard(s);
        setTimeout(function () { if (bet.armed) { bet.armed = false; if (bet.last) drawBetCard(bet.last); } }, 5000);
        return;
      }
      bet.armed = false;
      s.status = 'starting'; s.unstarted = null; drawBetCard(s);
      api('/bet/do', { confirm: true }).catch(offline).then(function (r) {
        if (!r || !r.ok) {
          // it did not get going: the card comes back as it was, do it and
          // all, with one line why, and the page follows this card again
          s.status = 'ready';
          s.unstarted = (r && r.message) || 'that did not start. tap do it to try again';
          bet.drawn = s.id;
          drawBetCard(s);
          refresh();
          return;
        }
        loadBet(); refresh();
        setTimeout(function () { tapOrb(false); }, AFTER_MS);
      });
    });
    act.appendChild(go);
    if (s.unstarted) act.appendChild(el('p', 'links unsent', s.unstarted));
    var links = el('div', 'links');
    var sharp = el('button', null, 'sharper idea');
    sharp.type = 'button';
    sharp.addEventListener('click', function () { tapOrb(true); });
    var skip = el('button', null, 'not now');
    skip.type = 'button';
    skip.addEventListener('click', function () {
      buzz();
      api('/bet/skip', {}).then(function () {
        dissolve(function () { bet.status = 'skipped'; line.set('not now. tap when you want another', false); });
      });
    });
    links.appendChild(sharp);
    links.appendChild(document.createTextNode(' · '));
    links.appendChild(skip);
    act.appendChild(links);
    box.appendChild(act);
    box.appendChild(sayBox());
  }

  // the time from the tap to the card fully on screen, kept on the page so
  // the speed can be measured
  function measured() {
    if (bet.tapAt) document.body.setAttribute('data-reveal-ms', String(Math.round(performance.now() - bet.tapAt)));
    bet.tapAt = 0;
  }

  function showCard(s, animate, fast) {
    var box = document.getElementById('bet');
    bet.last = s;
    bet.drawn = s.id;
    drawBetCard(s);
    document.body.classList.add('has-card');
    box.hidden = false;
    box.classList.remove('leave', 'holding');
    box.classList.toggle('quick', Boolean(fast));
    if (!animate) { box.classList.add('up'); measured(); return; }
    box.classList.remove('up');
    var done = function (e) { if (e.propertyName === 'opacity') { box.removeEventListener('transitionend', done); measured(); } };
    box.addEventListener('transitionend', done);
    void box.offsetWidth;
    requestAnimationFrame(function () { box.classList.add('up'); });
  }

  // where the sphere sits once the card is gone, read before anything moves,
  // in page coordinates (the screen's once the page is back at the top)
  function sphereSpot() {
    var box = document.getElementById('bet');
    var y0 = window.scrollY, was = box.hidden;
    document.body.classList.remove('has-card');
    box.hidden = true;
    var r = document.getElementById('orb').getBoundingClientRect();
    var spot = { x: r.left + r.width / 2, y: r.top + window.scrollY + r.height / 2 };
    document.body.classList.add('has-card');
    box.hidden = was;
    if (window.scrollY !== y0) window.scrollTo(0, y0);
    return spot;
  }

  // the card fades out in place while the small orb glides down and becomes
  // the sphere again; the card leaves the page once it has faded
  function dissolve(then) {
    var box = document.getElementById('bet');
    var to = sphereSpot();
    box.classList.remove('quick', 'up');
    box.classList.add('leave');
    var swap = function () {
      box.style.minHeight = '';
      box.hidden = true;
      box.classList.remove('leave');
      document.body.classList.remove('has-card');
      window.scrollTo(0, 0);
    };
    if (reduced) { setTimeout(function () { orb.melt(then, to, swap); }, orb.leaveMs); return; }
    orb.melt(then, to, swap);
  }

  // what the page does with the server's answer once the sphere is ready.
  // Every tap comes back with a card, so the orb plays straight into it.
  function reveal(s, fast) {
    bet.status = s.status;
    if ((s.bet || s.job || s.question || s.choice || s.report) && (s.status === 'ready' || s.status === 'started' || s.status === 'starting')) {
      line.set('', false);
      orb.play(function (phase) { if (phase === 'settled') { bet.busy = false; showCard(s, true, fast); } }, fast);
      return;
    }
    bet.busy = false;
    orb.relax();
    line.set('tap to think', false);
  }

  function isCard(s) {
    return Boolean((s.bet || s.job || s.question || s.choice || s.report) && (s.status === 'ready' || s.status === 'started' || s.status === 'starting'));
  }

  // Card to card: a crossfade in place. The small orb stays where it is.
  // A still copy of the old card fades over the box while the new card,
  // drawn under it, fades in from DRIFT below over TURN_IN_MS, starting
  // 80ms in, so its title lands where the old title was. The box eases to
  // its new height. No layout jump.
  var TURN_IN_MS = 320, DRIFT = 4;
  function turn(s) {
    crossfade(function () { bet.last = s; bet.drawn = s.id; drawBetCard(s); });
  }

  // draw() puts the next card in the box
  function crossfade(draw) {
    var box = document.getElementById('bet');
    box.classList.remove('holding');
    turnInPlace(box, draw, function () { bet.busy = false; measured(); });
  }

  // one card turns into the next in its own spot: a still copy of the old
  // one fades over it while the new one drifts in, and the box eases to
  // the new height. after() runs once it is at rest.
  function turnInPlace(box, draw, after) {
    if (reduced) { box.style.minHeight = ''; draw(); after(); return; }
    var from = box.offsetHeight;
    box.style.height = from + 'px';
    box.style.minHeight = '';
    var ghost = box.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.classList.remove('quick', 'turning', 'turn-in');
    ghost.classList.add('up', 'ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    var r = box.getBoundingClientRect(), p = box.offsetParent.getBoundingClientRect();
    ghost.style.top = (r.top - p.top) + 'px';
    ghost.style.left = (r.left - p.left) + 'px';
    ghost.style.width = r.width + 'px';
    box.after(ghost);
    box.classList.remove('quick', 'turning');
    draw();
    box.style.height = 'auto';
    var to = box.offsetHeight;
    box.style.height = from + 'px';
    box.classList.add('turn-in');
    void box.offsetHeight;
    box.classList.add('turning');
    box.classList.remove('turn-in');
    box.style.height = to + 'px';
    ghost.classList.add('gone');
    setTimeout(function () {
      ghost.remove();
      box.classList.remove('turning');
      box.style.height = '';
      after();
    }, 80 + TURN_IN_MS + 20);
  }

  // one tap: buzz at once and ask the server for the next card. From the
  // sphere the orb plays into it; with a card up it is one calm turn.
  function tapOrb(sharper) {
    if (bet.busy) return;
    buzz();
    think(sharper, 0);
  }

  // Ask for the next card. heldAt: an answer has held as chosen since then,
  // so the card is asked for during the hold and turns in once it is over,
  // and the time to the card counts from that answer.
  // extra.later: not now on a yes card, so it goes to the back.
  function think(sharper, heldAt, extra) {
    bet.busy = true;
    bet.armed = false;
    bet.tapAt = heldAt || performance.now();
    document.body.removeAttribute('data-reveal-ms');
    var onCard = document.body.classList.contains('has-card');
    var failed = function () {
      bet.busy = false;
      document.getElementById('bet').classList.remove('holding');
      orb.relax();
      line.set('that did not go through. tap to try again', true);
    };
    Promise.all([api('/bet/think', { sharper: Boolean(sharper), later: Boolean(extra && extra.later) }), afterHold(heldAt)]).then(function (both) {
      var s = both[0];
      if (s.http !== 200) { failed(); return; }
      bet.status = s.status;
      if (onCard && isCard(s)) { turn(s); return; }
      if (onCard) { dissolve(function () { reveal(s, true); }); return; }
      reveal(s, true);
    }, failed);
  }

  function loadBet() {
    return api('/bet').then(function (s) {
      if (s.http !== 200) return;
      bet.status = s.status;
      if ((s.bet || s.job || s.question || s.choice || s.report) && bet.drawn === s.id) { bet.last = s; drawBetCard(s); if (s.status === 'starting') poll(); }
    });
  }

  function poll() {
    if (bet.polling) return;
    bet.polling = true;
    setTimeout(function () { bet.polling = false; loadBet(); }, 400);
  }

  // first look: a card already on screen shows settled, anything else is the sphere
  function firstLook() {
    api('/bet').then(function (s) {
      if (s.http !== 200) return;
      bet.status = s.status;
      if ((s.bet || s.job || s.question || s.choice || s.report) && (s.status === 'ready' || s.status === 'started' || s.status === 'starting')) {
        orb.settled();
        showCard(s, false);
        return;
      }
      line.set(s.status === 'skipped' ? 'not now. tap when you want another' : 'tap to think', false);
    });
  }

  // The small orb on a card goes back to the big dotted orb, the same calm
  // way the page goes home before a new idea: the card fades, the small orb
  // glides down and the dots form again, idle under the pointer. The card
  // stays where it was on the server, so nothing is passed yet.
  function goHome() {
    if (bet.busy) return;
    buzz();
    bet.busy = true;
    bet.armed = false;
    dissolve(function () { bet.busy = false; line.set('tap to think', false); });
  }

  // The big orb: the next idea, with the spiral, as on page open. An idea
  // that landed behind the calm line is the next one, so it is never passed.
  function tapBig() { tapOrb(false); }

  function tapSmallOrb() {
    if (document.body.classList.contains('has-card')) goHome(); else tapBig();
  }

  var canvas = document.getElementById('orb');
  var lavaTap = document.getElementById('lava');
  [[canvas, tapBig], [lavaTap, tapSmallOrb]].forEach(function (pair) {
    pair[0].addEventListener('click', pair[1]);
    pair[0].addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pair[1](); }
    });
  });

  // ---- the team: who is on what, from real state, and a word to any of them ----

  var teamBox = document.getElementById('team');
  var teamInner = document.getElementById('team-inner');
  // the way back from what is on top: the team closes, a talk card goes back to the team
  var teamBack = null;

  // every redraw of the team box makes a new view; an answer that comes
  // back for an older view is dropped (a closed box is hidden, and the next
  // open is a new view)
  var teamView = 0;

  function closeTeam() { teamBox.hidden = true; }

  function teamHead(title) {
    teamView += 1;
    teamInner.textContent = '';
    teamInner.className = 'inner';
    teamBack = closeTeam;
    var head = el('div', 'head');
    head.appendChild(el('h1', null, title));
    var close = el('button', 'quiet', 'close');
    close.type = 'button';
    close.addEventListener('click', closeTeam);
    head.appendChild(close);
    teamInner.appendChild(head);
  }

  function openTeam() {
    teamBox.hidden = false;
    teamHead('the team');
    var view = teamView;
    api('/bet/team').then(function (s) { if (s.http === 200 && view === teamView) drawTeam(s.rows || []); });
  }

  // one row per member, five columns; a tap anywhere on a row opens its talk
  // card, and the name is a button so the keyboard reaches it too
  var TEAM_COLUMNS = ['member', 'role', 'ovr', 'engine', 'status'];
  var TEAM_CELLS = ['who', 'role', 'ovr', 'eng', 'st'];

  // note is the one plain line a swap just said, shown over the table
  function drawTeam(rows, note) {
    teamHead('the team');
    if (note) teamInner.appendChild(el('p', 'done', note));
    if (!rows.length) { teamInner.appendChild(el('p', 'why', 'nobody is on the team yet.')); return; }
    teamInner.className = 'inner wide';
    deckEntry(rows);
    var grid = el('div', 'grid');
    var table = el('table', 'roster');
    var head = el('tr');
    TEAM_COLUMNS.forEach(function (name, i) { head.appendChild(el('th', TEAM_CELLS[i], name)).scope = 'col'; });
    table.appendChild(el('thead')).appendChild(head);
    var body = table.appendChild(el('tbody'));
    rows.forEach(function (r) {
      var tr = el('tr', 'row');
      var who = el('td', 'who');
      var open = who.appendChild(el('button', null, r.member));
      open.type = 'button';
      open.setAttribute('aria-label', 'talk to ' + r.member);
      tr.appendChild(who);
      tr.appendChild(el('td', 'role', r.role));
      tr.appendChild(el('td', 'ovr', r.ovr));
      // the engine cell is its own button: a tap opens the engine card, not the talk card
      var eng = tr.appendChild(el('td', 'eng'));
      if (r.engine === 'person') eng.textContent = r.engine;
      else {
        var swap = eng.appendChild(el('button', null, r.engine));
        swap.type = 'button';
        swap.setAttribute('aria-label', 'change what ' + r.member + ' runs on');
        swap.addEventListener('click', function (e) { e.stopPropagation(); drawEngine(r); });
      }
      tr.appendChild(el('td', 'st ' + r.status.replace(/ /g, '-'), r.sentence));
      tr.addEventListener('click', function () { drawTalk(r); });
      body.appendChild(tr);
    });
    grid.appendChild(table);
    teamInner.appendChild(grid);
  }

  // the engine card: what the member runs on, who a swap is for, then every
  // model this machine offers by tool, the current one on top. One tap swaps
  // (the tap is the approval) and the team comes back with the new engine in
  // its row and one line saying what changed. Esc goes back to the team.
  function drawEngine(r) {
    teamHead(r.member);
    teamBack = openTeam;
    // this card's view and member: an answer for any other is not drawn, and
    // every swap button posts this member, never whoever is on screen later
    var view = teamView;
    var member = r.member;
    var mine = function (s) { return view === teamView && (!s || !s.member || s.member === member); };
    var said = teamInner.appendChild(el('p', 'why', member + ' runs on ' + r.engine + '.'));
    var back = el('button', 'quiet', 'back to the team');
    back.type = 'button';
    back.addEventListener('click', openTeam);
    var busy = false;
    api('/bet/engine', { member: member }).then(function (s) {
      if (!mine(s)) return;
      if (s.http !== 200 || !s.ok) { said.textContent = s.message || 'could not read the models on this machine.'; teamInner.appendChild(back); return; }
      said.textContent = s.line;
      var scope = 'member';
      var scopes = el('div', 'scopes');
      scopes.setAttribute('role', 'group');
      scopes.setAttribute('aria-label', 'who the swap is for');
      (s.scopes || []).forEach(function (sc) {
        var b = scopes.appendChild(el('button', sc.id === scope ? 'chosen' : null, sc.label));
        b.type = 'button';
        b.setAttribute('aria-pressed', sc.id === scope ? 'true' : 'false');
        b.addEventListener('click', function () {
          scope = sc.id;
          Array.prototype.forEach.call(scopes.children, function (x) { var on = x === b; x.classList.toggle('chosen', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
        });
      });
      if ((s.scopes || []).length > 1) teamInner.appendChild(scopes);
      (s.groups || []).forEach(function (g) {
        var box = teamInner.appendChild(el('section', 'models'));
        box.appendChild(el('h2', null, g.tool));
        g.models.forEach(function (m) {
          var b = box.appendChild(el('button', 'choice' + (m.current ? ' chosen' : '')));
          b.type = 'button';
          b.appendChild(el('span', 't', m.label));
          var w = m.current ? 'now' : m.record;
          if (w) b.appendChild(el('span', 'w', w));
          if (m.current) { b.disabled = true; return; }
          b.setAttribute('data-member', member);
          b.addEventListener('click', function () {
            if (busy || !mine()) return;
            busy = true;
            b.classList.add('chosen');
            api('/bet/swap', { member: b.getAttribute('data-member'), engine: m.engine, model: m.model, scope: scope }).then(function (out) {
              busy = false;
              if (!mine()) return;
              if (out.http === 200 && out.ok) { drawTeam(out.rows || [], out.ack); return; }
              b.classList.remove('chosen');
              said.textContent = out.message || 'that did not change. try again.';
            }, function () { busy = false; if (!mine()) return; b.classList.remove('chosen'); said.textContent = 'that did not reach the mac. try again.'; });
          });
        });
      });
      teamInner.appendChild(back);
    }, function () { if (!mine()) return; said.textContent = 'that did not reach the mac. try again.'; teamInner.appendChild(back); });
  }

  // a talk card: what the member is on, and a word to steer them
  function drawTalk(r) {
    teamHead(r.member);
    teamBack = openTeam;
    teamInner.appendChild(el('p', 'why', r.sentence + '.'));
    var talkBox = convo(function (body) { body.member = r.member; return api('/bet/steer', body); }, function (ack) {
      talkBox.replaceWith(el('p', 'mission', ack));
    }, 'tell ' + r.member + ' something');
    var back = el('button', 'quiet', 'back to the team');
    back.type = 'button';
    back.addEventListener('click', openTeam);
    teamInner.appendChild(talkBox);
    teamInner.appendChild(back);
  }

  // ---- the job deck: every running job is one card, the ones that need
  // the owner first. The arrows or a sideways swipe flip one card at a
  // time, and it turns in its own spot the way the main card does. Esc
  // goes back to talking. A card that needs the owner is that job's yes
  // card, and under the table one box talks to the job's member and keeps
  // the turns, even across flips.
  var deckCards = [];
  var deckColumns = [];
  var deckAt = 0;
  var deckTurning = false;
  var deckTalk = {};
  var DECK_LIVE = ['waiting for your yes', 'working', 'waiting to start'];

  // the way in from the team page, there only while a job is running
  function deckEntry(rows) {
    if (!rows.some(function (r) { return DECK_LIVE.indexOf(r.status) >= 0; })) return;
    var open = el('button', 'quiet', 'the jobs, one at a time');
    open.type = 'button';
    open.addEventListener('click', openDeck);
    teamInner.appendChild(open);
  }

  function openDeck() {
    teamBox.hidden = false;
    teamHead('the jobs');
    var waiting = teamInner.appendChild(el('div', 'deckspot'));
    api('/bet/jobs').then(function (s) {
      // the owner moved on while it loaded: nothing is drawn over it
      if (s.http !== 200 || !waiting.isConnected || teamBox.hidden) return;
      deckCards = s.cards || [];
      deckColumns = s.columns || [];
      if (!deckCards.length) { openTeam(); return; }
      deckAt = Math.min(deckAt, deckCards.length - 1);
      drawDeck();
    });
  }

  function drawDeck() {
    teamHead('the jobs');
    teamInner.className = 'inner wide';
    var spot = teamInner.appendChild(el('div', 'deckspot'));
    // a card like the main one, so it turns the same way
    var card = spot.appendChild(el('article', 'bet'));
    card.classList.add('up', 'deckcard');
    fillDeckCard(card);
    var startX = null, startY = null;
    card.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
    card.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX, dy = e.changedTouches[0].clientY - startY;
      startX = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) flipDeck(dx < 0 ? 1 : -1);
    });
    var bar = el('div', 'deckbar');
    if (deckCards.length > 1) {
      var prev = bar.appendChild(el('button', 'quiet', 'previous'));
      prev.type = 'button';
      prev.addEventListener('click', function () { flipDeck(-1); });
    }
    var whole = bar.appendChild(el('button', 'quiet', 'the whole team'));
    whole.type = 'button';
    whole.addEventListener('click', openTeam);
    if (deckCards.length > 1) {
      var next = bar.appendChild(el('button', 'quiet', 'next'));
      next.type = 'button';
      next.addEventListener('click', function () { flipDeck(1); });
    }
    teamInner.appendChild(bar);
  }

  // one job: its place in the deck, the yes card when it needs the owner,
  // the divided table, how long, and the talk box for its member
  function fillDeckCard(card) {
    var c = deckCards[deckAt];
    card.textContent = '';
    card.appendChild(el('span', 'count', 'job ' + (deckAt + 1) + ' of ' + deckCards.length));
    card.appendChild(el('span', 'label ' + c.label.replace(/ /g, '-'), c.label));
    if (c.yes) {
      card.appendChild(el('h1', null, c.yes.what));
      if (c.yes.why) card.appendChild(el('p', 'why', c.yes.why));
      var act = card.appendChild(el('div', 'act'));
      act.appendChild(yesPill(function () { return api('/bet/yes', { confirm: true, key: c.yes.key, job: c.job_id }); }, function (said, r) {
        if (r.ok || r.reason === 'gone') { c.yes = null; c.said = said; act.replaceWith(el('p', 'mission', said)); return; }
        c.unsent = said;
        fillDeckCard(card);
      }));
      if (c.unsent) act.appendChild(el('p', 'links unsent', c.unsent));
    } else if (c.said) card.appendChild(el('p', 'mission', c.said));
    var table = el('table', 'jobs');
    var head = el('tr');
    deckColumns.forEach(function (k) { head.appendChild(el('th', k, k)).scope = 'col'; });
    table.appendChild(el('thead')).appendChild(head);
    var body = table.appendChild(el('tbody'));
    c.rows.forEach(function (r) {
      var tr = body.appendChild(el('tr'));
      deckColumns.forEach(function (k) { tr.appendChild(el('td', k, r[k] || '')); });
    });
    card.appendChild(el('div', 'jobs-wrap')).appendChild(table);
    if (c.time) card.appendChild(el('span', 'time', c.time));
    card.appendChild(deckTalk[c.member] || (deckTalk[c.member] = talkBox(c.member)));
  }

  // one talk box per member, made once and kept, so the turns and any
  // words being typed are still there after a flip; what came of a word
  // stays above a fresh box
  function talkBox(member) {
    var holder = el('div', 'jobtalk');
    var fresh = function () {
      var box = convo(function (body) { body.member = member; return api('/bet/steer', body); }, function (ack) {
        holder.insertBefore(el('p', 'mission', ack), box);
        box.replaceWith(fresh());
      }, 'talk to this job');
      return box;
    };
    holder.appendChild(fresh());
    return holder;
  }

  function flipDeck(step) {
    var card = teamInner.querySelector('.deckcard');
    if (!card || deckTurning || deckCards.length < 2) return;
    deckAt = (deckAt + step + deckCards.length) % deckCards.length;
    deckTurning = true;
    turnInPlace(card, function () { fillDeckCard(card); }, function () { deckTurning = false; });
  }

  // the arrows flip the deck, unless the owner is typing in a box
  document.addEventListener('keydown', function (e) {
    var step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!step || e.isComposing || teamBox.hidden || !teamInner.querySelector('.deckcard')) return;
    var field = document.activeElement;
    if (field && (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    flipDeck(step);
  });

  document.getElementById('working').addEventListener('click', openTeam);
  document.getElementById('needs').addEventListener('click', openDeck);

  // Esc on the team page steps back one layer, the way its own buttons do:
  // words being typed are cancelled and the cursor leaves first, then the
  // talk card goes back to the team, then the team closes to the card.
  // On the card itself it does nothing. It listens on the way down, so the
  // focused element is still the field the key was pressed in.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.isComposing || teamBox.hidden) return;
    e.preventDefault();
    var field = document.activeElement;
    if (field && (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA')) {
      field.value = '';
      // the field's own input listener drops a second tap armed for those words
      field.dispatchEvent(new Event('input'));
      field.blur();
      return;
    }
    teamBack();
  }, true);

  // the footer: how many members are really working, or the team when none are
  function drawWorking(n) {
    var btn = document.getElementById('working');
    btn.textContent = n ? n + ' working' : 'the team';
  }

  function refresh() {
    return api('/bet').then(function (s) {
      if (s.http !== 200) { line.set('this link stopped working. start gm phone again on the mac.', true); return; }
      drawWorking(s.team_working || 0);
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
