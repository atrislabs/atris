// Golden path, end to end, against one stateful mock Slides API:
//   lint (checkSpec) -> build (publishDeck) -> review (reviewDeck) -> confirm.
// Proves the pieces compose: the slides the build creates are exactly the ones
// the review fetches thumbnails for, and confirm emits a receipt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkSpec, hasErrors } = require('../lib/deck-schema');
const { publishDeck } = require('../commands/deck');
const { lintSpec, reviewDeck, confirmReview } = require('../lib/deck-review');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SPEC = {
  theme: 'paper',
  brand: { name: 'Acme', accent: '.' },
  slides: [
    { type: 'title', headline: 'Build decks **from a spec.**', sub: 'Premium slides, no slop.' },
    { type: 'statement', text: 'Describe it. **Get the design system for free.**' },
    { type: 'bullets', heading: 'Why', items: ['Anti-slop by construction', { text: 'Review loop', sub: 'thumbnails gate confirm' }] },
    { type: 'close', tagline: 'Ship it.', footer: 'acme.dev' },
  ],
};

// One stateful mock of the Atris Slides API used across the whole pipeline.
function makeApi(id) {
  const state = { slides: [] };
  return async (method, p, body) => {
    if (method === 'POST' && p === '/presentations') {
      state.slides = [{ objectId: 'p_default' }]; // a fresh deck ships one blank slide
      return { presentationId: id, slides: state.slides };
    }
    if (method === 'POST' && p === `/presentations/${id}/batch-update`) {
      for (const r of body.requests) {
        if (r.createSlide) state.slides.push({ objectId: r.createSlide.objectId });
        if (r.deleteObject) state.slides = state.slides.filter((s) => s.objectId !== r.deleteObject.objectId);
      }
      return {};
    }
    if (method === 'GET' && p === `/presentations/${id}`) return { slides: state.slides };
    if (method === 'GET' && p.includes('/thumbnail')) return { contentUrl: 'https://example.com/thumb.png' };
    throw new Error(`unexpected api call: ${method} ${p}`);
  };
}

test('lint -> build -> review -> confirm runs the whole pipeline', async () => {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-int-'));
  const ledger = path.join(outRoot, 'deck-receipts.jsonl');
  const api = makeApi('GP1');

  // 1. lint gate
  assert.equal(hasErrors(checkSpec(SPEC, lintSpec)), false, 'golden spec lints clean');

  // 2. build
  const { id, url, ops } = await publishDeck({ spec: SPEC, title: 'Acme', updateId: null, api, token: 'tok' });
  assert.equal(id, 'GP1');
  assert.equal(url, 'https://docs.google.com/presentation/d/GP1/edit');
  assert.ok(ops > SPEC.slides.length, 'batch carries create + style ops');

  // 3. review — patch https.get to serve the PNG
  const originalGet = require('https').get;
  require('https').get = (u, cb) => {
    cb({ statusCode: 200, headers: {}, pipe: (dest) => { dest.write(PNG); dest.end(); return dest; } });
    return { on: () => {} };
  };
  let packet;
  let manifestPath;
  try {
    ({ packet, manifestPath } = await reviewDeck({ presentationId: id, spec: SPEC, specPath: 'decks/acme.json', outRoot, api, token: 'tok' }));
  } finally {
    require('https').get = originalGet;
  }
  // the build created exactly the spec's slides (default trimmed), and review saw all of them
  assert.equal(packet.slides.length, SPEC.slides.length, 'review fetches one thumbnail per built slide');
  assert.equal(packet.status, 'pending_visual_review');
  assert.equal(packet.specLint.length, 0, 'no lint findings carried into the manifest');
  assert.ok(fs.existsSync(packet.slides[0].thumbnail), 'thumbnail written to disk');
  assert.equal(packet.slides[2].type, 'bullets', 'manifest tags slides with their archetype');

  // 4. confirm — marks ready and drops a receipt
  const { packet: confirmed, receiptPath } = confirmReview(id, 'thumbnails look good', outRoot, ledger);
  assert.equal(confirmed.status, 'confirmed_visual_review');
  assert.equal(confirmed.ready, true);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.presentationId, 'GP1');
  assert.equal(receipt.slideCount, SPEC.slides.length);
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).presentationId, 'GP1');

  void manifestPath;
});

test('a lint-dirty spec is caught before any build call is made', () => {
  const dirty = { theme: 'paper', slides: [{ type: 'quote', text: 'It is not taste. It is proof.' }] };
  assert.equal(hasErrors(checkSpec(dirty, lintSpec)), true, 'not-x copy blocks the gate');
});
