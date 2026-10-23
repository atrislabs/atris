const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHtml } = require('../lib/html-render');

test('an explicit page title takes precedence over the brand name', () => {
  const html = renderHtml(
    { brand: { name: 'Aurora' }, slides: [] },
    { title: 'Quarterly review' },
  );
  const title = html.match(/<title>([^<]*)<\/title>/);
  assert.strictEqual(title && title[1], 'Quarterly review');
});
