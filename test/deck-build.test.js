const test = require('node:test');
const assert = require('node:assert/strict');
const { planBatch, publishDeck } = require('../commands/deck');

const SPEC = { theme: 'paper', brand: { name: 'X' }, slides: [
  { type: 'statement', text: 'One.' },
  { type: 'statement', text: 'Two.' },
] };

test('planBatch on create appends a delete of the blank default slide', () => {
  const requests = [{ createSlide: { objectId: 'deck_slide_1' } }];
  const batch = planBatch({ requests, newFirstSlideId: 'p_default' });
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[batch.length - 1], { deleteObject: { objectId: 'p_default' } });
});

test('planBatch on update deletes every existing slide BEFORE the new creates', () => {
  const requests = [
    { createSlide: { objectId: 'deck_slide_1' } },
    { createSlide: { objectId: 'deck_slide_2' } },
  ];
  const existingSlides = [{ objectId: 'deck_slide_1' }, { objectId: 'deck_slide_2' }, { objectId: 'deck_slide_3' }];
  const batch = planBatch({ requests, updateId: 'pres123', existingSlides });
  const deletes = batch.filter((r) => r.deleteObject).map((r) => r.deleteObject.objectId);
  // all three prior slides are removed so the reused deck_slide_N ids are free
  assert.deepEqual(deletes, ['deck_slide_1', 'deck_slide_2', 'deck_slide_3']);
  // and every delete precedes every create (no duplicate-id collision)
  const lastDelete = batch.findIndex((r, i) => r.deleteObject && !batch.slice(i + 1).some((x) => x.deleteObject));
  const firstCreate = batch.findIndex((r) => r.createSlide);
  assert.ok(lastDelete < firstCreate, 'deletes must come before creates on update');
});

test('publishDeck creates a new presentation and batch-updates it', async () => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/presentations') {
      return { presentationId: 'NEWID', slides: [{ objectId: 'p_default' }] };
    }
    if (path.endsWith('/batch-update')) return {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  const { id, url, ops } = await publishDeck({ spec: SPEC, title: 'T', updateId: null, api, token: 'tok' });
  assert.equal(id, 'NEWID');
  assert.equal(url, 'https://docs.google.com/presentation/d/NEWID/edit');
  const batchCall = calls.find((c) => c.path.endsWith('/batch-update'));
  assert.ok(batchCall, 'sent a batch-update');
  assert.equal(batchCall.body.requests.length, ops);
  // the trailing op deletes the default slide
  assert.deepEqual(batchCall.body.requests[ops - 1], { deleteObject: { objectId: 'p_default' } });
});

test('publishDeck --update reuses the id and replaces all existing slides', async () => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/presentations/OLDID') {
      // a prior build left two deck slides with the engine's fixed ids
      return { slides: [{ objectId: 'deck_slide_1' }, { objectId: 'deck_slide_2' }] };
    }
    if (path.endsWith('/batch-update')) return {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  const { id, url } = await publishDeck({ spec: SPEC, title: 'T', updateId: 'OLDID', api, token: 'tok' });
  assert.equal(id, 'OLDID');
  assert.equal(url, 'https://docs.google.com/presentation/d/OLDID/edit');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/presentations'), 'must not create a new deck on update');
  const batch = calls.find((c) => c.path.endsWith('/batch-update')).body.requests;
  const deletes = batch.filter((r) => r.deleteObject).map((r) => r.deleteObject.objectId);
  assert.deepEqual(deletes, ['deck_slide_1', 'deck_slide_2'], 'both old slides removed before rebuild');
});
