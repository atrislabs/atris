// atris card — turn one line of text into a beautiful, on-brand image.
// Pure: spec -> self-contained HTML string. Reuses the design system: the same
// themes as deck/site/html (incl. your .atris/theme.json brand), one accent,
// Fraunces display, restraint. Render to PNG with headless Chrome (commands/card.js).
//
// Kinds: statement (kicker + headline + sub), quote (quote + attribution),
//        stat (big number + label). Sizes: og, wide, square, story.

const { mergedThemes } = require('./theme');
const { THEMES: HTML_THEMES, rich, esc } = require('./html-render');

const SIZES = {
  og: { w: 1200, h: 630 },      // OpenGraph / link card
  wide: { w: 1920, h: 1080 },   // slide / banner
  square: { w: 1080, h: 1080 }, // feed
  story: { w: 1080, h: 1920 },  // story / reel
};
const KINDS = ['statement', 'quote', 'stat'];

const plainLen = (s) => String(s == null ? '' : s).replace(/\*\*/g, '').length;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// shrink a display line so long text still fits the card
function fit(base, text, refChars) {
  return Math.round(base * clamp(refChars / Math.max(plainLen(text), 1), 0.5, 1));
}

function fontStack(name, fallback) {
  return `'${String(name || fallback).replace(/'/g, '')}', '${fallback}', ${fallback === 'Fraunces' ? 'Georgia, serif' : 'system-ui, sans-serif'}`;
}

function buildCard(spec = {}, opts = {}) {
  const size = SIZES[spec.size] || SIZES.og;
  const themes = opts.themes || mergedThemes(HTML_THEMES, opts.root || process.cwd());
  const theme = themes[spec.theme] || HTML_THEMES.atris;
  const c = theme.color;
  const f = theme.fonts || {};
  const kind = KINDS.includes(spec.kind) ? spec.kind : 'statement';
  const u = Math.min(size.w, size.h);

  const pad = Math.round(u * 0.088);
  const px = {
    kicker: Math.round(u * 0.030),
    sub: Math.round(u * 0.040),
    foot: Math.round(u * 0.028),
    rule: Math.round(u * 0.010),
    gap: Math.round(u * 0.030),
  };

  const brand = spec.brand || 'Atris';
  const version = spec.version || '';
  const display = fontStack(f.display, 'Fraunces');
  const body = fontStack(f.body, 'Outfit');
  const grotesk = "'Space Grotesk', system-ui, sans-serif";
  const monoFont = "'IBM Plex Mono', ui-monospace, monospace";

  const foot = `<div class="foot"><span class="mark">${esc(brand)}</span>${version ? `<span class="ver">${esc(version)}</span>` : ''}</div>`;
  const kickerHtml = spec.kicker ? `<div class="kicker">${rich(spec.kicker)}</div>` : '';
  const subHtml = spec.sub ? `<p class="sub">${rich(spec.sub)}</p>` : '';

  let main = '';
  let extraCss = '';
  if (kind === 'quote') {
    const text = spec.text || spec.headline || 'Your quote here';
    const qSize = fit(Math.round(u * 0.090), text, 64);
    main = `<div class="rule"></div>
      <div class="qmark">&ldquo;</div>
      <blockquote class="qtext">${rich(text)}</blockquote>
      ${spec.by ? `<div class="by">${rich(spec.by)}</div>` : ''}`;
    extraCss = `
      .qmark{font-family:${display};color:${c.accent};font-size:${Math.round(u * 0.20)}px;line-height:.6;height:${Math.round(u * 0.10)}px}
      .qtext{font-family:${display};font-weight:600;font-size:${qSize}px;line-height:1.08;letter-spacing:-1px;margin:${px.gap}px 0}
      .by{font-family:${monoFont};font-size:${px.foot}px;color:${c.soft}}`;
  } else if (kind === 'stat') {
    const number = spec.number || spec.headline || '42';
    const numSize = fit(Math.round(u * 0.34), number, 6);
    main = `<div class="rule"></div>
      ${kickerHtml}
      <div class="big">${rich(number)}</div>
      ${spec.label ? `<div class="statlabel">${rich(spec.label)}</div>` : ''}
      ${subHtml}`;
    extraCss = `
      .big{font-family:${grotesk};font-weight:600;color:${c.accent};font-size:${numSize}px;line-height:.92;letter-spacing:-2px}
      .statlabel{font-family:${display};font-weight:600;font-size:${Math.round(u * 0.058)}px;color:${c.ink};margin-top:${Math.round(px.gap * 0.5)}px}`;
  } else {
    const headline = spec.headline || spec.text || 'Your headline here';
    const hSize = fit(Math.round(u * 0.135), headline, 34);
    main = `<div class="rule"></div>
      ${kickerHtml}
      <h1 class="headline">${rich(headline)}</h1>
      ${subHtml}`;
    extraCss = `
      .headline{font-family:${display};font-weight:600;font-size:${hSize}px;line-height:1.02;letter-spacing:-1.5px}`;
  }

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Outfit:wght@400;500;600&family=Space+Grotesk:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${size.w}px;height:${size.h}px;overflow:hidden}
  body{background:${c.bg};color:${c.ink};font-family:${body};-webkit-font-smoothing:antialiased}
  .card{width:${size.w}px;height:${size.h}px;padding:${pad}px;display:flex;flex-direction:column;justify-content:center;position:relative}
  .rule{width:${Math.round(u * 0.085)}px;height:${px.rule}px;background:${c.accent};border-radius:${px.rule}px;margin-bottom:${Math.round(px.gap * 0.9)}px}
  .kicker{font-family:${monoFont};font-size:${px.kicker}px;letter-spacing:2px;color:${c.soft};margin-bottom:${Math.round(px.gap * 0.6)}px}
  .sub{font-size:${px.sub}px;line-height:1.4;color:${c.soft};margin-top:${px.gap}px;max-width:88%}
  .foot{position:absolute;left:${pad}px;right:${pad}px;bottom:${pad}px;display:flex;align-items:baseline;justify-content:space-between}
  .mark{font-family:${display};font-weight:600;font-size:${Math.round(u * 0.034)}px}
  .ver{font-family:${monoFont};font-size:${px.foot}px;color:${c.soft};letter-spacing:1px}
  .accent{color:${c.accent}}
  ${extraCss}
</style></head>
<body><div class="card">${main}${foot}</div></body></html>`;

  return { html, width: size.w, height: size.h, kind, theme: spec.theme || 'atris', size: spec.size || 'og' };
}

module.exports = { buildCard, SIZES, KINDS };
