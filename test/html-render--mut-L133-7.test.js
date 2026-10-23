const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHtml, THEMES } = require('../lib/html-render');

test('a custom theme with Fraunces headings still includes the web font stylesheet', () => {
  const themes = {
    brand: {
      ...THEMES.atris,
      fonts: { ...THEMES.atris.fonts, display: 'Fraunces' },
    },
  };
  const html = renderHtml({
    theme: 'brand',
    slides: [{ type: 'title', headline: 'Our story' }],
  }, { themes });

  assert.match(html, /<link\b[^>]*href=["']https:\/\/fonts\.googleapis\.com\/css2\?[^"']*family=Fraunces\b/);
});
