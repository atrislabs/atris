const test = require('node:test');
const assert = require('node:assert/strict');
const { preferredType, planLayout } = require('../lib/deck-layout');
const { validateSpec, hasErrors } = require('../lib/deck-schema');
const { lintSpec } = require('../lib/deck-review');
const { buildDeck } = require('../lib/slides-deck');

test('preferredType picks the obvious archetype per content kind', () => {
  assert.equal(preferredType('quote'), 'quote');
  assert.equal(preferredType('compare'), 'versus');
  assert.equal(preferredType('proof'), 'receipt');
  assert.equal(preferredType('process', { steps: [{}, {}] }), 'timeline');
  assert.equal(preferredType('process', { steps: new Array(7).fill({}) }), 'stack');
  assert.equal(preferredType('metrics', { metrics: [{}, {}] }), 'metricgrid');
  assert.equal(preferredType('metrics', { metrics: [{}] }), 'bignumber');
  assert.equal(preferredType('cover', {}, 'narrative'), 'lede');
  assert.equal(preferredType('cover', {}, 'pitch'), 'title');
});

test('narrative style downgrades boxed widgets to typography', () => {
  const slides = planLayout([
    { kind: 'compare', heading: 'A vs B', left: { label: 'Old', items: ['x'] }, right: { label: 'New', items: ['y'] } },
    { kind: 'process', heading: 'Stack', layers: [{ title: 'a', sub: 'one' }, { title: 'b' }] },
    { kind: 'proof', heading: 'Receipt', fields: [{ k: 'a', v: '1' }] },
  ], { style: 'narrative' });
  const types = slides.map((s) => s.type);
  assert.ok(!types.includes('versus'), 'versus downgraded');
  assert.ok(!types.includes('stack'), 'stack downgraded');
  assert.ok(!types.includes('receipt'), 'receipt downgraded');
  // downgrades still carry the content
  const cols = slides.find((s) => s.type === 'columns');
  assert.ok(cols && cols.columns.length === 2);
});

test('versus is used at most once per deck; later comparisons become columns', () => {
  const slides = planLayout([
    { kind: 'compare', left: { label: 'L1', items: ['a'] }, right: { label: 'R1', items: ['b'] } },
    { kind: 'compare', left: { label: 'L2', items: ['c'] }, right: { label: 'R2', items: ['d'] } },
  ], { style: 'dense' });
  assert.equal(slides.filter((s) => s.type === 'versus').length, 1);
  assert.equal(slides.filter((s) => s.type === 'columns').length, 1);
});

test('planned deck stays under template-fatigue and validates + builds', () => {
  const sections = [
    { kind: 'cover', headline: 'Big idea.', sub: 'a subtitle' },
    { kind: 'metrics', heading: 'Numbers', metrics: [{ value: '1', label: 'a' }, { value: '2', label: 'b' }] },
    { kind: 'proof', heading: 'Proof', fields: [{ k: 'a', v: '1' }] },
    { kind: 'compare', heading: 'Vs', left: { label: 'L', items: ['x'] }, right: { label: 'R', items: ['y'] } },
    { kind: 'process', heading: 'Flow', steps: [{ label: 's1' }, { label: 's2' }] },
    { kind: 'chips', heading: 'Tags', chips: ['a', 'b', 'c'] },
    { kind: 'metrics', heading: 'More', metrics: [{ value: '3', label: 'c' }, { value: '4', label: 'd' }] },
    { kind: 'close', text: 'The end.' },
  ];
  const spec = { theme: 'paper', brand: { name: 'X' }, slides: planLayout(sections, { style: 'dense' }) };
  assert.equal(hasErrors(validateSpec(spec)), false, 'planned spec validates');
  const findings = lintSpec(spec);
  assert.ok(!findings.some((f) => f.rule === 'template-fatigue'), 'planner keeps boxed count under the fatigue threshold');
  assert.ok(!findings.some((f) => f.severity === 'error'), 'planned spec lints without errors');
  const { slideIds } = buildDeck(spec);
  assert.equal(slideIds.length, sections.length);
});

test('planned bullets are capped to the engine limit so output stays lint-clean', () => {
  const items = Array.from({ length: 12 }, (_, i) => `point ${i}`);
  const [slide] = planLayout([{ kind: 'points', heading: 'Many', items }], { style: 'narrative' });
  assert.equal(slide.type, 'bullets');
  assert.ok(slide.items.length <= 7, 'bullets capped to 7');
  const findings = lintSpec({ slides: [slide] });
  assert.ok(!findings.some((f) => f.rule === 'content-truncated'), 'capped bullets do not trip content-truncated');
});

test('a section with no convertible content degrades to a statement, not an empty bullets', () => {
  const [slide] = planLayout([{ kind: 'points', heading: 'Empty section' }], { style: 'narrative' });
  assert.equal(slide.type, 'statement');
});
