const test = require('node:test');
const assert = require('node:assert/strict');
const { videoToDeck, positionals } = require('../commands/deck');

const ANALYSIS = `# How to Spot a Fake CEO

Mark Pincus on building. A Sourcery episode.

## The framework
- Proven: find the closest success and deconstruct it
- Better: one change the audience would notice
- New: the novel hook, expect it to fail

## A line
> Your number one job as a founder is to be right. - Mark Pincus

## Takeaway
Separate the instinct from the idea.`;

function makeApi(id) {
  const state = { slides: [] };
  return async (method, p, body) => {
    if (method === 'POST' && p === '/presentations') { state.slides = [{ objectId: 'p_default' }]; return { presentationId: id, slides: state.slides }; }
    if (p.endsWith('/batch-update')) {
      for (const r of body.requests) {
        if (r.createSlide) state.slides.push({ objectId: r.createSlide.objectId });
        if (r.deleteObject) state.slides = state.slides.filter((s) => s.objectId !== r.deleteObject.objectId);
      }
      return {};
    }
    throw new Error(`unexpected ${method} ${p}`);
  };
}

test('positionals skips boolean flags and value-flag values', () => {
  assert.deepEqual(positionals(['a.json', 'b.json', '--theme', 'noir', '--review']), ['a.json', 'b.json']);
  assert.deepEqual(positionals(['--theme', 'ink', 'only.json']), ['only.json']);
  assert.deepEqual(positionals(['--review', '--json']), []);
});

test('videoToDeck composes, gates on lint, and publishes in one shot', async () => {
  const api = makeApi('VID1');
  const result = await videoToDeck({ analysisText: ANALYSIS, theme: 'noir', style: 'narrative', url: 'youtube.com/watch?v=x', api, token: 'tok' });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'VID1');
  assert.equal(result.url, 'https://docs.google.com/presentation/d/VID1/edit');
  assert.ok(result.spec.slides.length >= 5);
  // narrative one-shot opens on a cover and closes on a hero
  assert.ok(['title', 'lede'].includes(result.spec.slides[0].type));
  assert.equal(result.spec.slides[result.spec.slides.length - 1].type, 'hero');
  assert.match(JSON.stringify(result.spec), /Proven/);
});

test('videoToDeck refuses to publish a spec that fails the lint gate', async () => {
  let published = false;
  const api = async (method, p) => { if (p === '/presentations') { published = true; } return { presentationId: 'X', slides: [] }; };
  // an analysis whose only content is banned contrast copy
  const dirty = '# T\n\n## Claim\n\nThis is not taste. It is proof.';
  const result = await videoToDeck({ analysisText: dirty, style: 'dense', api, token: 'tok' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.rule === 'not-x-contrast-copy'));
  assert.equal(published, false, 'must not call the API when the gate fails');
});
