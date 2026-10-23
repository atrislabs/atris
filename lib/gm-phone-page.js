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
.quiet { color: var(--text-2); font-size: 17px; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 44px; }
.jobs { margin: 12px auto 0; max-width: 24em; text-align: left; color: var(--text); font-size: 17px; line-height: 1.4; }
.jobs p { margin: 0 0 12px; }
.jobs .meta { display: block; color: var(--text-2); font-size: 17px; }

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
.mission { margin: 32px 0 0; padding: 16px 0 0; border-top: 1px solid var(--line); color: var(--text); font-size: 20px; line-height: 1.4; text-align: center; }
/* a question card: the answers stack full width under the question */
.act.answers { align-items: stretch; gap: 10px; }
.act.answers .links { text-align: center; }

/* an answer to a question card */
.choice { width: 100%; min-height: 52px; text-align: left; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line); color: var(--text); font-size: 19px; }

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
    <canvas id="orb" tabindex="0" role="button" aria-label="the atris orb. tap to think of one new bet for the business"></canvas>
  </div>
  <p class="line" id="line" aria-live="polite">tap to think</p>
  <article class="bet" id="bet" hidden></article>
  <div class="foot" id="foot"><button type="button" class="quiet" id="working" hidden aria-expanded="false"></button><div class="jobs" id="jobs" hidden></div></div>
</main>
<div class="lava" id="lava" role="button" tabindex="-1" aria-label="the atris orb. tap for the next bet">
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
  var bet = { status: null, polling: false, armed: false, drawn: null, busy: false, last: null };
  // how long "builder has it" (or any ack) stays before the next card
  var AFTER_MS = 1500;

  function buzz() { if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* not on this device */ } } }

  // real progress from the server's events: each source read, then the
  // words the model has written as it works
  function progressOf(events) {
    var p = 0;
    events.forEach(function (e) {
      if (e.kind === 'source' || e.kind === 'skip') p = Math.max(p, Math.min(0.4, p + 0.4 / 6));
      else if (e.kind === 'model') p = Math.max(p, 0.45);
      else if (e.kind === 'thinking') p = Math.max(p, 0.5 + 0.45 * (1 - Math.exp(-(Number(e.n) || 0) / 250)));
      else if (e.kind === 'skeptic') p = Math.max(p, 0.9);
      else if (e.kind === 'done') p = 1;
    });
    return p;
  }

  var SOURCE_WORDS = {
    now: 'reading your notes',
    briefs: 'reading the latest research',
    season: 'reading what the team did this week',
    ledger: 'reading how past bets did',
    team: 'reading who is on the team',
    focus: 'reading what you asked for'
  };

  // the newest event, in plain words for the one line under the orb
  function sayEvent(e) {
    if (!e) return 'thinking of the next bet';
    if (e.kind === 'source') {
      // business numbers show as they are; the team's plumbing (waiting
      // jobs, merges, releases) never reaches this line
      if (e.key === 'installs' || e.key === 'installs_best') return e.line;
      return SOURCE_WORDS[e.key] || 'reading what is true right now';
    }
    if (e.kind === 'skip') return 'reading what is true right now';
    if (e.kind === 'model') return e.line.indexOf('again') >= 0 ? 'asking again, sharper' : 'thinking of one new bet';
    if (e.kind === 'thinking') return e.line;
    if (e.kind === 'skeptic') return 'a second look: does it make sense';
    if (e.kind === 'score') return 'reading how past bets did';
    if (e.kind === 'reject') return 'the first idea did not hold up, asking again';
    if (e.kind === 'done' || e.kind === 'check') return 'got one';
    return e.line;
  }

  function failLine(error) {
    var e = String(error || '');
    if (/longer than/.test(e)) return 'the thinking took too long. tap to try again';
    if (/could not start|exited with code|empty answer|the model said/.test(e)) return 'could not reach the thinking model. tap to try again';
    return 'couldn\\'t land on a good bet. tap to try again';
  }

  // after a yes or a nice, the next card comes the way a re-tap brings it
  function moveOn(ack) {
    var box = document.getElementById('bet');
    var act = box.querySelector('.act');
    if (act) act.replaceWith(el('p', 'mission', ack));
    setTimeout(function () { tapOrb(false); }, AFTER_MS);
  }

  function armedTap(go, label, armedLabel, run) {
    go.addEventListener('click', function () {
      buzz();
      if (!bet.armed) {
        bet.armed = true; go.textContent = armedLabel; go.className = 'pill armed';
        setTimeout(function () { if (bet.armed) { bet.armed = false; go.textContent = label; go.className = 'pill'; } }, 5000);
        return;
      }
      bet.armed = false;
      run();
    });
  }

  // a line that ends like a sentence
  function sentence(t) {
    var s = String(t || '').trim();
    return s && !/[.!?]$/.test(s) ? s + '.' : s;
  }

  // a yes the owner owes, or a finished business move: what is going on,
  // then why it matters, both written by the server
  function drawJobCard(s) {
    var box = document.getElementById('bet');
    box.textContent = '';
    var j = s.job;
    box.appendChild(el('h1', null, j.what));
    box.appendChild(el('p', 'why', j.why));
    var act = el('div', 'act');
    if (s.kind === 'yes') {
      var yes = el('button', 'pill', 'yes');
      yes.type = 'button';
      armedTap(yes, 'yes', 'tap again to say yes', function () {
        api('/bet/yes', { confirm: true }).then(function (r) { moveOn(r.ack || r.message || 'sent'); });
      });
      act.appendChild(yes);
      act.appendChild(el('div', 'links', 'or tap the orb for the next one'));
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
  }

  // no bet was ready: one question, then what is going on and why the answer matters
  function drawQuestionCard(s) {
    var box = document.getElementById('bet');
    box.textContent = '';
    var q = s.question;
    box.appendChild(el('h1', null, q.ask));
    box.appendChild(el('p', 'why', q.line));
    var act = el('div', 'act answers');
    q.choices.forEach(function (c) {
      var b = el('button', 'choice', c.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        buzz();
        act.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
        api('/bet/answer', { choice: c.id }).then(function (r) {
          act.replaceWith(el('p', 'mission', r.ok ? r.ack : (r.message || 'that did not go through')));
        });
      });
      act.appendChild(b);
    });
    act.appendChild(el('div', 'links', 'or tap the orb for the next one'));
    box.appendChild(act);
  }

  function drawBetCard(s) {
    if (s.kind === 'question') { drawQuestionCard(s); return; }
    if (s.kind && s.kind !== 'bet') { drawJobCard(s); return; }
    var box = document.getElementById('bet');
    box.textContent = '';
    var b = s.bet;
    box.appendChild(el('h1', null, b.title));
    // why it matters: what is going on and what we expect, in the same big type
    box.appendChild(el('p', 'why', [b.why_now, b.expect].map(sentence).join(' ')));
    if (s.mission) { box.appendChild(el('p', 'mission', s.mission.line)); return; }
    if (s.status === 'starting') { box.appendChild(el('p', 'mission', 'starting the mission')); return; }
    var act = el('div', 'act');
    var go = el('button', 'pill' + (bet.armed ? ' armed' : ''), bet.armed ? 'tap again to start' : 'do it');
    go.type = 'button';
    go.setAttribute('aria-label', bet.armed ? 'tap again to start the team on this bet' : 'do it. starts the team on the steps; your yes steps wait for you');
    go.addEventListener('click', function () {
      buzz();
      if (!bet.armed) {
        bet.armed = true; drawBetCard(s);
        setTimeout(function () { if (bet.armed) { bet.armed = false; if (bet.last) drawBetCard(bet.last); } }, 5000);
        return;
      }
      bet.armed = false;
      s.status = 'starting'; drawBetCard(s);
      api('/bet/do', { confirm: true }).then(function (r) {
        loadBet(); refresh();
        if (r && r.ok) setTimeout(function () { tapOrb(false); }, AFTER_MS);
      });
    });
    act.appendChild(go);
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
    box.classList.remove('leave');
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
      box.hidden = true;
      box.classList.remove('leave');
      document.body.classList.remove('has-card');
      window.scrollTo(0, 0);
    };
    if (reduced) { setTimeout(function () { orb.melt(then, to, swap); }, orb.leaveMs); return; }
    orb.melt(then, to, swap);
  }

  // what the page does with the server's answer once the sphere is ready
  // fast: the bet was waiting in the queue; otherwise it was just made
  function reveal(s, fast) {
    bet.status = s.status;
    if ((s.bet || s.job || s.question) && (s.status === 'ready' || s.status === 'started' || s.status === 'starting')) {
      line.set('', false);
      orb.play(function (phase) { if (phase === 'settled') { bet.busy = false; showCard(s, true, fast); } }, fast);
      return;
    }
    if (s.status === 'thinking') {
      orb.wait();
      orb.progress(progressOf(s.events));
      line.set(sayEvent(s.events[s.events.length - 1]), false);
      poll();
      return;
    }
    if (s.status === 'failed') {
      bet.busy = false;
      orb.relax();
      line.set(failLine(s.error), true);
      return;
    }
    bet.busy = false;
    line.set('tap to think', false);
  }

  // one tap: buzz at once, ask the server for the next bet, and play the
  // choreography; a card on screen dissolves first
  function tapOrb(sharper) {
    if (bet.busy) return;
    buzz();
    bet.busy = true;
    bet.armed = false;
    bet.tapAt = performance.now();
    document.body.removeAttribute('data-reveal-ms');
    var answer = api('/bet/think', { sharper: Boolean(sharper) });
    var ready = new Promise(function (resolve) {
      if (document.body.classList.contains('has-card')) dissolve(resolve);
      else resolve();
    });
    Promise.all([answer, ready]).then(function (both) {
      var s = both[0];
      if (s.http !== 200) { bet.busy = false; orb.relax(); line.set('that did not go through. tap to try again', true); return; }
      reveal(s, true);
    });
  }

  function loadBet() {
    return api('/bet').then(function (s) {
      if (s.http !== 200) return;
      var was = bet.status;
      bet.status = s.status;
      if (s.status === 'thinking') {
        orb.progress(progressOf(s.events));
        line.set(sayEvent(s.events[s.events.length - 1]), false);
        poll();
        return;
      }
      if (was === 'thinking') { reveal(s); return; }
      if ((s.bet || s.job || s.question) && bet.drawn === s.id) { bet.last = s; drawBetCard(s); if (s.status === 'starting') poll(); }
    });
  }

  function poll() {
    if (bet.polling) return;
    bet.polling = true;
    setTimeout(function () { bet.polling = false; loadBet(); }, 400);
  }

  // first look: a bet already on screen shows settled, a bet being made
  // shows its progress, anything else is the sphere
  function firstLook() {
    api('/bet').then(function (s) {
      if (s.http !== 200) return;
      bet.status = s.status;
      if ((s.bet || s.job || s.question) && (s.status === 'ready' || s.status === 'started' || s.status === 'starting')) {
        orb.settled();
        showCard(s, false);
        return;
      }
      if (s.status === 'thinking') { bet.busy = true; reveal(s); return; }
      if (s.status === 'failed') { line.set(failLine(s.error), true); return; }
      line.set(s.status === 'skipped' ? 'not now. tap when you want another' : 'tap to think', false);
    });
  }

  var canvas = document.getElementById('orb');
  var lavaTap = document.getElementById('lava');
  [canvas, lavaTap].forEach(function (node) {
    node.addEventListener('click', function () { tapOrb(false); });
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapOrb(false); }
    });
  });

  // ---- the footer: how many jobs the team is on, and who has each ---------------

  document.getElementById('working').addEventListener('click', function () {
    var list = document.getElementById('jobs');
    list.hidden = !list.hidden;
    this.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
  });

  function drawWorking(jobs) {
    var btn = document.getElementById('working');
    var list = document.getElementById('jobs');
    btn.hidden = !jobs.length;
    btn.textContent = jobs.length + ' working';
    if (!jobs.length) { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
    list.textContent = '';
    jobs.forEach(function (j) {
      var row = el('p', null, j.title);
      row.appendChild(el('span', 'meta', j.owner + ' has it'));
      list.appendChild(row);
    });
  }

  function refresh() {
    return api('/bet').then(function (s) {
      if (s.http !== 200) { line.set('this link stopped working. start gm phone again on the mac.', true); return; }
      drawWorking(s.working || []);
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
