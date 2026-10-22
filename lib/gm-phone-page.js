'use strict';

// The one page gm phone serves. Plain html, css, and vanilla js, no build
// step. Every piece of text from the task list goes in with textContent,
// never as html. The nonce matches the page's content security policy.
//
// The orb on top is a port of the landing page orb in atrisos-web
// (app/components/landing/StippleOrb.tsx, LavaOrb.tsx, orb.module.css,
// LetterOrb.tsx): the same dots, colors, and easing. Here the spiral is
// driven by the bet's real progress events, not a timer, and once the card
// is up the orb is still: the loop stops and the lava stops moving.

function phonePage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>front office</title>
<style nonce="${nonce}">
:root {
  --bg: #f6f5f2;
  --card: #ffffff;
  --ink: #1b1b19;
  --muted: #6b6a66;
  --line: #e3e1db;
  --accent: #0f6b4f;
  --accent-ink: #ffffff;
  --stuck: #b4441f;
  --night: #0a0908;
  --amber: rgb(251, 130, 36);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body {
  font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  padding: max(16px, env(safe-area-inset-top)) 18px max(20px, env(safe-area-inset-bottom));
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.strip { display: flex; flex-direction: column; gap: 12px; }
.where { color: var(--muted); font-size: 14px; }
.target { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
.bar > div { height: 100%; background: var(--accent); width: 0; }
.team { display: flex; flex-wrap: wrap; gap: 10px; }
.who {
  width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 600;
  background: var(--line); color: var(--muted);
}
.who.working { background: var(--accent); color: var(--accent-ink); }
.who.stuck { background: var(--stuck); color: #fff; }
.who.waiting { background: var(--card); color: var(--ink); box-shadow: inset 0 0 0 2px var(--accent); }
.who.asleep { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 24px 20px;
  display: flex; flex-direction: column; gap: 16px;
}
.count { color: var(--muted); font-size: 14px; }
.say { font-size: 20px; line-height: 1.4; margin: 0; }
button {
  font: inherit;
  width: 100%;
  min-height: 56px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  padding: 12px 16px;
  text-align: left;
  cursor: pointer;
}
button .effect { display: block; font-size: 14px; color: var(--muted); }
button.main { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; min-height: 64px; }
button.main .effect { color: var(--accent-ink); opacity: 0.85; font-weight: 400; }
button.armed { background: var(--ink); color: #fff; border-color: var(--ink); }
button.armed .effect { color: #fff; opacity: 0.85; }
button.later { border: none; background: transparent; color: var(--muted); text-align: center; }
button[disabled] { opacity: 0.5; }
.job { border-top: 1px solid var(--line); padding-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.job .title { font-weight: 600; }
.job .meta { color: var(--muted); font-size: 14px; }
.row { display: flex; gap: 10px; }
.row button { text-align: center; }
.reply { font-size: 16px; padding: 14px 16px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); }
.reply.done { border-color: var(--accent); }
.clear h2 { margin: 0; font-size: 24px; }
.clear ul { margin: 0; padding-left: 20px; color: var(--muted); }
.live { margin-top: auto; color: var(--muted); font-size: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
.toast {
  position: fixed; left: 16px; right: 16px; bottom: max(16px, env(safe-area-inset-bottom));
  background: var(--ink); color: #fff; border-radius: 12px; padding: 12px 16px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.toast button { width: auto; min-height: 52px; background: transparent; color: #fff; border-color: #fff; text-align: center; }
.only-you { color: var(--muted); font-size: 14px; margin-bottom: -8px; }
[hidden] { display: none !important; }

/* ---- the bet: orb stage, progress lines, card ---- */
.bet { display: flex; flex-direction: column; gap: 14px; }
.stage {
  position: relative; height: 300px; border-radius: 20px; overflow: hidden;
  background: var(--night);
  transition: height 0.7s cubic-bezier(0.65, 0, 0.35, 1);
}
.stage.small { height: 96px; }
.stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: pan-y; }
.feed { margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
.feed li.skip { opacity: 0.6; }
.feed li.bad { color: var(--stuck); }

/* the lava orb, LavaOrb variant sm: three drifting blobs, transform and opacity only */
.lava {
  position: absolute; left: 0; top: 0; width: 280px; height: 280px;
  border-radius: 50%; overflow: hidden; pointer-events: none;
  visibility: hidden; opacity: 0;
  background: rgb(20, 18, 16);
  box-shadow: 0 0 40px rgba(255, 140, 66, 0.1);
  filter: saturate(1.3);
  will-change: transform, opacity;
}
.lava .tx, .lava .ty { position: absolute; inset: 0; will-change: transform; }
/* one pass only: the lava drifts while it is born, never on a loop */
.lava .blob { position: absolute; will-change: transform; }
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
@media (prefers-reduced-motion: reduce) {
  .lava .tx, .lava .ty, .lava .blob { animation: none; }
  .stage, .betcard { transition: none; }
}

.betcard { opacity: 0; transform: translateY(28px); transition: opacity 0.45s ease-out, transform 0.45s cubic-bezier(0.22, 1, 0.36, 1); }
.betcard.up { opacity: 1; transform: none; }
.bet-title { font-size: 24px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; margin: 0; }
.bet-why { margin: 0; }
.k { display: block; color: var(--muted); font-size: 13px; }
.terms { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0; }
.terms div { margin: 0; }
.terms .wide { grid-column: 1 / -1; }
.steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; counter-reset: step; }
.steps li { display: flex; flex-direction: column; gap: 2px; padding-left: 28px; position: relative; counter-increment: step; }
.steps li::before { content: counter(step); position: absolute; left: 0; top: 1px; width: 20px; color: var(--muted); font-size: 14px; }
.tag { font-size: 13px; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; }
.tag.you { color: var(--stuck); }
.tag svg { width: 12px; height: 12px; }
.mission { font-size: 16px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--accent); }
</style>
</head>
<body>
<section class="bet" id="bet">
  <div class="stage" id="stage">
    <canvas id="orb" role="img" aria-label="the atris orb, made of dots"></canvas>
    <div class="lava" id="lava" aria-hidden="true">
      <div class="tx" style-vars="15%,8.4s,-2.1s"><div class="ty" style-vars="12%,10.1s,-5.1s"><div class="blob b1" spin-vars="36s,0deg"></div></div></div>
      <div class="tx" style-vars="18%,12.6s,-7.2s"><div class="ty" style-vars="15%,7.2s,-4.7s"><div class="blob b2 rev" spin-vars="48s,45deg"></div></div></div>
      <div class="tx" style-vars="12%,7.2s,-6.4s"><div class="ty" style-vars="18%,10.1s,-9.9s"><div class="blob b3" spin-vars="57.6s,90deg"></div></div></div>
      <div class="core" id="lava-core"></div>
    </div>
  </div>
  <ol class="feed" id="feed" aria-live="polite"></ol>
  <button type="button" class="main" id="think"><span>think</span><span class="effect">one new bet for the business, from what is true right now</span></button>
  <section class="card betcard" id="betcard" hidden></section>
</section>
<section class="strip">
  <div class="where" id="where">front office</div>
  <div class="target" id="target">loading</div>
  <div class="bar"><div id="bar"></div></div>
  <div class="team" id="team"></div>
</section>
<div class="only-you">only you</div>
<main id="main"></main>
<div id="reply" class="reply" hidden></div>
<div class="live" id="live"></div>
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

  // ---- the orb (port of StippleOrb, tone dark) --------------------------------
  var orb = (function () {
    var canvas = document.getElementById('orb');
    var stage = document.getElementById('stage');
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

    function snapshot() {
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        var len = Math.hypot(d.sx - cx, d.sy - cy);
        d.bx = d.sx; d.by = d.sy;
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
        if (arrivedAt >= 0 && now - arrivedAt > 250) { stop(); grow(); return; }
      }
      raf = requestAnimationFrame(frame);
    }

    function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

    // LetterOrb: the lava orb is born at the point and grows, then settles
    // small at the top of the stage. After that nothing moves.
    function grow(instant) {
      var base = 280, from = 30 / base, peak = 140 / base, rest = 64 / base;
      lava.style.visibility = 'visible';
      lava.classList.remove('still', 'alive');
      if (!reduced && !instant) { void lava.offsetWidth; lava.classList.add('alive'); }
      var place = function (s, x, y) { lava.style.transform = 'translate(' + (x - base / 2) + 'px, ' + (y - base / 2) + 'px) scale(' + s + ')'; };
      var done = function () {
        stage.classList.add('small');
        canvas.style.visibility = 'hidden';
        place(rest, cx, 48);
        lava.style.opacity = '1';
        core.style.opacity = '0';
        lava.classList.add('still');
        if (onBorn) { var cb = onBorn; onBorn = null; cb(); }
      };
      if (reduced || instant) { done(); return; }
      var t0 = performance.now();
      var GROW_MS = 1050, SETTLE_MS = 700;
      var step = function (now) {
        var t = Math.min(1, (now - t0) / GROW_MS);
        place(from + (peak - from) * ease(t), cx, cy);
        lava.style.opacity = String(smooth(0.02, 0.22, t));
        core.style.opacity = String(1 - smooth(0.05, 0.4, t));
        if (t < 1) { requestAnimationFrame(step); return; }
        stage.classList.add('small');
        canvas.style.visibility = 'hidden';
        var s0 = performance.now();
        var settle = function (n2) {
          var u = ease(Math.min(1, (n2 - s0) / SETTLE_MS));
          place(peak + (rest - peak) * u, cx, cy + (48 - cy) * u);
          if (u < 1) requestAnimationFrame(settle); else done();
        };
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(step);
    }

    function reform() {
      // the orb puts itself back together from the centre. The stage opens
      // at once so the canvas is measured at its full size.
      stage.style.transition = 'none';
      stage.classList.remove('small');
      void stage.offsetHeight;
      stage.style.transition = '';
      lava.classList.remove('still');
      lava.style.visibility = 'hidden';
      lava.style.opacity = '0';
      canvas.style.visibility = 'visible';
      arrivedAt = -1;
      mode = 'idle';
      measure();
      for (var i = 0; i < dots.length; i++) { dots[i].sx = cx; dots[i].sy = cy; dots[i].vx = 0; dots[i].vy = 0; }
    }

    measure();
    seed();
    if (reduced) { mode = 'idle'; frame(performance.now()); stop(); } else start();

    return {
      think: function () {
        if (mode === 'thinking' || mode === 'forming') return;
        var formed = !(mode === 'born' || stage.classList.contains('small'));
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
        }, formed || reduced ? 0 : 700);
      },
      progress: function (p) {
        pullTo = Math.max(pullTo, 0.85 * Math.min(1, p));
        if (reduced) { frame(performance.now()); stop(); }
      },
      // the bet is ready: finish the spiral, make the point, grow the lava
      finish: function (cb) {
        onBorn = cb;
        if (mode === 'forming' || mode === 'idle') snapshot();
        mode = 'born';
        pullTo = 1;
        if (reduced) { stop(); grow(); return; }
        start();
      },
      // generation failed: the dots relax back to the sphere
      relax: function () {
        mode = 'idle';
        pullTo = 0; pull = 0;
        start();
        if (reduced) { frame(performance.now()); stop(); }
      },
      // a bet is already up when the page loads: show the settled orb, no motion
      settled: function () { stop(); onBorn = null; mode = 'born'; grow(true); },
      busy: function () { return mode === 'thinking' || mode === 'forming'; },
    };
  })();

  // ---- the bet ------------------------------------------------------------------
  var bet = { status: null, seen: 0, polling: false, armed: false, drawn: null };

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
  // model's thinking tokens and written characters as it works
  function progressOf(events) {
    var p = 0;
    events.forEach(function (e) {
      if (e.kind === 'source' || e.kind === 'skip') p = Math.max(p, Math.min(0.4, p + 0.4 / 6));
      else if (e.kind === 'model') p = Math.max(p, 0.45);
      else if (e.kind === 'thinking') p = Math.max(p, 0.45 + 0.3 * (1 - Math.exp(-(Number((e.line.match(/[\\d,]+/) || ['0'])[0].replace(/,/g, '')) / 1500))));
      else if (e.kind === 'writing') p = Math.max(p, 0.75 + 0.2 * (1 - Math.exp(-(Number((e.line.match(/[\\d,]+/) || ['0'])[0].replace(/,/g, '')) / 900))));
      else if (e.kind === 'check' || e.kind === 'done') p = 1;
    });
    return p;
  }

  function drawFeed(events) {
    var feed = document.getElementById('feed');
    feed.textContent = '';
    // facts stay; the model's running count keeps only its newest line
    var shown = [];
    events.forEach(function (e) {
      var prev = shown[shown.length - 1];
      if (prev && (e.kind === 'thinking' || e.kind === 'writing') && (prev.kind === 'thinking' || prev.kind === 'writing')) shown[shown.length - 1] = e;
      else shown.push(e);
    });
    shown.forEach(function (e) {
      feed.appendChild(el('li', e.kind === 'skip' ? 'skip' : (e.kind === 'failed' || e.kind === 'reject' ? 'bad' : ''), e.line));
    });
  }

  function betButton(label, effect, cls, onTap) {
    var b = el('button', cls);
    b.type = 'button';
    b.appendChild(el('span', null, label));
    if (effect) b.appendChild(el('span', 'effect', effect));
    b.addEventListener('click', onTap);
    return b;
  }

  function drawBetCard(s) {
    var box = document.getElementById('betcard');
    box.textContent = '';
    var b = s.bet;
    box.appendChild(el('div', 'count', 'the bet'));
    box.appendChild(el('h1', 'bet-title', b.title));
    var why = el('p', 'bet-why');
    why.appendChild(el('span', 'k', 'why now'));
    why.appendChild(document.createTextNode(b.why_now));
    box.appendChild(why);
    var terms = el('div', 'terms');
    [['expect', b.expect, 'wide'], ['check on', b.check_date], ['cost', b.cost], ['read from', b.metric_source, 'wide']].forEach(function (t) {
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
      tag.appendChild(document.createTextNode(st.who === 'you' ? 'your yes' : 'team does it'));
      li.appendChild(tag);
      li.appendChild(el('span', null, st.text));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    if (s.mission) {
      box.appendChild(el('div', 'mission', s.mission.line));
    } else if (s.status === 'starting') {
      box.appendChild(el('div', 'mission', 'starting the mission'));
    } else if (s.status === 'skipped') {
      box.appendChild(el('div', 'count', 'not now. all clear.'));
    } else {
      var go = betButton(bet.armed ? 'tap again to confirm' : 'do it', bet.armed ? 'this starts agents on the team steps' : 'the team starts on the steps; your yes steps wait for you', bet.armed ? 'armed' : 'main', function () {
        if (!bet.armed) {
          bet.armed = true; drawBetCard(s);
          setTimeout(function () { if (bet.armed) { bet.armed = false; if (last && last.bet) drawBetCard(last.bet); } }, 5000);
          return;
        }
        bet.armed = false;
        api('/bet/do', { confirm: true }).then(function (res) {
          say(res.ack || res.message || 'that did not go through', Boolean(res.ok));
          loadBet();
          refresh();
        });
        s.status = 'starting'; drawBetCard(s);
      });
      box.appendChild(go);
      box.appendChild(betButton('sharper idea', 'think again, more specific, different from this one', '', function () { think(true); }));
      box.appendChild(betButton('not now', null, 'later', function () {
        api('/bet/skip', {}).then(function (res) { say(res.ack || res.message || '', false); loadBet(); });
      }));
    }
    box.hidden = false;
  }

  function showCard(s, animate) {
    var box = document.getElementById('betcard');
    drawBetCard(s);
    document.getElementById('think').hidden = true;
    document.getElementById('feed').hidden = true;
    if (!animate || reduced) { box.classList.add('up'); return; }
    box.classList.remove('up');
    requestAnimationFrame(function () { requestAnimationFrame(function () { box.classList.add('up'); }); });
  }

  function drawBet(s) {
    var was = bet.status;
    bet.status = s.status;
    var thinkBtn = document.getElementById('think');
    var box = document.getElementById('betcard');
    if (s.status === 'thinking') {
      thinkBtn.hidden = true;
      box.hidden = true; box.classList.remove('up');
      document.getElementById('feed').hidden = false;
      drawFeed(s.events);
      if (!orb.busy()) orb.think();
      orb.progress(progressOf(s.events));
      poll();
      return;
    }
    if (s.status === 'failed') {
      drawFeed(s.events);
      document.getElementById('feed').hidden = false;
      if (was === 'thinking') orb.relax();
      say('could not make a bet: ' + (s.error || 'something failed'), false);
      thinkBtn.hidden = false;
      thinkBtn.firstChild.textContent = 'try again';
      return;
    }
    if (s.status === 'skipped') {
      box.hidden = true; box.classList.remove('up');
      document.getElementById('feed').hidden = true;
      thinkBtn.hidden = false;
      thinkBtn.firstChild.textContent = 'think';
      return;
    }
    if (s.bet && (s.status === 'ready' || s.status === 'starting' || s.status === 'started')) {
      if (was === 'thinking') {
        drawFeed(s.events);
        orb.progress(1);
        orb.finish(function () { showCard(s, true); });
      } else if (bet.drawn !== s.id) {
        orb.settled();
        showCard(s, false);
      } else {
        drawBetCard(s);
      }
      bet.drawn = s.id;
      if (s.status === 'starting') poll();
      return;
    }
    thinkBtn.hidden = false;
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
    say('', false);
    document.getElementById('feed').textContent = '';
    bet.drawn = null;
    orb.think();
    api('/bet/think', { sharper: Boolean(sharper) }).then(function (res) {
      if (!res.ok && res.reason !== 'busy') { say(res.message || 'that did not go through', false); orb.relax(); return; }
      loadBet();
    });
  }
  document.getElementById('think').addEventListener('click', function () { think(false); });

  // ---- the decision deck -----------------------------------------------------------

  function say(text, done) {
    var reply = document.getElementById('reply');
    reply.hidden = !text;
    reply.textContent = text || '';
    reply.className = 'reply' + (done ? ' done' : '');
  }

  function choiceButton(card, choice, main) {
    var b = el('button', main ? 'main' : (choice.id === 'later' ? 'later' : ''));
    b.type = 'button';
    var label = el('span', null, choice.label);
    b.appendChild(label);
    if (choice.effect) b.appendChild(el('span', 'effect', choice.effect));
    var key = card.id + ':' + choice.id;
    if (armed && armed.key === key) {
      b.className = 'armed';
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
        j.appendChild(el('div', 'title', job.title));
        j.appendChild(el('div', 'meta', job.member + ', waiting ' + job.age + ', ' + job.ref));
        var row = el('div', 'row');
        row.appendChild(choiceButton(card, { id: 'approve:' + job.ref, label: 'approve', confirm: true, ack: job.member + ': thanks, landing it' }, false));
        row.appendChild(choiceButton(card, { id: 'sendback:' + job.ref, label: 'send back', confirm: true, ack: job.member + ': on it, taking another pass' }, false));
        j.appendChild(row);
        box.appendChild(j);
      });
      var back = el('button', 'later', 'back');
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
    var box = el('section', 'card clear');
    box.appendChild(el('h2', null, 'all clear'));
    box.appendChild(el('p', null, s.decided >= s.card_limit ? 'that is five decisions. the rest can wait.' : (s.decided ? 'you have been through everything for now.' : 'nothing needs you right now.')));
    var running = s.all_clear.still_running;
    if (running.length) {
      box.appendChild(el('div', 'count', 'still running'));
      var ul = el('ul');
      running.forEach(function (line) { ul.appendChild(el('li', null, line)); });
      box.appendChild(ul);
    } else {
      box.appendChild(el('div', 'count', 'nothing is running right now'));
    }
    main.appendChild(box);
  }

  function draw() {
    var s = last;
    if (!s) return;
    document.getElementById('where').textContent = 'front office, ' + s.workspace_name;
    document.getElementById('target').textContent = s.strip.line;
    var pct = s.strip.goal ? Math.min(100, Math.round(100 * s.strip.landed / s.strip.goal)) : 0;
    document.getElementById('bar').style.width = pct + '%';
    var team = document.getElementById('team');
    team.textContent = '';
    s.team.forEach(function (m) {
      var c = el('div', 'who ' + m.tone, m.initials);
      c.title = m.name + ': ' + m.status;
      c.setAttribute('aria-label', m.name + ', ' + m.status);
      team.appendChild(c);
    });
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
      if (s.http !== 200) { document.getElementById('target').textContent = 'this link stopped working. start gm phone again on the mac.'; return; }
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
