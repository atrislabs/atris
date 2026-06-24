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
//   { theme: 'terminal'|'paper'|'ink'|'noir',
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
  ink: { // stark light "magazine proof"
    fonts: { display: 'Fraunces', body: 'Outfit', mono: 'Roboto Mono' },
    color: { bg: '#FAFAF8', panel: '#FFFFFF', panelAlt: '#F2F2EE', line: '#D8D8D2',
      ink: '#111110', soft: '#4A4A46', faint: '#7A7A74',
      accent: '#C41E3A', accent2: '#9B1830', onAccent: '#FFFFFF',
      sev: ['#C41E3A', '#B8860B', '#2F4F6F'] },
  },
  noir: { // cool dark "broadcast / podcast"
    fonts: { display: 'Fraunces', body: 'Outfit', mono: 'Roboto Mono' },
    color: { bg: '#0E1117', panel: '#161B22', panelAlt: '#1C2129', line: '#2D333B',
      ink: '#E6EDF3', soft: '#9BA7B4', faint: '#6E7681',
      accent: '#58A6FF', accent2: '#79C0FF', onAccent: '#0E1117',
      sev: ['#58A6FF', '#D2A854', '#3FB950'] },
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

// ---------- fit estimation (keep dense text on the slide) ----------
// Slides text boxes do not auto-shrink: text that wraps past the slide edge
// (H = 405 PT) is clipped. These estimate wrapped height so an archetype can
// pick the largest font that still fits the vertical space it has.
function estLines(text, w, size) {
  const cpl = Math.max(1, Math.floor(w / (size * 0.52))); // ~chars per line, proportional
  return String(text == null ? '' : text)
    .split('\n')
    .reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / cpl)), 0);
}
function lineHeight(size, linePct) { return size * 1.15 * (linePct / 100); }
// Largest size in [minSize, baseSize] whose wrapped text fits maxH.
function fitSize(text, w, maxH, baseSize, minSize, linePct = 120) {
  for (let s = baseSize; s > minSize; s -= 0.5) {
    if (estLines(text, w, s) * lineHeight(s, linePct) <= maxH) return s;
  }
  return minSize;
}
// Smallest fit across several texts sharing one column width (uniform sizing).
function fitSizeAll(texts, w, maxH, baseSize, minSize, linePct = 120) {
  return Math.min(baseSize, ...texts.map((t) => fitSize(t, w, maxH, baseSize, minSize, linePct)));
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
    const rowH = 38, headH = data.header ? 30 : 0, footH = data.footer ? 28 : 0;
    const h = headH + rowH * rows.length + footH;
    fill(shape('ROUND_RECTANGLE', slide, x, y, w, h), C.panel, C.line, 1);
    if (data.header) {
      box(slide, x + 14, y + 9, w * 0.6, 16, data.header.title || '', { family: F.body, size: 10.5, color: C.ink });
      if (data.header.meta) box(slide, x + w - 120, y + 9, 106, 14, data.header.meta, { family: F.body, size: 8.5, color: C.faint, align: 'END' });
      fill(shape('RECTANGLE', slide, x, y + headH, w, 0.75), C.line);
    }
    rows.forEach((r, i) => {
      const ry = y + headH + i * rowH;
      const sev = C.sev[(r.sev != null ? r.sev : 0) % C.sev.length];
      fill(shape('ELLIPSE', slide, x + 16, ry + rowH / 2 - 3.5, 7, 7), r.active ? C.accent : sev);
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
    if (data.footer) {
      const fy = y + headH + rowH * rows.length;
      box(slide, x + 14, fy + 5, w * 0.55, 16, data.footer.left || '',
        { family: F.body, size: 9, color: C.faint });
      if (data.footer.right) {
        box(slide, x + w - 108, fy + 5, 94, 16, data.footer.right,
          { family: F.body, size: 9, color: C.accent2, align: 'END' });
      }
    }
    return h; }

  function chips(slide, x, y, list, maxW = W - M * 2) {
    let cx = x;
    let cy = y;
    const rowH = 32;
    (list || []).forEach((label) => {
      const t = sanitize(label);
      const w = Math.min(maxW, 16 + t.length * 6.3);
      if (cx > x && cx + w > x + maxW) {
        cx = x;
        cy += rowH;
      }
      fill(shape('ROUND_RECTANGLE', slide, cx, cy, w, 24), C.panel, C.line, 1);
      box(slide, cx, cy, w, 24, t, { family: F.mono, size: 9.5, color: C.faint, align: 'CENTER', vmid: true });
      cx += w + 10;
    });
    return cy + 24;
  }

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
    const hasPanel = !!s.panel;
    ctx.wordmark(slide, M, 28, 14, spec.brand);
    ctx.rule(slide, M, 86, 40);
    const headlineSize = hasPanel ? 34 : 38;
    const headlineW = hasPanel ? 340 : 580;
    const headlineH = hasPanel ? 132 : 150;
    ctx.box(slide, M, 98, headlineW, headlineH, s.headline || s.title || '',
      { family: ctx.F.display, size: headlineSize, color: ctx.C.ink, line: 96 });
    if (s.sub) {
      ctx.box(slide, M, hasPanel ? 236 : 258, hasPanel ? 330 : 520, 88, s.sub,
        { family: ctx.F.body, size: 12, color: ctx.C.soft, line: 118 });
    }
    if (hasPanel) ctx.panel(slide, 404, 88, 268, s.panel);
  },
  statement(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    ctx.rule(slide, M, 138, 40);
    const text = s.text || s.headline || '';
    const textSize = fitSize(text, 580, 120, 38, 26, 96);
    ctx.box(slide, M, 150, 580, 118, text,
      { family: ctx.F.display, size: textSize, color: ctx.C.ink, line: 96 });
    if (s.sub) {
      const subSize = fitSize(s.sub, 560, 110, 12.5, 10, 120);
      ctx.box(slide, M, 276, 560, 108, s.sub,
        { family: ctx.F.body, size: subSize, color: ctx.C.soft, line: 120 });
    }
  },
  columns(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    const headingY = 96;
    if (s.heading) {
      ctx.box(slide, M, headingY, 580, 40, s.heading,
        { family: ctx.F.display, size: 24, color: ctx.C.ink, line: 110 });
    }
    const cols = (s.columns || []).slice(0, 4);
    const n = cols.length || 1;
    const span = W - M * 2;
    const gap = 14;
    const colW = (span - (n - 1) * gap) / n;
    const cy = s.heading ? 168 : 132;
    // One uniform body size: the largest that fits every column's text in the
    // space down to the slide floor. Narrower columns (more of them) shrink more.
    const bodyMaxH = 388 - (cy + 32);
    const bodySize = fitSizeAll(cols.map((c) => c.b || c.body || ''), colW - 6, bodyMaxH, 11, 8.5, 128);
    cols.forEach((c, i) => {
      const cx = M + i * (colW + gap);
      if (i > 0) ctx.fill(ctx.shape('RECTANGLE', slide, cx - gap / 2, cy, 0.75, 132), ctx.C.line);
      ctx.box(slide, cx, cy, colW - 6, 28, c.h || c.title || '',
        { family: ctx.F.display, size: 16, color: ctx.C.ink, line: 110 });
      ctx.box(slide, cx, cy + 32, colW - 6, 148, c.b || c.body || '',
        { family: ctx.F.body, size: bodySize, color: ctx.C.soft, line: 128 });
    });
  },
  panel(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    const headingY = 90;
    const subY = 152;
    if (s.heading) {
      ctx.box(slide, M, headingY, 312, 54, s.heading,
        { family: ctx.F.display, size: 24, color: ctx.C.ink, line: 108 });
    }
    if (s.sub) {
      ctx.box(slide, M, subY, 312, 84, s.sub,
        { family: ctx.F.body, size: 11.5, color: ctx.C.soft, line: 122 });
    }
    const rows = ((s.panel && s.panel.rows) || []).length;
    const panelH = (s.panel && s.panel.header ? 30 : 0) + 38 * rows + (s.panel && s.panel.footer ? 28 : 0);
    const panelY = Math.max(82, 118 - Math.max(0, panelH - 176) / 2);
    ctx.panel(slide, 370, panelY, 302, s.panel || { rows: [] });
  },
  chips(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    if (s.heading) {
      ctx.box(slide, M, 96, 580, 32, s.heading,
        { family: ctx.F.display, size: 26, color: ctx.C.ink });
    }
    if (s.sub) {
      ctx.box(slide, M, 136, 520, 48, s.sub,
        { family: ctx.F.body, size: 12, color: ctx.C.soft, line: 120 });
    }
    const chipBottom = ctx.chips(slide, M, 196, s.chips || []);
    if (s.mono) {
      ctx.box(slide, M, chipBottom + 14, 520, 28, s.mono,
        { family: ctx.F.mono, size: 11, color: ctx.C.accent2, line: 120 });
    }
  },
  bignumber(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    ctx.box(slide, M, 118, W - M * 2, 108, s.number || s.value || '',
      { family: ctx.F.display, size: 84, color: ctx.C.accent2, line: 96 });
    if (s.label) {
      ctx.box(slide, M, 236, 560, 36, s.label,
        { family: ctx.F.body, size: 15, color: ctx.C.ink, line: 118 });
    }
    if (s.sub) {
      ctx.box(slide, M, 278, 560, 88, s.sub,
        { family: ctx.F.body, size: 11.5, color: ctx.C.soft, line: 122 });
    }
  },
  close(ctx, slide, s, spec) {
    ctx.rule(slide, (W - 48) / 2, 132, 48);
    const name = (spec.brand && spec.brand.name) || 'Atris';
    const ac = (spec.brand && spec.brand.accent) || '';
    const id = ctx.box(slide, 0, 148, W, 58, name + ac,
      { family: ctx.F.display, size: 48, color: ctx.C.ink, align: 'CENTER' });
    if (ac && id) {
      ctx.styleRange(id, name.length, name.length + ac.length,
        { family: ctx.F.display, size: 48, color: ctx.C.accent });
    }
    if (s.tagline) {
      ctx.box(slide, 48, 218, W - 96, 40, s.tagline,
        { family: ctx.F.body, size: 13.5, color: ctx.C.soft, align: 'CENTER', line: 120 });
    }
    if (s.buttons) ctx.buttons(slide, 278, s.buttons);
    if (s.footer) {
      ctx.box(slide, 0, 352, W, 20, s.footer,
        { family: ctx.F.body, size: 10, color: ctx.C.faint, align: 'CENTER' });
    }
  },
  // --- new archetypes (v2) ---
  timeline(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    const headingY = 88;
    if (s.heading) {
      ctx.box(slide, M, headingY, 580, 36, s.heading,
        { family: ctx.F.display, size: 26, color: ctx.C.ink, line: 110 });
    }
    const steps = (s.steps || []).slice(0, 5);
    const n = steps.length || 1;
    const pad = 58;
    const startX = M + pad;
    const endX = W - M - pad;
    const trackW = endX - startX;
    const cy = 210;
    if (n > 1) {
      ctx.fill(ctx.shape('RECTANGLE', slide, startX, cy - 0.5, trackW, 1.5), ctx.C.line);
    }
    steps.forEach((step, i) => {
      const x = n === 1 ? W / 2 : startX + (trackW * i) / (n - 1);
      const active = !!step.active;
      const dotR = active ? 8 : 6;
      ctx.fill(ctx.shape('ELLIPSE', slide, x - dotR, cy - dotR, dotR * 2, dotR * 2),
        active ? ctx.C.accent : ctx.C.panelAlt, active ? ctx.C.accent : ctx.C.line, active ? 0 : 1);
      if (active) {
        ctx.fill(ctx.shape('ELLIPSE', slide, x - 3, cy - 3, 6, 6), ctx.C.onAccent);
      }
      const labelW = 104;
      const labelX = Math.max(M, Math.min(W - M - labelW, x - labelW / 2));
      ctx.box(slide, labelX, cy + 18, labelW, 22, step.label || '',
        { family: ctx.F.body, size: 11.5, color: active ? ctx.C.ink : ctx.C.soft, align: 'CENTER', line: 110 });
      if (step.sub) {
        ctx.box(slide, labelX, cy + 40, labelW, 36, step.sub,
          { family: ctx.F.body, size: 9, color: ctx.C.faint, align: 'CENTER', line: 108 });
      }
    });
    if (s.sub) {
      ctx.box(slide, M, 318, 580, 48, s.sub,
        { family: ctx.F.body, size: 11.5, color: ctx.C.soft, line: 122 });
    }
  },
  versus(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    if (s.heading) {
      ctx.box(slide, M, 88, 580, 32, s.heading,
        { family: ctx.F.display, size: 24, color: ctx.C.ink });
    }
    const colW = 296;
    const colY = 138;
    const colH = 210;
    const sides = [
      { data: s.left || {}, x: M, accent: false },
      { data: s.right || {}, x: M + colW + 32, accent: true },
    ];
    sides.forEach(({ data, x, accent }) => {
      ctx.fill(ctx.shape('ROUND_RECTANGLE', slide, x, colY, colW, colH),
        ctx.C.panel, accent ? ctx.C.accent : ctx.C.line, accent ? 1.5 : 1);
      ctx.box(slide, x + 16, colY + 16, colW - 32, 24, data.label || '',
        { family: ctx.F.display, size: 16, color: accent ? ctx.C.accent2 : ctx.C.soft, line: 110 });
      (data.items || []).slice(0, 5).forEach((item, i) => {
        const iy = colY + 52 + i * 30;
        ctx.fill(ctx.shape('ELLIPSE', slide, x + 20, iy + 8, 5, 5),
          accent ? ctx.C.accent : ctx.C.faint);
        ctx.box(slide, x + 32, iy, colW - 48, 22, item,
          { family: ctx.F.body, size: 11.5, color: ctx.C.ink, line: 118 });
      });
    });
  },
  metricgrid(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    if (s.heading) {
      ctx.box(slide, M, 88, 580, 32, s.heading,
        { family: ctx.F.display, size: 24, color: ctx.C.ink });
    }
    const metrics = (s.metrics || []).slice(0, 4);
    const cols = 2;
    const gap = 16;
    const cardW = (W - M * 2 - gap) / cols;
    const cardH = 108;
    const gridY = s.heading ? 138 : 108;
    metrics.forEach((m, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = M + col * (cardW + gap);
      const y = gridY + row * (cardH + gap);
      ctx.fill(ctx.shape('ROUND_RECTANGLE', slide, x, y, cardW, cardH), ctx.C.panel, ctx.C.line, 1);
      ctx.box(slide, x + 16, y + 16, cardW - 32, 42, m.value || '',
        { family: ctx.F.display, size: 32, color: ctx.C.accent2, line: 96 });
      ctx.box(slide, x + 16, y + 60, cardW - 32, 44, m.label || '',
        { family: ctx.F.body, size: 10, color: ctx.C.soft, line: 116 });
    });
  },
  receipt(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    const headingY = 76;
    if (s.heading) {
      ctx.box(slide, M, headingY, 320, 52, s.heading,
        { family: ctx.F.display, size: 24, color: ctx.C.ink, line: 108 });
    }
    if (s.sub) {
      ctx.box(slide, M, headingY + 60, 300, 56, s.sub,
        { family: ctx.F.body, size: 11, color: ctx.C.soft, line: 120 });
    }
    const rx = 368;
    const ry = 78;
    const rw = 304;
    const fields = (s.fields || []).slice(0, 6);
    const rh = 48 + fields.length * 36 + (s.stamp ? 44 : 16);
    ctx.fill(ctx.shape('ROUND_RECTANGLE', slide, rx, ry, rw, rh), ctx.C.panel, ctx.C.line, 1);
    ctx.box(slide, rx + 16, ry + 12, rw - 32, 18, s.receiptTitle || 'Judgment packet',
      { family: ctx.F.mono, size: 9, color: ctx.C.faint, line: 110 });
    ctx.fill(ctx.shape('RECTANGLE', slide, rx + 16, ry + 34, rw - 32, 0.75), ctx.C.line);
    fields.forEach((f, i) => {
      const fy = ry + 44 + i * 36;
      ctx.box(slide, rx + 16, fy, 90, 18, f.k || '',
        { family: ctx.F.mono, size: 9, color: ctx.C.faint, line: 110 });
      ctx.box(slide, rx + 108, fy, rw - 124, 32, f.v || '',
        { family: ctx.F.body, size: 10.5, color: ctx.C.ink, line: 116 });
    });
    if (s.stamp) {
      const sy = ry + rh - 36;
      ctx.fill(ctx.shape('ROUND_RECTANGLE', slide, rx + 16, sy, rw - 32, 24), ctx.C.panelAlt, ctx.C.accent, 1);
      ctx.box(slide, rx + 16, sy, rw - 32, 24, s.stamp,
        { family: ctx.F.mono, size: 10, color: ctx.C.accent2, align: 'CENTER', vmid: true });
    }
  },
  stack(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    if (s.heading) {
      ctx.box(slide, M, 88, 580, 32, s.heading,
        { family: ctx.F.display, size: 24, color: ctx.C.ink });
    }
    const layers = (s.layers || []).slice(0, 4);
    const cardW = 460;
    const cardH = 56;
    const gap = 10;
    const baseX = (W - cardW) / 2;
    const baseY = s.heading ? 128 : 108;
    layers.forEach((layer, i) => {
      const x = baseX;
      const y = baseY + i * (cardH + gap);
      ctx.fill(ctx.shape('ROUND_RECTANGLE', slide, x, y, cardW, cardH),
        ctx.C.panel, ctx.C.line, 1);
      ctx.box(slide, x + 18, y + 12, cardW - 36, 22, layer.title || '',
        { family: ctx.F.display, size: 15, color: ctx.C.ink, line: 110 });
      if (layer.sub) {
        ctx.box(slide, x + 18, y + 34, cardW - 36, 20, layer.sub,
          { family: ctx.F.body, size: 10, color: ctx.C.soft, line: 116 });
      }
    });
    const totalH = layers.length * cardH + (layers.length - 1) * gap;
    if (s.sub) {
      ctx.box(slide, M, baseY + totalH + 18, W - M * 2, 40, s.sub,
        { family: ctx.F.body, size: 11.5, color: ctx.C.soft, align: 'CENTER', line: 122 });
    }
  },
  quote(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    ctx.rule(slide, W / 2 - 24, 118, 48);
    ctx.box(slide, 64, 138, W - 128, 120, s.text || '',
      { family: ctx.F.display, size: 28, color: ctx.C.ink, align: 'CENTER', line: 118 });
    const author = [s.author, s.role].filter(Boolean).join(' · ');
    if (author) {
      ctx.box(slide, 64, 278, W - 128, 28, author,
        { family: ctx.F.body, size: 11.5, color: ctx.C.faint, align: 'CENTER', line: 118 });
    }
  },
  hero(ctx, slide, s, spec) {
    ctx.rule(slide, (W - 56) / 2, 108, 56);
    ctx.box(slide, 48, 124, W - 96, 88, s.headline || s.text || '',
      { family: ctx.F.display, size: 36, color: ctx.C.ink, align: 'CENTER', line: 104 });
    if (s.sub) {
      ctx.box(slide, 72, 220, W - 144, 56, s.sub,
        { family: ctx.F.body, size: 13, color: ctx.C.soft, align: 'CENTER', line: 122 });
    }
    if (s.mono) {
      const monoSize = s.mono.length > 52 ? 8.5 : 10.5;
      const monoH = s.mono.length > 52 ? 44 : 28;
      ctx.box(slide, 36, 292, W - 72, monoH, s.mono,
        { family: ctx.F.mono, size: monoSize, color: ctx.C.accent2, align: 'CENTER', line: 118 });
    }
    if (s.footer) {
      ctx.box(slide, 0, 352, W, 20, s.footer,
        { family: ctx.F.body, size: 10, color: ctx.C.faint, align: 'CENTER' });
    }
  },
  // --- narrative archetypes (typography-first, no widget boxes) ---
  interstitial(ctx, slide, s) {
    const align = s.align === 'CENTER' ? 'CENTER' : 'START';
    const x = align === 'CENTER' ? M : M;
    const w = W - M * 2;
    if (s.kicker) {
      ctx.box(slide, x, 118, w, 22, s.kicker,
        { family: ctx.F.mono, size: 10, color: ctx.C.faint, align, line: 110 });
    }
    const size = s.size || (s.text && s.text.length > 28 ? 44 : 56);
    const textY = s.kicker ? 152 : 128;
    ctx.box(slide, x, textY, w, 150, s.text || s.headline || '',
      { family: ctx.F.display, size, color: ctx.C.ink, align, line: 96 });
    if (s.sub) {
      ctx.box(slide, x, textY + 158, Math.min(520, w), 56, s.sub,
        { family: ctx.F.body, size: 13, color: ctx.C.soft, align, line: 124 });
    }
  },
  lede(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 14, spec.brand);
    ctx.box(slide, M, 92, 640, 128, s.headline || s.title || '',
      { family: ctx.F.display, size: 40, color: ctx.C.ink, line: 100 });
    if (s.dek) {
      ctx.box(slide, M, 232, 580, 72, s.dek,
        { family: ctx.F.body, size: 14, color: ctx.C.soft, line: 128 });
    }
    if (s.byline) {
      ctx.box(slide, M, 318, 580, 24, s.byline,
        { family: ctx.F.mono, size: 10, color: ctx.C.faint, line: 118 });
    }
  },
  prose(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    let y = 86;
    if (s.heading) {
      const headSize = s.heading.length > 52 ? 22 : 26;
      const headH = s.heading.length > 52 ? 72 : 52;
      ctx.box(slide, M, y, 580, headH, s.heading,
        { family: ctx.F.display, size: headSize, color: ctx.C.ink, line: 108 });
      y += headH + 12;
    }
    const paras = (s.paragraphs || (s.body ? [s.body] : [])).slice(0, 3);
    const np = paras.length || 1;
    // Distribute paragraphs across the space left to the slide floor, then pick
    // one font size that fits all of them in their slots (3 long paras shrink).
    const slotH = Math.floor((388 - y) / np);
    const size = fitSizeAll(paras, 580, slotH - 10, 14, 10.5, 132);
    paras.forEach((p, i) => {
      ctx.box(slide, M, y + i * slotH, 580, slotH, p,
        { family: ctx.F.body, size, color: ctx.C.soft, line: 132 });
    });
  },
  bullets(ctx, slide, s, spec) {
    // A real bullet list: accent dot + text, typography only, no card boxes.
    // Font and row height shrink as the list grows so it never runs off-slide.
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    let y = 96;
    if (s.heading) {
      ctx.box(slide, M, y, W - M * 2, 40, s.heading,
        { family: ctx.F.display, size: 26, color: ctx.C.ink, line: 110 });
      y += 54;
    }
    const items = (s.items || []).slice(0, 7);
    const n = items.length || 1;
    const hasSub = items.some((it) => it && typeof it === 'object' && (it.sub || it.b));
    const bottom = s.sub ? H - 76 : H - 36;
    const rowH = Math.max(hasSub ? 44 : 30, Math.min(hasSub ? 70 : 54, Math.floor((bottom - y) / n)));
    const size = hasSub ? (n > 4 ? 13 : 15) : (n > 5 ? 13.5 : n > 3 ? 15.5 : 18);
    items.forEach((item, i) => {
      const iy = y + i * rowH;
      const isObj = item && typeof item === 'object';
      const txt = isObj ? (item.text || item.h || item.title || '') : item;
      const sub = isObj ? (item.sub || item.b || '') : '';
      ctx.fill(ctx.shape('ELLIPSE', slide, M + 1, iy + size * 0.42, 6, 6), ctx.C.accent);
      ctx.box(slide, M + 22, iy, W - M * 2 - 22, sub ? 24 : rowH, txt,
        { family: ctx.F.body, size, color: ctx.C.ink, line: 116 });
      if (sub) {
        ctx.box(slide, M + 22, iy + size + 9, W - M * 2 - 22, 24, sub,
          { family: ctx.F.body, size: size - 3, color: ctx.C.faint, line: 116 });
      }
    });
    if (s.sub) {
      ctx.box(slide, M, bottom + 6, W - M * 2, 32, s.sub,
        { family: ctx.F.body, size: 11.5, color: ctx.C.soft, line: 122 });
    }
  },
  split(ctx, slide, s, spec) {
    ctx.wordmark(slide, M, 28, 13, spec.brand);
    const leftW = 372;
    const topY = 88;
    if (s.heading) {
      ctx.box(slide, M, topY, leftW, 44, s.heading,
        { family: ctx.F.display, size: 24, color: ctx.C.ink, line: 108 });
    }
    const bodyY = s.heading ? topY + 52 : topY;
    ctx.box(slide, M, bodyY, leftW, 200, s.body || s.text || '',
      { family: ctx.F.body, size: 13, color: ctx.C.soft, line: 132 });
    const rx = 448;
    if (s.accent) {
      ctx.box(slide, rx, 108, 224, 80, s.accent,
        { family: ctx.F.display, size: 38, color: ctx.C.accent2, line: 96 });
    }
    if (s.accentSub) {
      ctx.box(slide, rx, 196, 224, 96, s.accentSub,
        { family: ctx.F.body, size: 11.5, color: ctx.C.faint, line: 122 });
    }
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

module.exports = { buildDeck, THEMES, ARCHE, sanitize, parseEmph, rgb, COLOR_ROLES, fitSize, estLines };
