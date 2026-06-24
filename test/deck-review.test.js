const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractPresentationId,
  lintSpec,
  confirmReview,
  reviewDeck,
  SCHEMA,
  CLIP_LIMITS,
} = require('../lib/deck-review');

test('extractPresentationId accepts raw id or edit URL', () => {
  assert.equal(extractPresentationId('abc123'), 'abc123');
  assert.equal(
    extractPresentationId('https://docs.google.com/presentation/d/abc123/edit'),
    'abc123',
  );
});

test('lintSpec flags not-x contrast copy', () => {
  const findings = lintSpec({
    slides: [{ type: 'quote', text: 'Antislop is not taste. It is **proof.**' }],
  });
  assert.ok(findings.some((f) => f.rule === 'not-x-contrast-copy' && f.severity === 'error'));
});

test('lintSpec flags template fatigue when too many boxed slides', () => {
  const findings = lintSpec({
    slides: [
      { type: 'panel', heading: 'a' },
      { type: 'receipt', fields: [] },
      { type: 'versus', left: { items: [] }, right: { items: [] } },
      { type: 'metricgrid', metrics: [] },
    ],
  });
  assert.ok(findings.some((f) => f.rule === 'template-fatigue'));
});

test('lintSpec flags panel slides that need visual review', () => {
  const spec = {
    slides: [{
      type: 'panel',
      heading: 'The market proved the gap.',
      sub: 'Agents act everywhere.',
      panel: { rows: [{}, {}, {}, {}], footer: { right: 'then company now' } },
    }],
  };
  const findings = lintSpec(spec);
  assert.ok(findings.some((f) => f.rule === 'panel-visual-review'));
  assert.ok(findings.some((f) => f.rule === 'panel-many-rows'));
  assert.ok(findings.some((f) => f.rule === 'panel-footer-long'));
});

test('lintSpec errors when array content exceeds what the engine renders', () => {
  // engine slices columns to 4; a 5th is silently dropped -> data loss -> error
  const findings = lintSpec({ slides: [{
    type: 'columns',
    columns: [{ h: 'a', b: '1' }, { h: 'b', b: '2' }, { h: 'c', b: '3' }, { h: 'd', b: '4' }, { h: 'e', b: '5' }],
  }] });
  const f = findings.find((x) => x.rule === 'content-truncated');
  assert.ok(f && f.severity === 'error', 'expected a content-truncated error');
  assert.equal(f.slide, 1);
});

test('lintSpec errors on a too-long statement sub but only warns on a borderline one', () => {
  const long = lintSpec({ slides: [{ type: 'statement', text: 'x', sub: 'y'.repeat(CLIP_LIMITS.statementSubError + 1) }] });
  assert.ok(long.some((f) => f.rule === 'statement-sub-long' && f.severity === 'error'));
  const borderline = lintSpec({ slides: [{ type: 'statement', text: 'x', sub: 'y'.repeat(CLIP_LIMITS.statementSubWarn + 5) }] });
  const f = borderline.find((x) => x.rule === 'statement-sub-long');
  assert.ok(f && f.severity === 'warn');
});

test('lintSpec warns when a 4-layer stack also carries a sub (sub clips off-slide)', () => {
  const findings = lintSpec({ slides: [{
    type: 'stack',
    heading: 'h',
    layers: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }],
    sub: 'this sub renders below the fourth card and falls off the slide',
  }] });
  assert.ok(findings.some((f) => f.rule === 'stack-sub-clip' && f.severity === 'warn'));
});

test('clip-error thresholds are overridable via opts.limits', () => {
  const spec = { slides: [{ type: 'statement', text: 'x', sub: 'y'.repeat(50) }] };
  assert.equal(lintSpec(spec).filter((f) => f.severity === 'error').length, 0);
  const strict = lintSpec(spec, { limits: { statementSubError: 40 } });
  assert.ok(strict.some((f) => f.rule === 'statement-sub-long' && f.severity === 'error'));
});

test('every shipped deck spec lints without errors', () => {
  const dir = path.join(__dirname, '..', 'decks');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const errs = lintSpec(spec).filter((f) => f.severity === 'error');
    assert.equal(errs.length, 0, `${file} has lint errors: ${JSON.stringify(errs)}`);
  }
});

test('reviewDeck downloads thumbnails and writes manifest', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-review-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  let thumbCalls = 0;
  const api = async (method, p) => {
    if (method === 'GET' && p === '/presentations/deck123') {
      return { slides: [{ objectId: 'deck_slide_1' }, { objectId: 'deck_slide_2' }] };
    }
    if (method === 'GET' && p.includes('/thumbnail')) {
      thumbCalls += 1;
      return { contentUrl: `https://example.com/thumb-${thumbCalls}.png` };
    }
    throw new Error(`unexpected api call: ${method} ${p}`);
  };
  const originalGet = require('https').get;
  require('https').get = (url, cb) => {
    cb({ statusCode: 200, headers: {}, pipe: (dest) => { dest.write(png); dest.end(); return dest; } });
    return { on: () => {} };
  };
  try {
    const { packet, manifestPath } = await reviewDeck({
      presentationId: 'deck123',
      spec: { slides: [{ type: 'title' }, { type: 'close' }] },
      specPath: 'deck.json',
      outRoot: tmp,
      api,
      token: 'tok',
    });
    assert.equal(packet.schema, SCHEMA);
    assert.equal(packet.slides.length, 2);
    assert.equal(packet.status, 'pending_visual_review');
    assert.equal(fs.existsSync(manifestPath), true);
    assert.equal(fs.existsSync(packet.slides[0].thumbnail), true);
  } finally {
    require('https').get = originalGet;
  }
});

test('confirmReview marks manifest ready', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-review-'));
  const dir = path.join(tmp, 'deck999');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.json'), `${JSON.stringify({
    schema: SCHEMA,
    presentationId: 'deck999',
    status: 'pending_visual_review',
    ready: false,
    slides: [],
    specLint: [],
  }, null, 2)}\n`);
  const { packet } = confirmReview('deck999', 'looks clean', tmp);
  assert.equal(packet.status, 'confirmed_visual_review');
  assert.equal(packet.ready, true);
});
