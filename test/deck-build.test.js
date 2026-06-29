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

test('publishDeck does a second pass to insert speaker notes', async () => {
  const calls = [];
  const api = async (method, p, body) => {
    calls.push({ method, p, body });
    if (method === 'POST' && p === '/presentations') return { presentationId: 'NID', slides: [{ objectId: 'p_default' }] };
    if (method === 'GET' && p === '/presentations/NID') {
      return { slides: [
        { objectId: 'deck_slide_1', slideProperties: { notesPage: { pageElements: [{ objectId: 'n1', shape: { placeholder: { type: 'BODY' } } }] } } },
        { objectId: 'deck_slide_2', slideProperties: { notesPage: { pageElements: [{ objectId: 'n2', shape: { placeholder: { type: 'BODY' } } }] } } },
      ] };
    }
    if (p.endsWith('/batch-update')) return {};
    throw new Error(`unexpected ${method} ${p}`);
  };
  const spec = { theme: 'paper', brand: { name: 'X' }, slides: [
    { type: 'statement', text: 'One.', notes: 'ts 00:10' },
    { type: 'statement', text: 'Two.' },
  ] };
  const res = await publishDeck({ spec, title: 'T', updateId: null, api, token: 'tok' });
  assert.equal(res.notes, 1, 'one note inserted');
  // a GET happened (to find notes bodies) and two batch-updates were sent
  assert.ok(calls.some((c) => c.method === 'GET' && c.p === '/presentations/NID'));
  const batches = calls.filter((c) => c.p.endsWith('/batch-update'));
  assert.equal(batches.length, 2, 'main build batch + notes batch');
  assert.deepEqual(batches[1].body.requests[0], { insertText: { objectId: 'n1', text: 'ts 00:10' } });
});

test('publishDeck skips the notes pass entirely when no slide has notes', async () => {
  const calls = [];
  const api = async (method, p) => {
    calls.push({ method, p });
    if (method === 'POST' && p === '/presentations') return { presentationId: 'NN', slides: [{ objectId: 'p_default' }] };
    if (p.endsWith('/batch-update')) return {};
    throw new Error(`unexpected ${method} ${p}`);
  };
  const res = await publishDeck({ spec: SPEC, title: 'T', updateId: null, api, token: 'tok' });
  assert.equal(res.notes, 0);
  assert.ok(!calls.some((c) => c.method === 'GET'), 'no GET when there are no notes');
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
