const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHtml } = require('../lib/html-render');

test('paper headings retain their display font and serif fallback', () => {
  const html = renderHtml({
    theme: 'paper',
    brand: { name: 'Field Notes' },
    slides: [{ type: 'title', headline: 'A quieter page' }],
  });
  const display = html.match(/--font-display\s*:\s*([^;]+);/);
  assert.equal(display && display[1].replace(/\s/g, ''), "'Fraunces',serif");
});
