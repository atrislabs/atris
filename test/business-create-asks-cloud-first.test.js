const test = require('node:test');
const assert = require('node:assert');
const { findExistingBusinessBySlug } = require('../commands/business');
const { refusalText } = require('../commands/push');

const staleLocal = () => ({ 'moonrise-capital': { business_id: 'db642f29', name: 'Moonrise Capital', slug: 'moonrise-capital' } });

test('a business deleted in the cloud but still on this Mac does not block create', async () => {
  const api = async (path) => (path.startsWith('/business/by-slug/')
    ? { ok: false, status: 404, data: { detail: 'Not Found' } }
    : { ok: true, status: 200, data: [] });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.strictEqual(await findExistingBusinessBySlug('moonrise-capital', 'tok', { api, loadLocal: staleLocal }), null);
  } finally { console.warn = warn; }
});

test('a business that exists in the cloud is found there', async () => {
  const api = async () => ({ ok: true, status: 200, data: { id: 'new-id', name: 'Moonrise Capital', slug: 'moonrise-capital' } });
  const found = await findExistingBusinessBySlug('moonrise-capital', 'tok', { api, loadLocal: () => ({}) });
  assert.deepStrictEqual(found, { id: 'new-id', name: 'Moonrise Capital', slug: 'moonrise-capital', source: 'cloud' });
});

test('when the cloud cannot be reached the Mac list still prevents a duplicate', async () => {
  const api = async () => ({ ok: false, status: 503, error: 'down' });
  const found = await findExistingBusinessBySlug('moonrise-capital', 'tok', { api, loadLocal: staleLocal });
  assert.strictEqual(found.source, 'local');
});

test('a refused push shows the server reason', () => {
  assert.strictEqual(refusalText({ status: 403, error: 'Blocked by security filter: atris/reports/x.md' }), 'Blocked by security filter: atris/reports/x.md');
  assert.strictEqual(refusalText({ status: 403, error: { message: 'Agent token lacks files:write' } }), 'Agent token lacks files:write');
  assert.strictEqual(refusalText({ status: 403, error: 'Request failed' }), '');
  assert.strictEqual(refusalText(null), '');
});
