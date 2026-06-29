const test = require('node:test');
const assert = require('node:assert/strict');
const { composeSpec, parseBlocks, classify, toItem, splitQuote } = require('../lib/deck-compose');
const { validateSpec, hasErrors } = require('../lib/deck-schema');
const { lintSpec } = require('../lib/deck-review');
const { buildDeck } = require('../lib/slides-deck');

// A markdown analysis shaped like what the cloud returns for a podcast episode.
const ANALYSIS = `# Own or Be Owned

Yash Patil on Applied Compute. A 68-minute episode of The Generalist.

## The core thesis

A model-less company is sitting on shifting sand. If you build only on a frontier API, the provider decides your capabilities. The fix is owning your intelligence stack.

## What Applied Compute does

- Post-train: start from open-weight models and hill-climb on customer data
- Serve: deploy in production, revenue mostly on inference
- Improve: capture usage, feed new training data, loop forever

## A memorable line

> Frontier models are a blowtorch. Most jobs need a knife. - Yash Patil

## Why it matters

Evals are the new PRD. Every company codifies what good looks like, and proprietary evals stay home. Goldman and Mercor will never ship their scorecards to a frontier API, so the company that owns the post-training loop on private evals keeps its moat while everyone renting the same API blends together.

## Takeaway

Train on your evals. Keep your moat.`;

test('parseBlocks tokenizes headings, bullets, quotes, and paragraphs', () => {
  const blocks = parseBlocks(ANALYSIS);
  assert.ok(blocks.some((b) => b.kind === 'h' && b.level === 1));
  assert.ok(blocks.some((b) => b.kind === 'ul' && b.items.length === 3));
  assert.ok(blocks.some((b) => b.kind === 'quote'));
  assert.ok(blocks.some((b) => b.kind === 'p'));
});

test('toItem splits "Term: detail" into text + sub', () => {
  assert.deepEqual(toItem('Post-train: start from open weights'), { text: 'Post-train', sub: 'start from open weights' });
  assert.equal(typeof toItem('just a plain bullet'), 'string');
});

test('splitQuote pulls an attribution off a quote line', () => {
  const q = splitQuote('Frontier models are a blowtorch. - Yash Patil');
  assert.match(q.text, /blowtorch/);
  assert.equal(q.author, 'Yash Patil');
});

test('classify maps a bullet section to points and a quote to a quote', () => {
  assert.equal(classify('X', [{ kind: 'ul', items: ['a', 'b'] }]).kind, 'points');
  assert.equal(classify(null, [{ kind: 'quote', text: 'hi - me' }]).kind, 'quote');
  assert.equal(classify('Short claim', [{ kind: 'p', text: 'a brief support line.' }]).kind, 'statement');
});

test('composeSpec produces a valid, lint-clean, narrative deck', () => {
  const spec = composeSpec(ANALYSIS, { theme: 'ink', style: 'narrative', url: 'youtube.com/watch?v=abc' });
  // shape is valid
  assert.equal(hasErrors(validateSpec(spec)), false, JSON.stringify(validateSpec(spec).filter((f) => f.severity === 'error')));
  // taste is clean
  const findings = lintSpec(spec);
  assert.ok(!findings.some((f) => f.severity === 'error'), `lint errors: ${JSON.stringify(findings.filter((f) => f.severity === 'error'))}`);
  assert.ok(!findings.some((f) => f.rule === 'template-fatigue'), 'narrative compose must not trip template fatigue');
  // narrative: at most a couple boxed slides (chips/panel/etc.)
  const boxed = new Set(['panel', 'receipt', 'versus', 'metricgrid', 'stack', 'chips']);
  const boxedCount = spec.slides.filter((s) => boxed.has(s.type)).length;
  assert.ok(boxedCount <= 2, `expected <=2 boxed slides, got ${boxedCount}`);
  // it built a real arc: cover first, close last, with content in between
  assert.ok(['title', 'lede'].includes(spec.slides[0].type), 'opens on a cover');
  assert.ok(spec.slides.length >= 6, 'has a reasonable number of slides');
  assert.equal(spec.slides[spec.slides.length - 1].type, 'hero', 'narrative close is a hero');
  // it builds without falling back
  const { slideIds } = buildDeck(spec);
  assert.equal(slideIds.length, spec.slides.length);
  // content survives
  const texts = JSON.stringify(spec);
  assert.match(texts, /blowtorch/);
  assert.match(texts, /Post-train/);
});

test('composeSpec preserves content when the doc opens with a bullet list (no cover overwrite)', () => {
  const md = '- first key point that must survive\n- second key point\n- third point\n\n## Next\n\nSome prose body content here.';
  const spec = composeSpec(md, { style: 'narrative', title: 'My Talk' });
  assert.equal(hasErrors(validateSpec(spec)), false);
  const json = JSON.stringify(spec);
  assert.match(json, /first key point that must survive/, 'opening bullets must not be destroyed by the cover');
  assert.ok(spec.slides.some((s) => s.type === 'bullets'), 'the opening list survives as a bullets slide');
});

test('composeSpec handles headingless prose without crashing', () => {
  const spec = composeSpec('Just one paragraph of analysis with no structure at all here.', { style: 'narrative' });
  assert.equal(hasErrors(validateSpec(spec)), false);
  assert.ok(spec.slides.length >= 2);
});
