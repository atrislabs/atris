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
