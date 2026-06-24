// Deck spec schema validation — catch a bad spec before it hits the Slides API.
//
// lintSpec (lib/deck-review.js) judges *taste* (clip risk, template fatigue,
// AI-tell copy). validateSpec judges *shape*: unknown slide types, missing
// required fields, bad theme, malformed arrays. It runs on `deck lint` and
// gates `deck build`, so a typo fails locally with a slide index instead of a
// cryptic batch-update error after the network round trip.
//
// Findings share lintSpec's shape: { severity, slide, rule, message } where
// slide 0 is a spec-level finding and slide N (1-based) points at a slide.

const { THEMES, ARCHE } = require('./slides-deck');

const KNOWN_THEMES = new Set(Object.keys(THEMES));

// Per-type contract.
//   need: list of alternative-groups; each group needs >=1 field with content.
//   arr:  fields that, when present, must be non-empty arrays.
// Keep this in lockstep with ARCHE in slides-deck.js (a drift test enforces it).
const SLIDE_SCHEMA = {
  title: { need: [['headline', 'title']], arr: {} },
  statement: { need: [['text', 'headline']], arr: {} },
  columns: { need: [['columns']], arr: { columns: { min: 1 } } },
  panel: { need: [['panel']], arr: {} },
  chips: { need: [['chips']], arr: { chips: { min: 1 } } },
  bignumber: { need: [['number', 'value']], arr: {} },
  close: { need: [], arr: { buttons: { min: 0 } } },
  timeline: { need: [['steps']], arr: { steps: { min: 1 } } },
  versus: { need: [['left'], ['right']], arr: {} },
  metricgrid: { need: [['metrics']], arr: { metrics: { min: 1 } } },
  receipt: { need: [['fields']], arr: { fields: { min: 1 } } },
  stack: { need: [['layers']], arr: { layers: { min: 1 } } },
  quote: { need: [['text']], arr: {} },
  hero: { need: [['headline', 'text']], arr: {} },
  interstitial: { need: [['text', 'headline']], arr: {} },
  lede: { need: [['headline', 'title']], arr: {} },
  prose: { need: [['paragraphs', 'body']], arr: { paragraphs: { min: 0 } } },
  split: { need: [['body', 'text']], arr: {} },
};

function hasContent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v) || v === 0;
}

function validateSpec(spec) {
  const findings = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    findings.push({ severity: 'error', slide: 0, rule: 'spec-shape', message: 'Spec must be a JSON object' });
    return findings;
  }
  if (spec.theme != null && !KNOWN_THEMES.has(spec.theme)) {
    findings.push({
      severity: 'error',
      slide: 0,
      rule: 'unknown-theme',
      message: `Unknown theme "${spec.theme}". Use: ${[...KNOWN_THEMES].join(', ')}`,
    });
  }
  const slides = spec.slides;
  if (!Array.isArray(slides) || slides.length === 0) {
    findings.push({ severity: 'error', slide: 0, rule: 'no-slides', message: 'Spec needs a non-empty "slides" array' });
    return findings;
  }
  slides.forEach((slide, i) => {
    const n = i + 1;
    if (!slide || typeof slide !== 'object' || Array.isArray(slide)) {
      findings.push({ severity: 'error', slide: n, rule: 'slide-shape', message: 'Slide must be an object' });
      return;
    }
    const type = slide.type;
    if (!hasContent(type)) {
      findings.push({ severity: 'error', slide: n, rule: 'missing-type', message: 'Slide is missing a "type"' });
      return;
    }
    const def = SLIDE_SCHEMA[type];
    if (!def) {
      findings.push({
        severity: 'error',
        slide: n,
        rule: 'unknown-slide-type',
        message: `Unknown slide type "${type}". Known: ${Object.keys(SLIDE_SCHEMA).join(', ')}`,
      });
      return;
    }
    (def.need || []).forEach((alts) => {
      if (!alts.some((k) => hasContent(slide[k]))) {
        const label = alts.map((a) => `"${a}"`).join(' or ');
        findings.push({ severity: 'error', slide: n, rule: 'missing-field', message: `"${type}" slide needs ${label}` });
      }
    });
    Object.entries(def.arr || {}).forEach(([field, ruleDef]) => {
      const v = slide[field];
      if (v == null) return;
      if (!Array.isArray(v)) {
        findings.push({ severity: 'error', slide: n, rule: 'bad-array', message: `Slide field "${field}" must be an array` });
      } else if (ruleDef.min && v.length < ruleDef.min) {
        findings.push({ severity: 'warn', slide: n, rule: 'empty-array', message: `Slide field "${field}" is empty` });
      }
    });
  });
  return findings;
}

// Order findings for display: spec-level first, then by slide, errors above warns.
const SEV_RANK = { error: 0, warn: 1, info: 2 };
function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    if (a.slide !== b.slide) return a.slide - b.slide;
    return (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3);
  });
}

function hasErrors(findings) {
  return findings.some((f) => f.severity === 'error');
}

// Schema validation (shape) + lint (taste), merged and ordered.
function checkSpec(spec, lintSpec) {
  const schema = validateSpec(spec);
  // Only run the taste lint when the shape is sane enough to walk slides.
  const taste = !hasErrors(schema.filter((f) => f.rule === 'spec-shape' || f.rule === 'no-slides')) && typeof lintSpec === 'function'
    ? lintSpec(spec)
    : [];
  return sortFindings([...schema, ...taste]);
}

module.exports = {
  KNOWN_THEMES,
  SLIDE_SCHEMA,
  validateSpec,
  sortFindings,
  hasErrors,
  hasContent,
  checkSpec,
  ARCHE_TYPES: Object.keys(ARCHE),
};
