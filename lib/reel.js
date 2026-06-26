// atris reel — a card, animated. A reel is the card from lib/card.js rendered at
// progress t in [0,1]: each element fades and rises in on a staggered schedule.
// Pure: (spec, t) -> HTML for that single frame. commands/reel.js screenshots the
// frames (same Chrome as card) and ffmpeg-encodes them. No new dependency.

const { buildCard } = require('./card');

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOutCubic = (p) => 1 - Math.pow(1 - clamp01(p), 3);
// reveal progress of an element whose window is [a,b], at global time t
const win = (t, a, b) => easeOutCubic((t - a) / (b - a));

// staggered reveal windows by element class. A kind only has some of these;
// overriding a class that isn't present is harmless.
const STAGGER = [
  ['.rule', 0.00, 0.16],
  ['.kicker', 0.10, 0.30],
  ['.qmark', 0.10, 0.30],
  ['.headline', 0.18, 0.46],
  ['.qtext', 0.20, 0.50],
  ['.big', 0.16, 0.46],
  ['.statlabel', 0.34, 0.58],
  ['.sub', 0.40, 0.62],
  ['.by', 0.46, 0.66],
  ['.foot', 0.58, 0.80],
];

// CSS that places every element at its reveal state for time t (one-shot, no loops)
function revealCss(t, dist = 16) {
  const tt = clamp01(t);
  let css = '';
  for (const [sel, a, b] of STAGGER) {
    const p = win(tt, a, b);
    css += `${sel}{opacity:${p.toFixed(3)};transform:translateY(${((1 - p) * dist).toFixed(2)}px)}`;
  }
  return css;
}

// HTML for a single reel frame at time t. Reuses the card, appends the reveal styles.
function buildReelFrame(spec, t, opts = {}) {
  const card = buildCard(spec, opts);
  const overrides = `<style id="reel">${revealCss(t)}</style>`;
  return { html: card.html.replace('</head>', `${overrides}</head>`), width: card.width, height: card.height };
}

// the list of t values for a reel of `seconds` at `fps` (>=2 frames)
function reelFrames(seconds = 2.6, fps = 20) {
  const n = Math.max(2, Math.round(seconds * fps));
  return Array.from({ length: n }, (_, i) => i / (n - 1));
}

module.exports = { buildReelFrame, revealCss, reelFrames, win, STAGGER };
