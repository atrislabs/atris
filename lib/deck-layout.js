// Layout planner — map content shapes to slide archetypes deterministically.
//
// Agents (and `atris deck compose`) describe a deck as an ordered list of
// SECTIONS, each tagged with a `kind` (cover, quote, points, compare, metrics,
// process, proof, story, stat, close, ...). planLayout() turns those into a
// valid spec.slides, choosing the archetype by kind and style, while enforcing
// the taste rules the lint only warns about:
//   - narrative style avoids boxed widgets entirely (downgrades to typography)
//   - versus/receipt appear at most once per deck
//   - total boxed slides stay under the template-fatigue threshold
// So compose output passes lint without manual editing.

const BOXED = new Set(['panel', 'receipt', 'versus', 'metricgrid', 'stack', 'chips']);
const ONCE = new Set(['versus', 'receipt']); // at most one of each per deck
const BOXED_BUDGET = 3; // stay under the lint's template-fatigue threshold (4)

// When a boxed type is not allowed (narrative style, budget hit, already used),
// fall back to a typography-first archetype that carries the same content.
const DOWNGRADE = {
  versus: 'columns',
  metricgrid: 'bignumber',
  stack: 'bullets',
  receipt: 'bullets',
  chips: 'bullets',
  panel: 'bullets',
};

function preferredType(kind, section = {}, style = 'dense') {
  switch (kind) {
    case 'cover': return style === 'narrative' ? 'lede' : 'title';
    case 'chapter':
    case 'interstitial': return 'interstitial';
    case 'quote': return 'quote';
    case 'claim':
    case 'statement': return 'statement';
    case 'story':
    case 'prose': return 'prose';
    case 'split': return 'split';
    case 'points':
    case 'list':
    case 'bullets': return 'bullets';
    case 'columns': return 'columns';
    case 'compare':
    case 'versus': return 'versus';
    case 'metrics': return (section.metrics && section.metrics.length >= 2) ? 'metricgrid' : 'bignumber';
    case 'stat':
    case 'number':
    case 'bignumber': return 'bignumber';
    case 'process':
    case 'steps':
    case 'timeline': return (section.steps && section.steps.length > 5) ? 'stack' : 'timeline';
    case 'stack': return 'stack';
    case 'proof':
    case 'receipt': return 'receipt';
    case 'chips': return 'chips';
    case 'close':
    case 'cta': return style === 'narrative' ? 'hero' : 'close';
    case 'hero': return 'hero';
    default: return 'statement';
  }
}

// Best-effort conversion of whatever content a section carries into a flat
// item list, for downgrades into the box-free `bullets` archetype.
function asItems(section) {
  if (Array.isArray(section.items)) return section.items;
  if (Array.isArray(section.layers)) return section.layers.map((l) => (l.sub ? { text: l.title || l.h, sub: l.sub } : (l.title || l.h)));
  if (Array.isArray(section.fields)) return section.fields.map((f) => ({ text: f.k, sub: f.v }));
  if (Array.isArray(section.steps)) return section.steps.map((s) => (s.sub ? { text: s.label, sub: s.sub } : s.label));
  if (Array.isArray(section.columns)) return section.columns.map((c) => (c.b || c.body ? { text: c.h || c.title, sub: c.b || c.body } : (c.h || c.title)));
  if (Array.isArray(section.chips)) return section.chips;
  if (Array.isArray(section.metrics)) return section.metrics.map((m) => ({ text: m.value, sub: m.label }));
  if (section.left && section.right) {
    return [
      { text: section.left.label, sub: (section.left.items || []).join('. ') },
      { text: section.right.label, sub: (section.right.items || []).join('. ') },
    ];
  }
  return [];
}

function asColumns(section) {
  if (Array.isArray(section.columns)) return section.columns;
  if (section.left && section.right) {
    return [
      { h: section.left.label || 'Then', b: (section.left.items || []).join('. ') },
      { h: section.right.label || 'Now', b: (section.right.items || []).join('. ') },
    ];
  }
  if (Array.isArray(section.items)) {
    return section.items.slice(0, 4).map((it) => (typeof it === 'string' ? { h: it, b: '' } : { h: it.text || it.h, b: it.sub || it.b || '' }));
  }
  return [];
}

function firstText(section, ...keys) {
  for (const k of keys) {
    if (section[k] != null && String(section[k]).length) return section[k];
  }
  return '';
}

function mapToSlide(type, section) {
  const heading = firstText(section, 'heading', 'title');
  switch (type) {
    case 'title': return { type, headline: firstText(section, 'headline', 'text', 'heading'), ...(section.sub ? { sub: section.sub } : {}), ...(section.panel ? { panel: section.panel } : {}) };
    case 'lede': return { type, headline: firstText(section, 'headline', 'text', 'heading'), ...(section.dek || section.sub ? { dek: section.dek || section.sub } : {}), ...(section.byline ? { byline: section.byline } : {}) };
    case 'interstitial': return { type, ...(section.kicker ? { kicker: section.kicker } : {}), text: firstText(section, 'text', 'heading', 'headline'), ...(section.sub ? { sub: section.sub } : {}), ...(section.align ? { align: section.align } : {}) };
    case 'statement': return { type, text: firstText(section, 'text', 'heading', 'headline'), ...(section.sub ? { sub: section.sub } : {}) };
    case 'quote': return { type, text: (section.quote && section.quote.text) || firstText(section, 'text'), ...((section.quote && section.quote.author) || section.author ? { author: (section.quote && section.quote.author) || section.author } : {}), ...((section.quote && section.quote.role) || section.role ? { role: (section.quote && section.quote.role) || section.role } : {}) };
    case 'prose': return { type, ...(heading ? { heading } : {}), paragraphs: Array.isArray(section.paragraphs) ? section.paragraphs.slice(0, 3) : (section.text ? [section.text] : []) };
    case 'split': return { type, ...(heading ? { heading } : {}), body: firstText(section, 'body', 'text'), ...(section.accent ? { accent: section.accent } : {}), ...(section.accentSub ? { accentSub: section.accentSub } : {}) };
    case 'bullets': {
      const items = asItems(section).slice(0, 7); // cap to the engine's bullet limit so planned output stays lint-clean
      if (!items.length) return { type: 'statement', text: firstText(section, 'text', 'heading', 'headline') || 'Untitled' };
      return { type, ...(heading ? { heading } : {}), items, ...(section.sub ? { sub: section.sub } : {}) };
    }
    case 'columns': return { type, ...(heading ? { heading } : {}), columns: asColumns(section).slice(0, 4) };
    case 'versus': return { type, ...(heading ? { heading } : {}), left: section.left || { label: '', items: [] }, right: section.right || { label: '', items: [] } };
    case 'metricgrid': return { type, ...(heading ? { heading } : {}), metrics: (section.metrics || []).slice(0, 4) };
    case 'bignumber': {
      const m = (section.metrics || [])[0] || {};
      return { type, number: firstText(section, 'number', 'value') || m.value || '', ...(section.label || m.label ? { label: section.label || m.label } : {}), ...(section.sub ? { sub: section.sub } : {}) };
    }
    case 'timeline': return { type, ...(heading ? { heading } : {}), steps: (section.steps || []).slice(0, 5), ...(section.sub ? { sub: section.sub } : {}) };
    case 'stack': {
      const layers = Array.isArray(section.layers) ? section.layers : asItems(section).map((it) => (typeof it === 'string' ? { title: it } : { title: it.text, sub: it.sub }));
      return { type, ...(heading ? { heading } : {}), layers: layers.slice(0, 4), ...(section.sub ? { sub: section.sub } : {}) };
    }
    case 'receipt': return { type, ...(heading ? { heading } : {}), ...(section.sub ? { sub: section.sub } : {}), ...(section.receiptTitle ? { receiptTitle: section.receiptTitle } : {}), fields: (section.fields || []).slice(0, 6), ...(section.stamp ? { stamp: section.stamp } : {}) };
    case 'chips': return { type, ...(heading ? { heading } : {}), chips: section.chips || [], ...(section.mono ? { mono: section.mono } : {}) };
    case 'hero': return { type, headline: firstText(section, 'headline', 'text', 'tagline'), ...(section.sub ? { sub: section.sub } : {}), ...(section.mono ? { mono: section.mono } : {}), ...(section.footer ? { footer: section.footer } : {}) };
    case 'close': return { type, tagline: firstText(section, 'tagline', 'text'), ...(section.footer ? { footer: section.footer } : {}), ...(section.buttons ? { buttons: section.buttons } : {}) };
    default: return { type: 'statement', text: firstText(section, 'text', 'heading', 'headline') || 'Untitled' };
  }
}

// Decide the final type for one section given style + running budget state.
function chooseType(section, style, state) {
  let type = section.type || preferredType(section.kind, section, style);
  if (style === 'narrative' && BOXED.has(type) && DOWNGRADE[type]) type = DOWNGRADE[type];
  if (ONCE.has(type) && state.usedOnce.has(type) && DOWNGRADE[type]) type = DOWNGRADE[type];
  if (BOXED.has(type) && state.boxed >= state.boxedBudget && DOWNGRADE[type]) type = DOWNGRADE[type];
  if (ONCE.has(type)) state.usedOnce.add(type);
  // a title with a data panel counts as boxed for fatigue, matching lintSpec
  if (BOXED.has(type) || (type === 'title' && section.panel)) state.boxed += 1;
  return type;
}

function planLayout(sections, opts = {}) {
  const style = opts.style || 'dense';
  const state = {
    style,
    boxedBudget: opts.boxedBudget != null ? opts.boxedBudget : BOXED_BUDGET,
    usedOnce: new Set(),
    boxed: 0,
  };
  return (sections || []).map((section) => mapToSlide(chooseType(section, style, state), section));
}

module.exports = {
  BOXED,
  ONCE,
  BOXED_BUDGET,
  DOWNGRADE,
  preferredType,
  mapToSlide,
  planLayout,
};
