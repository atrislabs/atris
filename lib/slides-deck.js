// Atris deck engine — turn a plain content spec into a premium, anti-slop
// Google Slides deck. Pure: spec -> batch-update requests (no network here).
//
// The product idea: PMs open Slides and get Arial-on-white slop by default.
// This engine gives them a described deck rendered in a committed design system
// (own backgrounds, distinctive fonts, one accent, real data panels). It is
// built so it CANNOT emit the usual AI tells: em dashes are sanitized, labels
// stay sentence case, no gradient text, no glassmorphism, one accent hue.
//
// Spec shape (see commands/deck.js for the CLI):
//   { theme: 'terminal'|'paper',
//     brand: { name: 'Sentinel', accent: '.' },
//     slides: [ { type, ...fields } ] }
// Emphasis: wrap a phrase in **double asterisks** to render it in the accent.

// ---------- themes (OKLCH design system, flattened to sRGB hex) ----------
const THEMES = {
  terminal: { // warm dark "premium terminal"
    fonts: { display: 'Fraunces', body: 'Outfit', mono: 'Roboto Mono' },
    color: { bg: '#1E1A16', panel: '#2A231C', panelAlt: '#2F271F', line: '#3A332B',
      ink: '#ECE6DD', soft: '#BCB2A4', faint: '#968C7E',
      accent: '#D98E5C', accent2: '#E3A06B', onAccent: '#1E1A16',
      sev: ['#D98E5C', '#DBBE84', '#7F97A4'] },
  },
  paper: { // light "editorial paper instrument"
    fonts: { display: 'Fraunces', body: 'Outfit', mono: 'Roboto Mono' },
    color: { bg: '#FBF8F2', panel: '#FFFFFF', panelAlt: '#F4EEE4', line: '#E5DDCF',
      ink: '#2B241B', soft: '#6B5F4F', faint: '#877B69',
      accent: '#B5572E', accent2: '#9A4723', onAccent: '#FFFFFF',
      sev: ['#B5572E', '#C0883A', '#5F7787'] },
  },
};
const COLOR_ROLES = ['bg', 'panel', 'line', 'ink', 'soft', 'faint', 'accent', 'accent2', 'onAccent'];

const W = 720, H = 405, M = 48; // slide is 720 x 405 PT

// ---------- low-level builder ----------
function rgb(hex) { const n = parseInt(String(hex).slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 }; }

// strip the AI tells the engine refuses to ship. Returns sanitized text.
function sanitize(t) {
  return String(t == null ? '' : t)
    .replace(/\s*[—]\s*/g, ', ')   // em dash -> comma (top AI-writing tell)
    .replace(/\s-\s/g, ', ')         // spaced hyphen used as a dash
    .replace(/\bAI-powered\b/gi, 'built for')
    .replace(/\s{2,}/g, ' ');
}

// parse **emphasis** -> { plain, ranges:[{start,end}] } (indices into plain)
function parseEmph(text) {
  const ranges = []; let plain = ''; let i = 0;
  while (i < text.length) {
    if (text[i] === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close !== -1) { const inner = text.slice(i + 2, close);
        ranges.push({ start: plain.length, end: plain.length + inner.length });
        plain += inner; i = close + 2; continue; }
    }
    plain += text[i]; i++;
  }
  return { plain, ranges };
}

function makeCtx(theme) {
  const C = theme.color, F = theme.fonts, requests = [];
  let uid = 0; const nid = (p) => `${p}_${String(++uid).padStart(4, '0')}`;

  const createSlide = (id) => requests.push({ createSlide: { objectId: id, slideLayoutReference: { predefinedLayout: 'BLANK' } } });
  const bg = (slide, hex) => requests.push({ updatePageProperties: { objectId: slide,
    pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb(hex) } } } },
    fields: 'pageBackgroundFill.solidFill.color' } });
  const shape = (type, slide, x, y, w, h) => { const id = nid(type.slice(0, 2).toLowerCase());
    requests.push({ createShape: { objectId: id, shapeType: type, elementProperties: {
      pageObjectId: slide, size: { width: { magnitude: w, unit: 'PT' }, height: { magnitude: h, unit: 'PT' } },
      transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'PT' } } } }); return id; };
  const fill = (id, hex, outlineHex, weight) => {
    const props = { shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb(hex) } } } };
    let fields = 'shapeBackgroundFill.solidFill.color';
    if (outlineHex) { props.outline = { outlineFill: { solidFill: { color: { rgbColor: rgb(outlineHex) } } }, weight: { magnitude: weight || 1, unit: 'PT' } }; fields += ',outline.outlineFill.solidFill.color,outline.weight'; }
    else { props.outline = { propertyState: 'NOT_RENDERED' }; fields += ',outline.propertyState'; }
    requests.push({ updateShapeProperties: { objectId: id, shapeProperties: props, fields } }); return id; };
  function styleRange(id, s, e, o) { if (e <= s || !o) return;
    const style = {}, f = [];
    if (o.family) { style.fontFamily = o.family; f.push('fontFamily'); }
    if (o.size) { style.fontSize = { magnitude: o.size, unit: 'PT' }; f.push('fontSize'); }
    if (o.color) { style.foregroundColor = { opaqueColor: { rgbColor: rgb(o.color) } }; f.push('foregroundColor'); }
    if (o.bold) { style.bold = true; f.push('bold'); }
    if (o.italic) { style.italic = true; f.push('italic'); }
    if (!f.length) return;
    requests.push({ updateTextStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: s, endIndex: e }, style, fields: f.join(',') } }); }
  function box(slide, x, y, w, h, markup, opts = {}) {
    const { plain, ranges } = parseEmph(sanitize(markup));
    if (!plain.length) return null;
    const id = shape('TEXT_BOX', slide, x, y, w, h);
    requests.push({ insertText: { objectId: id, text: plain } });
    styleRange(id, 0, plain.length, opts);
    const accentColor = opts.accent || C.accent2;
    ranges.forEach((r) => styleRange(id, r.start, r.end, { family: opts.family, size: opts.size, color: accentColor, italic: opts.emphItalic }));
    if (opts.align || opts.line != null) requests.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' },
      style: { ...(opts.align ? { alignment: opts.align } : {}), ...(opts.line != null ? { lineSpacing: opts.line } : {}) },
      fields: [opts.align && 'alignment', opts.line != null && 'lineSpacing'].filter(Boolean).join(',') } });
    if (opts.vmid) requests.push({ updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: 'MIDDLE' }, fields: 'contentAlignment' } });
    return id; }
  const rule = (slide, x, y, w, hex) => fill(shape('RECTANGLE', slide, x, y, w, 2), hex || C.accent);

  function wordmark(slide, x, y, size, brand, center) {
    const name = (brand && brand.name) || 'Atris';
    const ac = (brand && brand.accent) || '';
    const id = box(slide, x, y, center ? W - x * 2 : size * 9, size * 1.6, name + ac,
      { family: F.display, size, color: C.ink, align: center ? 'CENTER' : 'START' });
    if (ac) styleRange(id, name.length, name.length + ac.length, { family: F.display, size, color: C.accent });
    return id; }

  // generalized data panel: header + rows + footer
  function panel(slide, x, y, w, data) {
    const rows = (data.rows || []).slice(0, 4);
    const rowH = 38, headH = data.header ? 30 : 0, footH = data.footer ? 26 : 0;
    const h = headH + rowH * rows.length + footH;
    fill(shape('ROUND_RECTANGLE', slide, x, y, w, h), C.panel, C.line, 1);
    if (data.header) {
      box(slide, x + 14, y + 9, w * 0.6, 16, data.header.title || '', { family: F.body, size: 10.5, color: C.ink });
      if (data.header.meta) box(slide, x + w - 120, y + 9, 106, 14, data.header.meta, { family: F.body, size: 8.5, color: C.faint, align: 'END' });
      fill(shape('RECTANGLE', slide, x, y + headH, w, 0.75), C.line);
    }
    rows.forEach((r, i) => {
      const ry = y + headH + i * rowH;
      if (r.active) fill(shape('RECTANGLE', slide, x, ry, 2, rowH), C.accent);
      const sev = C.sev[(r.sev != null ? r.sev : 0) % C.sev.length];
      fill(shape('ELLIPSE', slide, x + 16, ry + rowH / 2 - 3.5, 7, 7), sev);
      const nameTxt = sanitize(r.title || '') + (r.sub ? '\n' + sanitize(r.sub) : '');
      const nb = box(slide, x + 30, ry + 6, w - 110, 28, nameTxt, { family: F.body, size: 11, color: C.ink, line: 108 });
      if (r.sub && nb) styleRange(nb, sanitize(r.title || '').length + 1, nameTxt.length, { family: F.body, size: 9, color: C.faint });
      if (r.value != null) {
        const valTxt = String(r.value) + (r.valueSub ? '\n' + r.valueSub : '');
        const bb = box(slide, x + w - 84, ry + 6, 70, 28, valTxt, { family: F.body, size: 11, color: C.ink, align: 'END' });
        if (bb) { styleRange(bb, 0, String(r.value).length, { family: F.body, size: 13, color: C.ink, bold: true });
          if (r.valueSub) styleRange(bb, String(r.value).length + 1, valTxt.length, { family: F.body, size: 8, color: C.faint }); }
      }
      if (i < rows.length - 1) fill(shape('RECTANGLE', slide, x, ry + rowH, w, 0.75), C.panelAlt);
    });
    if (data.footer) { const fy = y + headH + rowH * rows.length;
      box(slide, x + 14, fy + 6, w * 0.62, 14, data.footer.left || '', { family: F.body, size: 9, color: C.faint });
      if (data.footer.right) box(slide, x + w - 84, fy + 6, 70, 14, data.footer.right, { family: F.body, size: 9, color: C.accent2, align: 'END' }); }
    return h; }

  function chips(slide, x, y, list) { let cx = x;
    (list || []).forEach((label) => { const t = sanitize(label); const w = 16 + t.length * 6.3;
      fill(shape('ROUND_RECTANGLE', slide, cx, y, w, 24), C.panel, C.line, 1);
      box(slide, cx, y, w, 24, t, { family: F.mono, size: 9.5, color: C.faint, align: 'CENTER', vmid: true });
      cx += w + 10; }); }

  function buttons(slide, y, list) {
    const items = (list || []).slice(0, 3); const bw = 150, bh = 34, gap = 12;
    const total = items.length * bw + (items.length - 1) * gap; let bx = (W - total) / 2;
    items.forEach((b) => { const primary = b.primary;
      fill(shape('ROUND_RECTANGLE', slide, bx, y, bw, bh), primary ? C.ink : C.bg, primary ? null : C.line, 1);
      box(slide, bx, y, bw, bh, b.label || 'Button', { family: F.body, size: 12.5, color: primary ? C.bg : C.ink, align: 'CENTER', vmid: true });
      bx += bw + gap; }); }

  return { requests, C, F, nid, createSlide, bg, shape, fill, box, styleRange, rule, wordmark, panel, chips, buttons };
}

// ---------- slide archetypes ----------
const ARCHE = {
  title(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 34, 15, spec.brand);
    ctx.rule(slide, M, 96, 40);
    const hasPanel = !!s.panel;
    ctx.box(slide, M, 110, hasPanel ? 360 : 600, 180, s.headline || s.title || '',
      { family: ctx.F.display, size: 40, color: ctx.C.ink, line: 100, emphItalic: true });
    if (s.sub) ctx.box(slide, M, hasPanel ? 300 : 300, hasPanel ? 350 : 540, 70, s.sub, { family: ctx.F.body, size: 12.5, color: ctx.C.soft, line: 120 });
    if (hasPanel) ctx.panel(slide, 432, 96, 240, s.panel);
  },
  statement(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 34, 13, spec.brand);
    ctx.rule(slide, M, 150, 40);
    ctx.box(slide, M, 164, 600, 120, s.text || s.headline || '', { family: ctx.F.display, size: 46, color: ctx.C.ink, line: 100, emphItalic: true });
    if (s.sub) ctx.box(slide, M, 286, 480, 70, s.sub, { family: ctx.F.body, size: 14, color: ctx.C.soft, line: 130 });
  },
  columns(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 34, 13, spec.brand);
    if (s.heading) ctx.box(slide, M, 110, 560, 34, s.heading, { family: ctx.F.display, size: 26, color: ctx.C.ink });
    const cols = (s.columns || []).slice(0, 4); const n = cols.length || 1;
    const span = W - M * 2, gap = 16, colW = (span - (n - 1) * gap) / n, cy = s.heading ? 188 : 150;
    cols.forEach((c, i) => { const cx = M + i * (colW + gap);
      if (i > 0) ctx.fill(ctx.shape('RECTANGLE', slide, cx - gap / 2, cy, 0.75, 120), ctx.C.line);
      ctx.box(slide, cx, cy, colW - 8, 30, c.h || c.title || '', { family: ctx.F.display, size: 17, color: ctx.C.ink });
      ctx.box(slide, cx, cy + 34, colW - 8, 120, c.b || c.body || '', { family: ctx.F.body, size: 11.5, color: ctx.C.soft, line: 134 }); });
  },
  panel(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 34, 13, spec.brand);
    if (s.heading) ctx.box(slide, M, 120, 260, 50, s.heading, { family: ctx.F.display, size: 30, color: ctx.C.ink });
    if (s.sub) ctx.box(slide, M, 178, 260, 160, s.sub, { family: ctx.F.body, size: 12.5, color: ctx.C.soft, line: 132 });
    ctx.panel(slide, 360, 110, 312, s.panel || { rows: [] });
  },
  chips(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 34, 13, spec.brand);
    if (s.heading) ctx.box(slide, M, 110, 580, 34, s.heading, { family: ctx.F.display, size: 28, color: ctx.C.ink });
    if (s.sub) ctx.box(slide, M, 162, 480, 64, s.sub, { family: ctx.F.body, size: 12.5, color: ctx.C.soft, line: 132 });
    ctx.chips(slide, M, 250, s.chips || []);
    if (s.mono) ctx.box(slide, M, 300, 520, 24, s.mono, { family: ctx.F.mono, size: 12, color: ctx.C.accent2 });
  },
  bignumber(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 34, 13, spec.brand);
    ctx.box(slide, M, 138, W - M * 2, 120, s.number || s.value || '', { family: ctx.F.display, size: 92, color: ctx.C.accent2, line: 100 });
    if (s.label) ctx.box(slide, M, 268, 520, 30, s.label, { family: ctx.F.body, size: 16, color: ctx.C.ink });
    if (s.sub) ctx.box(slide, M, 300, 480, 50, s.sub, { family: ctx.F.body, size: 12.5, color: ctx.C.soft, line: 130 });
  },
  close(ctx, slide, s, spec) {
    ctx.rule(slide, (W - 48) / 2, 150, 48);
    const name = (spec.brand && spec.brand.name) || 'Atris';
    const ac = (spec.brand && spec.brand.accent) || '';
    const id = ctx.box(slide, 0, 168, W, 64, name + ac, { family: ctx.F.display, size: 52, color: ctx.C.ink, align: 'CENTER' });
    if (ac && id) ctx.styleRange(id, name.length, name.length + ac.length, { family: ctx.F.display, size: 52, color: ctx.C.accent });
    if (s.tagline) ctx.box(slide, 0, 244, W, 24, s.tagline, { family: ctx.F.body, size: 14, color: ctx.C.soft, align: 'CENTER' });
    if (s.buttons) ctx.buttons(slide, 296, s.buttons);
    if (s.footer) ctx.box(slide, 0, 360, W, 20, s.footer, { family: ctx.F.body, size: 10, color: ctx.C.faint, align: 'CENTER' });
  },
};

// ---------- public: spec -> requests ----------
function buildDeck(spec) {
  const theme = THEMES[spec.theme] || THEMES.terminal;
  const ctx = makeCtx(theme);
  const slideIds = [];
  (spec.slides || []).forEach((s, i) => {
    const sid = `deck_slide_${i + 1}`; slideIds.push(sid);
    ctx.createSlide(sid);
    ctx.bg(sid, theme.color.bg);
    (ARCHE[s.type] || ARCHE.statement)(ctx, sid, s, spec);
  });
  return { requests: ctx.requests, slideIds };
}

module.exports = { buildDeck, THEMES, ARCHE, sanitize, parseEmph, rgb, COLOR_ROLES };
