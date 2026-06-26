// Atris HTML renderer — same content model as the deck engine, rendered to
// beautiful, anti-slop HTML made of semantic blocks. Pure: spec -> HTML string.
//
// Connects with the web apps: the `atris` theme matches atrisos-web tokens
// (amber #f59e0b on warm dark, --brand-* CSS variables), every section carries
// data-atris-block="<type>", and renderBlock() emits the AppBlock html shape
// ({ type:'html', config:{ html } }) so the output drops into an Atris app.
//
// Anti-slop by construction: one accent, fluid type, restraint, no gradient
// text, no glassmorphism, em dashes sanitized (shares slides-deck helpers).

const { THEMES: DECK_THEMES, sanitize, parseEmph } = require('./slides-deck');

// HTML themes reuse the deck design-system shape, plus `atris` (matches the web app).
const THEMES = {
  atris: { // warm dark, amber accent, matches atrisos-web (--brand-* tokens, TWKLausanne)
    fonts: { display: 'TWKLausanne', body: 'TWKLausanne', mono: 'ui-monospace, SFMono-Regular, monospace' },
    color: { bg: '#141110', panel: '#1E1915', panelAlt: '#2C2520', line: '#3D332D',
      ink: '#EAE3D9', soft: '#A39B92', faint: '#7C736B',
      accent: '#F59E0B', accent2: '#FBBF24', onAccent: '#141110',
      sev: ['#F59E0B', '#FBBF24', '#7F97A4'] },
  },
  terminal: DECK_THEMES.terminal,
  paper: DECK_THEMES.paper,
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// **emphasis** -> <span class="accent">; everything else escaped. Sanitized first.
function rich(markup) {
  const { plain, ranges } = parseEmph(sanitize(markup));
  if (!ranges.length) return esc(plain);
  let out = '', i = 0;
  for (const r of ranges) {
    out += esc(plain.slice(i, r.start));
    out += `<span class="accent">${esc(plain.slice(r.start, r.end))}</span>`;
    i = r.end;
  }
  out += esc(plain.slice(i));
  return out;
}

function wordmark(brand) {
  const name = esc((brand && brand.name) || 'Atris');
  const ac = (brand && brand.accent) || '';
  return `<div class="mark">${name}${ac ? `<b>${esc(ac)}</b>` : ''}</div>`;
}

function panelHtml(p) {
  const rows = (p.rows || []).map((r, i) => `
        <div class="row${r.active ? ' active' : ''}">
          <span class="sev s${(r.sev != null ? r.sev : 0) % 3}"></span>
          <div class="name">${rich(r.title || '')}${r.sub ? `<small>${rich(r.sub)}</small>` : ''}</div>
          ${r.value != null ? `<div class="val"><b>${rich(String(r.value))}</b>${r.valueSub ? `<small>${rich(r.valueSub)}</small>` : ''}</div>` : ''}
        </div>`).join('');
  return `<div class="panel">
        ${p.header ? `<div class="panel-head"><span>${rich(p.header.title || '')}</span>${p.header.meta ? `<span class="meta">${rich(p.header.meta)}</span>` : ''}</div>` : ''}
        ${rows}
        ${p.footer ? `<div class="panel-foot"><span>${rich(p.footer.left || '')}</span>${p.footer.right ? `<a>${rich(p.footer.right)}</a>` : ''}</div>` : ''}
      </div>`;
}

const BLOCKS = {
  title(s, spec) {
    return `<section class="block hero" data-atris-block="hero">
      <div class="lede">
        ${wordmark(spec.brand)}
        <div class="rule"></div>
        <h1>${rich(s.headline || s.title || '')}</h1>
        ${s.sub ? `<p class="sub">${rich(s.sub)}</p>` : ''}
      </div>
      ${s.panel ? panelHtml(s.panel) : ''}
    </section>`;
  },
  statement(s) {
    return `<section class="block statement" data-atris-block="statement">
      <h2 class="big">${rich(s.text || s.headline || '')}</h2>
      ${s.sub ? `<p class="sub">${rich(s.sub)}</p>` : ''}
    </section>`;
  },
  columns(s) {
    const cols = (s.columns || []).map((c) => `
        <div class="col"><h3>${rich(c.h || c.title || '')}</h3>${(c.b || c.body) ? `<p>${rich(c.b || c.body)}</p>` : ''}</div>`).join('');
    return `<section class="block columns" data-atris-block="columns">
      ${s.heading ? `<h2 class="heading">${rich(s.heading)}</h2>` : ''}
      <div class="cols c${Math.min((s.columns || []).length, 4)}">${cols}</div>
    </section>`;
  },
  panel(s) {
    return `<section class="block panel-block" data-atris-block="panel">
      <div class="panel-lede">${s.heading ? `<h2>${rich(s.heading)}</h2>` : ''}${s.sub ? `<p>${rich(s.sub)}</p>` : ''}</div>
      ${panelHtml(s.panel || { rows: [] })}
    </section>`;
  },
  bignumber(s) {
    return `<section class="block bignumber" data-atris-block="bignumber">
      <div class="num">${rich(String(s.number || s.value || ''))}</div>
      ${s.label ? `<div class="num-label">${rich(s.label)}</div>` : ''}
      ${s.sub ? `<p class="sub">${rich(s.sub)}</p>` : ''}
    </section>`;
  },
  quote(s) {
    return `<section class="block quote" data-atris-block="quote">
      <blockquote>${rich(s.text || s.quote || '')}</blockquote>
      ${s.by ? `<cite>${rich(s.by)}</cite>` : ''}
    </section>`;
  },
  toc(s) {
    const items = (s.items || []).map((it) =>
      `<a class="toc-item" href="${esc(it.href)}"><h3>${rich(it.title || it.href)}</h3>${it.summary ? `<p>${rich(it.summary)}</p>` : ''}</a>`).join('');
    return `<section class="block toc" data-atris-block="toc">
      ${s.heading ? `<h2 class="heading">${rich(s.heading)}</h2>` : ''}
      <div class="toc-grid">${items}</div>
    </section>`;
  },
  close(s, spec) {
    const btns = (s.buttons || []).map((b) => `<a class="btn${b.primary ? ' primary' : ''}">${rich(b.label || 'Open')}</a>`).join('');
    return `<section class="block close" data-atris-block="close">
      <div class="rule center"></div>
      ${wordmark(spec.brand)}
      ${s.tagline ? `<p class="tagline">${rich(s.tagline)}</p>` : ''}
      ${btns ? `<div class="btns">${btns}</div>` : ''}
      ${s.footer ? `<p class="footer">${rich(s.footer)}</p>` : ''}
    </section>`;
  },
};

function css(theme) {
  const c = theme.color, f = theme.fonts;
  const gFonts = (f.display === 'Fraunces' || f.body === 'Outfit')
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">`
    : '';
  const style = `:root{
  --brand-bg:${c.bg};--brand-card:${c.panel};--brand-surface:${c.panelAlt || c.panel};--brand-line:${c.line};
  --brand-text:${c.ink};--brand-text-secondary:${c.soft};--brand-faint:${c.faint};
  --brand-primary:${c.accent};--brand-primary-2:${c.accent2};
  --font-display:${f.display === 'TWKLausanne' ? "'TWKLausanne',system-ui,sans-serif" : `'${f.display}',serif`};
  --font-body:${f.body === 'TWKLausanne' ? "'TWKLausanne',system-ui,sans-serif" : `'${f.body}',sans-serif`};
  --ease:cubic-bezier(.25,1,.5,1);--measure:60ch;
}
*{margin:0;box-sizing:border-box}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-body);color:var(--brand-text);background:
  radial-gradient(120% 80% at 88% -8%, ${c.accent}1f, transparent 56%),
  radial-gradient(70% 60% at -6% 4%, ${c.soft}14, transparent 52%), var(--brand-bg);
  line-height:1.5;font-variant-numeric:tabular-nums}
.wrap{max-width:1140px;margin:0 auto;padding:clamp(28px,5vw,72px) clamp(20px,5vw,56px)}
.block{padding:clamp(40px,7vw,96px) 0;border-bottom:1px solid var(--brand-line)}
.block:last-child{border-bottom:0}
.mark{font-family:var(--font-display);font-weight:500;font-size:20px;letter-spacing:-.01em}
.mark b{color:var(--brand-primary);font-weight:500}
.rule{width:40px;height:2px;background:var(--brand-primary);margin:22px 0}.rule.center{margin:0 auto 22px}
.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:clamp(32px,6vw,80px);align-items:center;border-bottom:0;padding-top:clamp(24px,4vw,48px)}
@media(max-width:860px){.hero{grid-template-columns:1fr}}
h1{font-family:var(--font-display);font-weight:300;font-size:clamp(2.6rem,6vw,4.6rem);line-height:.99;letter-spacing:-.02em}
.accent{color:var(--brand-primary-2);font-style:italic}
.sub{max-width:var(--measure);color:var(--brand-text-secondary);font-size:clamp(1rem,1.4vw,1.15rem);margin-top:22px}
.big{font-family:var(--font-display);font-weight:300;font-size:clamp(2.2rem,5vw,3.6rem);line-height:1.02;letter-spacing:-.02em}
.heading{font-family:var(--font-display);font-weight:400;font-size:clamp(1.6rem,3vw,2rem);margin-bottom:34px}
.cols{display:grid;gap:clamp(20px,4vw,48px)}.cols.c2{grid-template-columns:repeat(2,1fr)}.cols.c3{grid-template-columns:repeat(3,1fr)}.cols.c4{grid-template-columns:repeat(4,1fr)}
@media(max-width:720px){.cols{grid-template-columns:1fr!important}}
.col{border-top:1px solid var(--brand-line);padding-top:18px}
.col h3{font-family:var(--font-display);font-weight:400;font-size:1.25rem;margin-bottom:8px}
.col p{color:var(--brand-text-secondary);font-size:.97rem;max-width:36ch}
.panel-block{display:grid;grid-template-columns:.85fr 1.15fr;gap:clamp(24px,5vw,64px);align-items:center}
@media(max-width:760px){.panel-block{grid-template-columns:1fr}}
.panel-lede h2{font-family:var(--font-display);font-weight:400;font-size:1.7rem;margin-bottom:14px}
.panel-lede p{color:var(--brand-text-secondary);max-width:34ch}
.panel{background:var(--brand-card);border:1px solid var(--brand-line);border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.18)}
.panel-head{display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--brand-line);font-size:14px}
.panel-head .meta{color:var(--brand-faint);font-size:12.5px}
.row{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--brand-surface)}
.row:last-child{border-bottom:0}.row.active{border-left:2px solid var(--brand-primary);padding-left:16px}
.sev{width:8px;height:8px;border-radius:50%}.sev.s0{background:var(--brand-primary)}.sev.s1{background:var(--brand-primary-2)}.sev.s2{background:#7f97a4}
.name{font-size:14.5px}.name small{display:block;color:var(--brand-faint);font-size:12.5px;margin-top:3px}
.val{text-align:right;font-size:12.5px;color:var(--brand-faint)}.val b{display:block;color:var(--brand-text);font-size:15px}
.panel-foot{display:flex;justify-content:space-between;padding:13px 18px;font-size:13px;color:var(--brand-faint)}
.panel-foot a{color:var(--brand-primary-2);text-decoration:none}
.bignumber .num{font-family:var(--font-display);font-weight:300;font-size:clamp(3.5rem,11vw,7rem);line-height:1;color:var(--brand-primary-2)}
.num-label{font-size:1.05rem;margin-top:18px}
.quote blockquote{font-family:var(--font-display);font-weight:300;font-style:italic;font-size:clamp(1.6rem,3.4vw,2.4rem);line-height:1.25;max-width:24ch;quotes:'\\201C''\\201D'}
.quote blockquote::before{content:open-quote;color:var(--brand-primary)}.quote blockquote::after{content:close-quote;color:var(--brand-primary)}
.quote cite{display:block;margin-top:20px;color:var(--brand-text-secondary);font-style:normal;font-size:.95rem}
.close{text-align:center;border-bottom:0}
.close .mark{font-family:var(--font-display);font-size:clamp(2.4rem,6vw,3.4rem);font-weight:400}
.tagline{color:var(--brand-text-secondary);margin-top:10px}
.btns{display:flex;gap:12px;justify-content:center;margin-top:28px}
.btn{padding:12px 22px;border-radius:11px;border:1px solid var(--brand-line);color:var(--brand-text);text-decoration:none;font-weight:500;font-size:15px;transition:transform 160ms var(--ease),background-color 160ms var(--ease)}
.btn:hover{transform:translateY(-1px)}.btn.primary{background:var(--brand-text);color:var(--brand-bg);border-color:var(--brand-text)}
.footer{margin-top:30px;color:var(--brand-faint);font-size:13px}
.sitenav{display:flex;justify-content:space-between;align-items:baseline;max-width:1140px;margin:0 auto;padding:20px clamp(20px,5vw,56px);border-bottom:1px solid var(--brand-line)}
.sitenav .mark{font-size:18px;text-decoration:none;color:var(--brand-text)}
.sitenav .nav-links{display:flex;gap:24px;font-size:14px;color:var(--brand-text-secondary)}
.sitenav .nav-links a{color:inherit;text-decoration:none;transition:color 160ms var(--ease)}
.sitenav .nav-links a:hover{color:var(--brand-text)}
.toc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:clamp(16px,3vw,32px)}
.toc-item{display:block;border-top:1px solid var(--brand-line);padding-top:16px;text-decoration:none;color:inherit;transition:border-color 160ms var(--ease)}
.toc-item:hover{border-color:var(--brand-primary)}
.toc-item h3{font-family:var(--font-display);font-weight:400;font-size:1.15rem;margin-bottom:6px}
.toc-item p{color:var(--brand-text-secondary);font-size:.92rem;max-width:40ch}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;
  return { gFonts, style };
}

function renderBody(spec, opts = {}) {
  const themes = opts.themes || THEMES;
  const theme = themes[spec.theme] || THEMES.atris;
  const blocks = (spec.slides || spec.blocks || [])
    .map((s) => (BLOCKS[s.type] || BLOCKS.statement)(s, spec))
    .join('\n      ');
  return { theme, html: `<div class="wrap">\n      ${blocks}\n    </div>` };
}

function renderNav(nav) {
  const links = (nav.links || []).map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join('');
  return `<nav class="sitenav"><a class="mark" href="${esc(nav.home || 'index.html')}">${esc(nav.label || 'Atris')}${nav.accent ? `<b>${esc(nav.accent)}</b>` : ''}</a>${links ? `<div class="nav-links">${links}</div>` : ''}</nav>`;
}

// full standalone page (opts.nav renders a site header, opts.themes injects brand themes)
function renderHtml(spec, opts = {}) {
  const { theme, html } = renderBody(spec, opts);
  const { gFonts, style } = css(theme);
  const title = esc(sanitize(opts.title || (spec.brand && spec.brand.name) || 'Atris'));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${gFonts}
<style>${style}</style>
</head>
<body data-atris-theme="${esc(spec.theme || 'atris')}">
    ${opts.nav ? renderNav(opts.nav) : ''}
    ${html}
</body>
</html>`;
}

// AppBlock html shape, ready to embed in an Atris app (ui_template 'html'/'block')
function renderBlock(spec, opts = {}) {
  return {
    type: 'html',
    title: opts.title || (spec.brand && spec.brand.name) || 'Atris',
    config: {
      block_type: 'html',
      title: opts.title || (spec.brand && spec.brand.name) || 'Atris',
      html: renderHtml(spec, opts),
      theme: spec.theme || 'atris',
    },
  };
}

module.exports = { renderHtml, renderBlock, renderBody, THEMES, BLOCKS, rich, esc };
