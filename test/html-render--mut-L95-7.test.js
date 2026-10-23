const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHtml } = require('../lib/html-render');

test('a panel slide preserves its supplied row content', () => {
  const html = renderHtml({
    slides: [{
      type: 'panel',
      panel: { rows: [{ title: 'Release checklist', value: 'Ready' }] },
    }],
  });

  assert.ok(html.includes('Release checklist'));
});
