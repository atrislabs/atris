const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHtml } = require('../lib/html-render');

test('navigation preserves a supplied destination and label', () => {
  const html = renderHtml({
    slides: [],
  }, { nav: { links: [{ href: '/guide', label: 'Read the guide' }] } });
  assert.match(html, /<a\s+href="\/guide">Read the guide<\/a>/);
});
