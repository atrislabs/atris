'use strict';

// The one page gm phone serves. Plain html, css, and vanilla js, no build
// step. Every piece of text from the task list goes in with textContent,
// never as html. The nonce matches the page's content security policy.
//
// One theme, the homepage letter's (atrisos-web LetterHome.tsx, dark values
// from app/config/theme-css.ts .dark): the
// brand colors, the letter serif, and the lava orb's amber as the only
// accent. The orb is a port of the landing orb (StippleOrb.tsx, LavaOrb.tsx,
// orb.module.css, LetterOrb.tsx): the same dots, colors, and easing. It sits
// in the middle of the screen and is the button. Its spiral is driven by the
// bet's real progress events, not a timer, and once the card is up nothing
// on the page moves. The decisions only the owner can make sit behind one
// quiet link at the bottom.

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
.stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; touch-action: manipulation; cursor: pointer; }
.stage canvas:focus-visible { outline-offset: -8%; }
.line {
  min-height: 3em; margin: 4px 0 0; max-width: 22em; text-align: center;
  color: var(--text-3); font-size: 17px; line-height: 1.5; letter-spacing: -0.005em;
  opacity: 1; transition: opacity 0.28s ease;
}
.line.out { opacity: 0; }
.line.bad { color: var(--text-2); }
.foot { position: absolute; left: 0; right: 0; bottom: max(20px, env(safe-area-inset-bottom)); text-align: center; }
.quiet { color: var(--text-3); font-size: 15px; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; }

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
.lava.still .tx, .lava.still .ty, .lava.still .blob { animation-play-state: paused; }
@keyframes sine-x { 0%, 100% { transform: translate3d(calc(var(--amp) * -1), 0, 0); } 50% { transform: translate3d(var(--amp), 0, 0); } }
@keyframes sine-y { 0%, 100% { transform: translate3d(0, calc(var(--amp) * -1), 0); } 50% { transform: translate3d(0, var(--amp), 0); } }
@keyframes spin { from { transform: rotate(var(--rot0, 0deg)); } to { transform: rotate(calc(var(--rot0, 0deg) + 360deg)); } }

/* ---- the card: same dark page, the lava orb small on top ---- */
body.has-card .screen { justify-content: flex-start; padding-top: calc(max(24px, env(safe-area-inset-top)) + 96px); }
body.has-card .stage, body.has-card .line { display: none; }
body.has-card .foot { position: static; margin-top: 40px; }
.bet { width: 100%; opacity: 0; transform: translateY(28px); transition: opacity 0.5s ease-out, transform 0.6s cubic-bezier(0.22, 1, 0.36, 1); }
.bet.up { opacity: 1; transform: none; }
.bet h1 { margin: 0; font-size: clamp(26px, 7vw, 34px); line-height: 1.12; font-weight: 700; letter-spacing: -0.03em; text-align: left; }
.k { display: block; color: var(--text-3); font-size: 13px; letter-spacing: 0.02em; margin-bottom: 2px; }
.why { margin: 22px 0 0; color: var(--text-2); }
.terms { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 20px; margin: 22px 0 0; padding: 18px 0 0; border-top: 1px solid var(--line); }
.terms > div { color: var(--text-2); font-size: 16px; line-height: 1.45; }
.terms .wide { grid-column: 1 / -1; }
.steps { margin: 26px 0 0; padding: 18px 0 0; list-style: none; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 14px; counter-reset: step; }
.steps li { position: relative; padding-left: 30px; counter-increment: step; color: var(--text-2); font-size: 16px; line-height: 1.45; }
.steps li::before { content: counter(step); position: absolute; left: 0; top: 0; color: var(--text-3); font-variant-numeric: tabular-nums; }
.tag { display: inline-flex; align-items: center; gap: 5px; margin-right: 8px; font-size: 13px; color: var(--text-3); }
.tag.you { color: var(--amber); }
.tag svg { width: 11px; height: 11px; }
.act { margin: 32px 0 0; display: flex; flex-direction: column; align-items: center; gap: 18px; }
.pill {
  min-width: 12rem; height: 44px; padding: 0 28px; border-radius: 22px;
  background: var(--amber); color: var(--amber-ink); font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
}
.pill.armed { background: var(--text); color: var(--bg); }
.links { color: var(--text-3); font-size: 15px; }
.links button { color: var(--text-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; padding: 8px 4px; }
.mission { margin: 32px 0 0; padding: 16px 0 0; border-top: 1px solid var(--line); color: var(--text-2); text-align: center; }

/* ---- only you: the owner's decisions, same theme, opened from the bottom link ---- */
.sheet {
  position: fixed; inset: 0; z-index: 20; overflow-y: auto; background: var(--bg);
  padding: max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom));
}
.sheet .inner { max-width: 34rem; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
.sheet .head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.sheet .head h2 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
.strip { color: var(--text-2); font-size: 16px; }
.bar { height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; margin-top: 10px; }
.bar > div { height: 100%; background: var(--amber); width: 0; }
.card { border-top: 1px solid var(--line); padding-top: 20px; display: flex; flex-direction: column; gap: 14px; }
.count { color: var(--text-3); font-size: 13px; }
.say { font-size: 20px; line-height: 1.4; margin: 0; }
.choice { width: 100%; min-height: 52px; text-align: left; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line); color: var(--text); }
.choice .effect { display: block; font-size: 14px; color: var(--text-3); }
.choice.main { background: var(--amber); color: var(--amber-ink); border-color: var(--amber); font-weight: 600; }
.choice.main .effect { color: var(--amber-ink); opacity: 0.75; font-weight: 400; }
.choice.armed { background: var(--text); color: var(--bg); border-color: var(--text); }
.choice.armed .effect { color: var(--bg); opacity: 0.75; }
.choice.later { border: 0; min-height: 44px; text-align: center; color: var(--text-3); }
.job { border-top: 1px solid var(--line); padding-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.job .meta { color: var(--text-3); font-size: 14px; }
.row { display: flex; gap: 10px; }
.row .choice { text-align: center; }
.reply { color: var(--text-2); font-size: 16px; }
.live { color: var(--text-3); font-size: 14px; }
.toast {
  position: fixed; left: 16px; right: 16px; bottom: max(16px, env(safe-area-inset-bottom)); z-index: 30;
  background: var(--text); color: var(--bg); border-radius: 14px; padding: 10px 16px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.toast button { min-height: 44px; padding: 0 12px; color: var(--bg); text-decoration: underline; }

@media (prefers-reduced-motion: reduce) {
  .lava .tx, .lava .ty, .lava .blob { animation: none !important; }
  .bet, .line { transition: none; }
}
</style>
</head>
<body>
<main class="screen" id="screen">
  <div class="stage" id="stage">
    <canvas id="orb" tabindex="0" role="button" aria-label="the atris orb. tap to think of one new bet for the business"></canvas>
  </div>
  <p class="line" id="line" aria-live="polite">tap to think</p>
  <article class="bet" id="bet" hidden></article>
  <div class="foot" id="foot"><button type="button" class="quiet" id="open-only" hidden></button></div>
</main>
<div class="lava" id="lava" aria-hidden="true">
  <div class="tx" style-vars="15%,8.4s,-2.1s"><div class="ty" style-vars="12%,10.1s,-5.1s"><div class="blob b1" spin-vars="36s,0deg"></div></div></div>
  <div class="tx" style-vars="18%,12.6s,-7.2s"><div class="ty" style-vars="15%,7.2s,-4.7s"><div class="blob b2 rev" spin-vars="48s,45deg"></div></div></div>
  <div class="tx" style-vars="12%,7.2s,-6.4s"><div class="ty" style-vars="18%,10.1s,-9.9s"><div class="blob b3" spin-vars="57.6s,90deg"></div></div></div>
  <div class="core" id="lava-core"></div>
</div>
<section class="sheet" id="sheet" hidden aria-label="only you">
  <div class="inner">
    <div class="head"><h2>only you</h2><button type="button" class="quiet" id="close-only">done</button></div>
    <div><div class="strip" id="target">loading</div><div class="bar"><div id="bar"></div></div></div>
    <div id="main"></div>
    <div id="reply" class="reply" hidden></div>
    <div class="live" id="live"></div>
  </div>
</section>
<div class="toast" id="toast" hidden><span id="toast-text"></span><button id="toast-undo" type="button">undo</button></div>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get('t') || '';
  var last = null;
  var view = 'card';
  var armed = null;
  var pendingReply = null;
  var undoTimer = null;
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
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (j) { j.http = r.status; return j; }); });
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

  // ---- the orb (port of StippleOrb, tone dark) --------------------------------
  var orb = (function () {
    var canvas = document.getElementById('orb');
    var lava = document.getElementById('lava');
    var core = document.getElementById('lava-core');
    var ctx = canvas.getContext('2d');
    var SPRING = 0.07, DAMP = 0.8;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var count = window.innerWidth < 768 ? 5500 : 11000;
    var w = 0, h = 0, R = 0, cx = 0, cy = 0;
    var dots = [];
    var mode = 'idle';
    var angle = 0, swirl = 0;
    var pull = 0, pullTo = 0;
    var arrivedAt = -1;
    var raf = 0, lastT = 0;
    var onBorn = null;
    var light = { x: -0.5, y: -0.6 };
    var lz = Math.sqrt(1 - light.x * light.x - light.y * light.y);
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

    // the spiral starts from the whole sphere, even when the page opens
    // mid-thought and the dots have not spread out yet
    function snapshot() {
      var cosA = Math.cos(angle), sinA = Math.sin(angle);
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        d.bx = cx + (d.x * cosA + d.z * sinA) * R; d.by = cy + d.y * R;
        var len = Math.hypot(d.bx - cx, d.by - cy);
        // outer dots go first
        d.dl = (1 - Math.min(1, len / R)) * 0.28 + Math.random() * 0.05;
      }
    }

    function frame(now) {
      var dt = Math.min(0.05, (now - (lastT || now)) / 1000);
      lastT = now;
      ctx.clearRect(0, 0, w, h);
      if (!reduced && (mode === 'idle' || mode === 'forming')) angle += dt * 0.15;
      if (!reduced && mode !== 'idle' && mode !== 'forming') swirl += dt * 0.25;
      pull += (pullTo - pull) * (reduced ? 1 : 0.05);
      var cosA = Math.cos(angle), sinA = Math.sin(angle);
      var cosS = Math.cos(swirl), sinS = Math.sin(swirl);
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        var fade = 1, shrink = 1;
        var rx = d.x * cosA + d.z * sinA;
        var rz = -d.x * sinA + d.z * cosA;
        if (mode === 'idle' || mode === 'forming') {
          d.vx += (cx + rx * R - d.sx) * SPRING;
          d.vy += (cy + d.y * R - d.sy) * SPRING;
          d.vx *= DAMP; d.vy *= DAMP;
          d.sx += d.vx; d.sy += d.vy;
          if (reduced) { d.sx = cx + rx * R; d.sy = cy + d.y * R; }
        } else {
          // the pull: every dot spirals toward the centre as real progress arrives
          var t = Math.min(1, Math.max(0, (pull - d.dl) / 0.67));
          var e = ease(t);
          if (mode === 'thinking') e = Math.min(e, 0.78);
          var ox = (d.bx - cx) * (1 - e), oy = (d.by - cy) * (1 - e);
          var turn = e * 1.5;
          var px = ox * Math.cos(turn) - oy * Math.sin(turn);
          var py = ox * Math.sin(turn) + oy * Math.cos(turn);
          d.sx = cx + px * cosS - py * sinS;
          d.sy = cy + px * sinS + py * cosS;
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
      if (mode === 'born') {
        // where the dots land: one bright point, steady (it does not breathe)
        if (arrivedAt < 0 && pull > 0.995) arrivedAt = now;
        var arrived = arrivedAt < 0 ? Math.min(1, Math.max(0, (pull - 0.85) / 0.15)) : 1;
        if (arrived > 0) {
          var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 10 + 46 * arrived);
          g.addColorStop(0, 'rgba(255, 232, 170, ' + (0.9 * arrived).toFixed(3) + ')');
          g.addColorStop(0.35, 'rgba(251, 150, 44, ' + (0.4 * arrived).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(251, 130, 36, 0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(cx, cy, 10 + 46 * arrived, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255, 244, 214, ' + arrived.toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(cx, cy, 2 + 5 * arrived, 0, Math.PI * 2); ctx.fill();
        }
        if (arrivedAt >= 0 && now - arrivedAt > 250) { stop(); grow(false); return; }
      }
      if (reduced && mode !== 'born') { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }

    function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

    // where the lava orb rests: small, top centre of the page
    var REST = 64;
    function restPoint() { return { x: document.documentElement.clientWidth / 2, y: Math.max(24, (window.visualViewport ? 0 : 0)) + 24 + REST / 2 }; }

    // LetterOrb: the lava orb is born at the point and grows, then shrinks
    // and settles small at the top. After that nothing moves.
    function grow(instant) {
      var base = 280;
      var rect = canvas.getBoundingClientRect();
      var ox = rect.left + window.scrollX + cx, oy = rect.top + window.scrollY + cy;
      var from = 30 / base, peak = Math.min(220, R * 1.4) / base, rest = REST / base;
      var place = function (s, x, y) { lava.style.transform = 'translate(' + (x - base / 2) + 'px, ' + (y - base / 2) + 'px) scale(' + s + ')'; };
      lava.style.visibility = 'visible';
      lava.classList.remove('still', 'alive');
      if (!reduced && !instant) { void lava.offsetWidth; lava.classList.add('alive'); }
      var done = function () {
        var p = restPoint();
        place(rest, p.x, p.y);
        lava.style.opacity = '1';
        core.style.opacity = '0';
        lava.classList.add('still');
        if (onBorn) { var cb = onBorn; onBorn = null; cb(); }
      };
      if (reduced || instant) { done(); return; }
      var t0 = performance.now();
      var GROW_MS = 1050, SETTLE_MS = 800;
      var step = function (now) {
        var t = Math.min(1, (now - t0) / GROW_MS);
        place(from + (peak - from) * ease(t), ox, oy);
        lava.style.opacity = String(smooth(0.02, 0.22, t));
        core.style.opacity = String(1 - smooth(0.05, 0.4, t));
        if (t < 1) { requestAnimationFrame(step); return; }
        ctx.clearRect(0, 0, w, h);
        var s0 = performance.now();
        var p = restPoint();
        var settle = function (n2) {
          var u = ease(Math.min(1, (n2 - s0) / SETTLE_MS));
          place(peak + (rest - peak) * u, ox + (p.x - ox) * u, oy + (p.y - oy) * u);
          if (u < 1) requestAnimationFrame(settle); else done();
        };
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(step);
    }

    function reform() {
      // the orb puts itself back together from the centre
      lava.classList.remove('still', 'alive');
      lava.style.visibility = 'hidden';
      lava.style.opacity = '0';
      arrivedAt = -1;
      mode = 'idle';
      measure();
      for (var i = 0; i < dots.length; i++) { dots[i].sx = cx; dots[i].sy = cy; dots[i].vx = 0; dots[i].vy = 0; }
    }

    measure();
    seed();
    start();

    return {
      think: function () {
        if (mode === 'thinking' || mode === 'forming') return;
        var formed = mode === 'idle';
        if (!formed) reform();
        pull = 0; pullTo = 0;
        mode = 'forming';
        start();
        // a fresh orb re-forms from the centre first, then the spiral begins
        setTimeout(function () {
          if (mode !== 'forming') return;
          snapshot();
          pull = 0;
          mode = 'thinking';
          start();
        }, formed || reduced ? 0 : 700);
      },
      progress: function (p) {
        pullTo = Math.max(pullTo, 0.85 * Math.min(1, p));
        if (reduced) start();
      },
      // the bet is ready: finish the spiral, make the point, grow the lava
      finish: function (cb) {
        onBorn = cb;
        if (mode === 'forming' || mode === 'idle') snapshot();
        mode = 'born';
        pullTo = 1;
        if (reduced) { stop(); grow(true); return; }
        start();
      },
      // generation failed: the dots relax back to the sphere
      relax: function () {
        mode = 'idle';
        pullTo = 0; pull = 0;
        start();
      },
      // a bet is already up when the page loads: the settled orb, no motion
      settled: function () { stop(); onBorn = null; mode = 'born'; grow(true); },
      // the screen is showing the orb again (sharper idea, not now)
      show: function () { reform(); start(); },
      busy: function () { return mode === 'thinking' || mode === 'forming'; },
    };
  })();

  // ---- the bet ------------------------------------------------------------------
  var bet = { status: null, polling: false, armed: false, drawn: null };

  function lockIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    var body = document.createElementNS(ns, 'rect');
    body.setAttribute('x', '2'); body.setAttribute('y', '5.5'); body.setAttribute('width', '8'); body.setAttribute('height', '5.5'); body.setAttribute('rx', '1');
    body.setAttribute('fill', 'currentColor');
    var hoop = document.createElementNS(ns, 'path');
    hoop.setAttribute('d', 'M4 5.5V4a2 2 0 0 1 4 0v1.5');
    hoop.setAttribute('fill', 'none'); hoop.setAttribute('stroke', 'currentColor'); hoop.setAttribute('stroke-width', '1.3');
    svg.appendChild(hoop); svg.appendChild(body);
    return svg;
  }

  // real progress from the server's events: each source read, then the
  // words the model has written as it works
  function progressOf(events) {
    var p = 0;
    events.forEach(function (e) {
      if (e.kind === 'source' || e.kind === 'skip') p = Math.max(p, Math.min(0.4, p + 0.4 / 6));
      else if (e.kind === 'model') p = Math.max(p, 0.45);
      else if (e.kind === 'thinking') p = Math.max(p, 0.5 + 0.45 * (1 - Math.exp(-(Number(e.n) || 0) / 250)));
      else if (e.kind === 'check' || e.kind === 'done') p = 1;
    });
    return p;
  }

  // the newest event, in plain words for the one line under the orb
  function sayEvent(e) {
    if (!e) return 'reading what is true right now';
    if (e.kind === 'source') {
      if (e.key === 'now') return 'reading your notes';
      if (e.key === 'briefs') return 'reading the latest research';
      return e.line;
    }
    if (e.kind === 'skip') return 'reading what is true right now';
    if (e.kind === 'model') return e.line.indexOf('again') >= 0 ? 'asking again, sharper' : 'thinking of one new bet';
    if (e.kind === 'thinking') return e.line;
    if (e.kind === 'reject') return 'the first idea did not hold up, asking again';
    if (e.kind === 'check' || e.kind === 'done') return 'got one';
    return e.line;
  }

  function failLine(error) {
    var e = String(error || '');
    if (/longer than/.test(e)) return 'the thinking took too long. tap to try again';
    if (/could not start|exited with code|empty answer|the model said/.test(e)) return 'could not reach the thinking model. tap to try again';
    return 'couldn\\'t land on a good bet. tap to try again';
  }

  function drawBetCard(s) {
    var box = document.getElementById('bet');
    box.textContent = '';
    var b = s.bet;
    box.appendChild(el('h1', null, b.title));
    var why = el('p', 'why');
    why.appendChild(el('span', 'k', 'why now'));
    why.appendChild(document.createTextNode(b.why_now));
    box.appendChild(why);
    var terms = el('div', 'terms');
    [['expect', b.expect, 'wide'], ['check', b.check_date + ', ' + b.metric_source], ['cost', b.cost]].forEach(function (t) {
      var d = el('div', t[2] || null);
      d.appendChild(el('span', 'k', t[0]));
      d.appendChild(document.createTextNode(t[1]));
      terms.appendChild(d);
    });
    box.appendChild(terms);
    var ol = el('ol', 'steps');
    b.steps.forEach(function (st) {
      var li = el('li');
      var tag = el('span', 'tag ' + (st.who === 'you' ? 'you' : 'team'));
      if (st.who === 'you') tag.appendChild(lockIcon());
      tag.appendChild(document.createTextNode(st.who === 'you' ? 'your yes' : 'team'));
      li.appendChild(tag);
      li.appendChild(document.createTextNode(st.text));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    if (s.mission) { box.appendChild(el('p', 'mission', s.mission.line)); return; }
    if (s.status === 'starting') { box.appendChild(el('p', 'mission', 'starting the mission')); return; }
    var act = el('div', 'act');
    var go = el('button', 'pill' + (bet.armed ? ' armed' : ''), bet.armed ? 'tap again to start' : 'do it');
    go.type = 'button';
    go.setAttribute('aria-label', bet.armed ? 'tap again to start the team on this bet' : 'do it. starts the team on the steps; your yes steps wait for you');
    go.addEventListener('click', function () {
      if (!bet.armed) {
        bet.armed = true; drawBetCard(s);
        setTimeout(function () { if (bet.armed) { bet.armed = false; if (bet.last) drawBetCard(bet.last); } }, 5000);
        return;
      }
      bet.armed = false;
      s.status = 'starting'; drawBetCard(s);
      api('/bet/do', { confirm: true }).then(function () { loadBet(); refresh(); });
    });
    act.appendChild(go);
    var links = el('div', 'links');
    var sharp = el('button', null, 'sharper idea');
    sharp.type = 'button';
    sharp.addEventListener('click', function () { think(true); });
    var skip = el('button', null, 'not now');
    skip.type = 'button';
    skip.addEventListener('click', function () { api('/bet/skip', {}).then(function () { loadBet(); }); });
    links.appendChild(sharp);
    links.appendChild(document.createTextNode(' \\u00b7 '));
    links.appendChild(skip);
    act.appendChild(links);
    box.appendChild(act);
  }

  function showCard(s, animate) {
    var box = document.getElementById('bet');
    bet.last = s;
    drawBetCard(s);
    document.body.classList.add('has-card');
    box.hidden = false;
    window.scrollTo(0, 0);
    if (!animate || reduced) { box.classList.add('up'); return; }
    box.classList.remove('up');
    requestAnimationFrame(function () { requestAnimationFrame(function () { box.classList.add('up'); }); });
  }

  function showOrb(text) {
    var box = document.getElementById('bet');
    box.hidden = true; box.classList.remove('up');
    if (document.body.classList.contains('has-card')) { document.body.classList.remove('has-card'); orb.show(); }
    line.set(text, false);
  }

  function drawBet(s) {
    var was = bet.status;
    bet.status = s.status;
    if (s.status === 'thinking') {
      if (document.body.classList.contains('has-card')) showOrb('');
      if (!orb.busy()) orb.think();
      orb.progress(progressOf(s.events));
      line.set(sayEvent(s.events[s.events.length - 1]), false);
      poll();
      return;
    }
    if (s.status === 'failed') {
      if (was === 'thinking') orb.relax();
      line.set(failLine(s.error), true);
      return;
    }
    if (s.bet && (s.status === 'ready' || s.status === 'starting' || s.status === 'started')) {
      if (was === 'thinking') {
        orb.progress(1);
        line.set('', false);
        orb.finish(function () { showCard(s, true); });
      } else if (bet.drawn !== s.id) {
        orb.settled();
        showCard(s, false);
      } else {
        bet.last = s;
        drawBetCard(s);
      }
      bet.drawn = s.id;
      if (s.status === 'starting') poll();
      return;
    }
    // idle or skipped: the orb waits for a tap
    showOrb(s.status === 'skipped' ? 'not now. tap when you want another' : 'tap to think');
  }

  function loadBet() {
    return api('/bet').then(function (s) { if (s.http === 200) drawBet(s); });
  }

  function poll() {
    if (bet.polling) return;
    bet.polling = true;
    setTimeout(function () { bet.polling = false; loadBet(); }, 400);
  }

  function think(sharper) {
    if (orb.busy()) return;
    bet.drawn = null;
    if (document.body.classList.contains('has-card')) showOrb('');
    orb.think();
    line.set(sharper ? 'thinking again, sharper' : 'reading what is true right now', false);
    api('/bet/think', { sharper: Boolean(sharper) }).then(function (res) {
      if (!res.ok && res.reason !== 'busy') { orb.relax(); line.set('that did not go through. tap to try again', true); return; }
      loadBet();
    });
  }

  var canvas = document.getElementById('orb');
  canvas.addEventListener('click', function () { think(false); });
  canvas.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); think(false); }
  });

  // ---- only you: the decision deck, behind one quiet link ---------------------------

  var sheet = document.getElementById('sheet');
  document.getElementById('open-only').addEventListener('click', function () { sheet.hidden = false; draw(); });
  document.getElementById('close-only').addEventListener('click', function () { sheet.hidden = true; armed = null; view = 'card'; });

  function say(text, done) {
    var reply = document.getElementById('reply');
    reply.hidden = !text;
    reply.textContent = text || '';
  }

  function choiceButton(card, choice, main) {
    var b = el('button', 'choice' + (main ? ' main' : (choice.id === 'later' ? ' later' : '')));
    b.type = 'button';
    var label = el('span', null, choice.label);
    b.appendChild(label);
    if (choice.effect) b.appendChild(el('span', 'effect', choice.effect));
    var key = card.id + ':' + choice.id;
    if (armed && armed.key === key) {
      b.className = 'choice armed';
      label.textContent = 'tap again to confirm';
    }
    b.addEventListener('click', function () { tap(card, choice, key); });
    return b;
  }

  function tap(card, choice, key) {
    if (choice.view === 'oldest') { view = 'oldest'; draw(); return; }
    if (choice.confirm && !(armed && armed.key === key && Date.now() < armed.until)) {
      armed = { key: key, until: Date.now() + 5000 };
      draw();
      setTimeout(function () { if (armed && armed.key === key && Date.now() >= armed.until) { armed = null; draw(); } }, 5100);
      return;
    }
    armed = null;
    if (choice.ack) say(choice.ack, false);
    api('/action', { card: card.id, choice: choice.id, confirm: Boolean(choice.confirm) }).then(function (res) {
      if (!res.ok) { say(res.message || 'that did not go through', false); return refresh(); }
      if (choice.id === 'later') { say('', false); view = 'card'; }
      if (res.undo) showUndo(res.ack, res.undo);
      else if (res.id) pendingReply = res.id;
      if (choice.id !== 'later' && !/^(approve|sendback):/.test(choice.id)) view = 'card';
      refresh();
    });
  }

  function showUndo(text, undo) {
    var toast = document.getElementById('toast');
    document.getElementById('toast-text').textContent = text;
    toast.hidden = false;
    var b = document.getElementById('toast-undo');
    b.onclick = function () {
      toast.hidden = true;
      api('/undo', { id: undo.id }).then(function (res) { say(res.ack || res.message || '', false); refresh(); });
    };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { toast.hidden = true; }, undo.ms);
  }

  function drawCard(main, s) {
    var card = s.card;
    var box = el('section', 'card');
    box.appendChild(el('div', 'count', 'decision ' + (s.decided + 1) + ' of ' + Math.min(s.card_limit, s.decided + s.cards_left)));
    if (view === 'oldest' && card.jobs) {
      box.appendChild(el('p', 'say', 'the oldest jobs waiting on review'));
      card.jobs.forEach(function (job) {
        var j = el('div', 'job');
        j.appendChild(el('div', null, job.title));
        j.appendChild(el('div', 'meta', job.member + ', waiting ' + job.age + ', ' + job.ref));
        var row = el('div', 'row');
        row.appendChild(choiceButton(card, { id: 'approve:' + job.ref, label: 'approve', confirm: true, ack: job.member + ': thanks, landing it' }, false));
        row.appendChild(choiceButton(card, { id: 'sendback:' + job.ref, label: 'send back', confirm: true, ack: job.member + ': on it, taking another pass' }, false));
        j.appendChild(row);
        box.appendChild(j);
      });
      var back = el('button', 'choice later', 'back');
      back.type = 'button';
      back.addEventListener('click', function () { view = 'card'; armed = null; draw(); });
      box.appendChild(back);
    } else {
      box.appendChild(el('p', 'say', card.text));
      card.choices.forEach(function (c, i) { box.appendChild(choiceButton(card, c, i === 0 && c.id !== 'later')); });
      var cmds = [];
      card.choices.forEach(function (c) { if (/^yes-/.test(card.id) && c.commands) cmds = cmds.concat(c.commands); });
      if (cmds.length) box.appendChild(el('div', 'count', 'yes runs: ' + cmds.join('; ')));
    }
    main.appendChild(box);
  }

  function drawClear(main, s) {
    var box = el('section', 'card');
    box.appendChild(el('p', 'say', s.decided >= s.card_limit ? 'that is five decisions. the rest can wait.' : (s.decided ? 'you have been through everything for now.' : 'nothing needs you right now.')));
    var running = s.all_clear.still_running;
    box.appendChild(el('div', 'count', running.length ? 'still running: ' + running.join(', ') : 'nothing is running right now'));
    main.appendChild(box);
  }

  function draw() {
    var s = last;
    if (!s) return;
    var link = document.getElementById('open-only');
    var n = s.cards_left;
    link.hidden = !n && sheet.hidden;
    link.textContent = n === 1 ? '1 thing only you can do' : n + ' things only you can do';
    document.getElementById('target').textContent = s.strip.line;
    var pct = s.strip.goal ? Math.min(100, Math.round(100 * s.strip.landed / s.strip.goal)) : 0;
    document.getElementById('bar').style.width = pct + '%';
    if (sheet.hidden) return;
    var main = document.getElementById('main');
    main.textContent = '';
    if (s.error) main.appendChild(el('p', 'count', 'could not read the task list: ' + s.error));
    if (s.card && !(view === 'oldest' && !s.card.jobs)) drawCard(main, s);
    else drawClear(main, s);
    if (pendingReply) {
      var a = s.actions.filter(function (x) { return x.id === pendingReply; })[0];
      if (a) say(a.line, a.status === 'done');
    }
    document.getElementById('live').textContent = s.live;
  }

  function refresh() {
    return api('/state').then(function (s) {
      if (s.http !== 200) { line.set('this link stopped working. start gm phone again on the mac.', true); return; }
      if (!s.card || s.card.id !== 'review') view = 'card';
      last = s;
      draw();
      if (s.bet && bet.status === null) drawBet(s.bet);
    }).catch(function () {
      document.getElementById('live').textContent = 'cannot reach the mac right now. retrying.';
    });
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
}

module.exports = { phonePage };
