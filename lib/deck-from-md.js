// Markdown -> deck spec. Lets a PM write an ordinary doc and get a designed deck.
// Pure: a markdown string in, a { theme, brand, slides } spec out (fed to buildDeck).
//
// Mapping (predictable on purpose):
//   --- front matter ---   theme / brand / accent
//   # H1 (first)           -> title slide (sub = the paragraph under it)
//   ## H2 with 2-4 bullets -> columns slide (each bullet "**Lead** rest" -> a column)
//   ## H2 with "**X** label" only -> bignumber slide
//   ## H2 titled Close/CTA/Thanks -> close slide
//   ## H2 otherwise        -> statement slide (sub = the paragraph under it)
// Emphasis (**bold**) is preserved and rendered in the accent by the engine.

function parseFrontMatter(md) {
  const out = { theme: null, brand: null, accent: null };
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: md, fm: out };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.+?)\s*$/);
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    const v = kv[2].trim().replace(/^["']|["']$/g, '');
    if (k === 'theme') out.theme = v;
    else if (k === 'brand') out.brand = v;
    else if (k === 'accent') out.accent = v;
  }
  return { body: md.slice(m[0].length), fm: out };
}

// group a section's lines into bullets[] and paragraphs[]
function splitBody(lines) {
  const bullets = [];
  const paras = [];
  let buf = [];
  const flush = () => { if (buf.length) { paras.push(buf.join(' ').trim()); buf = []; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*[-*+]\s+/.test(line)) { flush(); bullets.push(line.replace(/^\s*[-*+]\s+/, '').trim()); }
    else if (/^\s*$/.test(line)) flush();
    else if (/^\s*>\s+/.test(line)) { flush(); paras.push(line.replace(/^\s*>\s+/, '').trim()); }
    else buf.push(line.trim());
  }
  flush();
  return { bullets, paras: paras.filter(Boolean) };
}

// "**Lead** rest" / "Lead: rest" / "Lead - rest" -> { h, b }
function toColumn(bullet) {
  let m = bullet.match(/^\*\*(.+?)\*\*[\s:.-]*(.*)$/);
  if (m) return { h: m[1].trim(), b: m[2].trim() };
  m = bullet.match(/^([^:]{2,48}):\s+(.+)$/);
  if (m) return { h: m[1].trim(), b: m[2].trim() };
  return { h: bullet.trim(), b: '' };
}

// a single "**value** label" paragraph -> big number slide
function asBigNumber(paras, bullets) {
  if (bullets.length || paras.length !== 1) return null;
  const m = paras[0].match(/^\*\*([^*]{1,18})\*\*\s+(.+)$/);
  if (!m) return null;
  return { type: 'bignumber', number: m[1].trim(), label: m[2].trim() };
}

const CLOSE_TITLES = /^(close|thanks|thank you|cta|call to action|get started|wrap up|next steps?)$/i;

function parseMarkdownToSpec(md, opts = {}) {
  const { body, fm } = parseFrontMatter(String(md || ''));
  const theme = opts.theme || fm.theme || 'terminal';
  const brand = {
    name: opts.brandName || fm.brand || 'Atris',
    accent: opts.accent || fm.accent || '.',
  };

  // collect sections by heading
  const sections = [];
  let cur = null;
  for (const raw of body.split(/\r?\n/)) {
    const h1 = raw.match(/^#\s+(.+)/);
    const h2 = raw.match(/^##\s+(.+)/);
    if (h1) { cur = { level: 1, title: h1[1].trim(), lines: [] }; sections.push(cur); }
    else if (h2) { cur = { level: 2, title: h2[1].trim(), lines: [] }; sections.push(cur); }
    else if (cur) cur.lines.push(raw);
  }

  const slides = [];
  sections.forEach((sec, idx) => {
    const { bullets, paras } = splitBody(sec.lines);
    const firstPara = paras[0] || '';

    if (sec.level === 1 && slides.length === 0) {
      slides.push({ type: 'title', headline: sec.title, sub: firstPara || undefined });
      return;
    }
    if (CLOSE_TITLES.test(sec.title)) {
      slides.push({ type: 'close', tagline: firstPara || sec.title, footer: bullets[0] || undefined });
      return;
    }
    const big = asBigNumber(paras, bullets);
    if (big) { slides.push(big); return; }
    if (bullets.length >= 2 && bullets.length <= 4 && bullets.every((b) => b.length <= 160)) {
      slides.push({ type: 'columns', heading: sec.title, columns: bullets.map(toColumn) });
      return;
    }
    slides.push({ type: 'statement', text: sec.title, sub: firstPara || undefined });
  });

  if (!slides.length) slides.push({ type: 'statement', text: brand.name });
  return { theme, brand, slides };
}

module.exports = { parseMarkdownToSpec, parseFrontMatter, splitBody, toColumn };
