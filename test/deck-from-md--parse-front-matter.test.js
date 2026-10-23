const test = require('node:test');
const assert = require('node:assert');
const { parseFrontMatter } = require('../lib/deck-from-md');

test('parseFrontMatter extracts known keys and splits body on standard markdown', () => {
  const md = [
    '---',
    'theme: terminal',
    'brand: "Atris Core"',
    'accent: \'#10b981\'',
    '---',
    '# Pitch Deck',
    '',
    'Body content goes here.',
  ].join('\n');

  const { body, fm } = parseFrontMatter(md);

  assert.deepStrictEqual(fm, {
    theme: 'terminal',
    brand: 'Atris Core',
    accent: '#10b981',
  });
  assert.strictEqual(body, '# Pitch Deck\n\nBody content goes here.');
});

test('parseFrontMatter handles case-insensitivity, CRLF, and ignores extra fields', () => {
  const md = '---\r\nTHEME: paper\r\nAuthor: Jane Doe\r\nBRAND: "Acme"\r\nACCENT: teal\r\ninvalid_line_without_colon\r\n---\r\n## Section 1\r\n';

  const { body, fm } = parseFrontMatter(md);

  assert.deepStrictEqual(fm, {
    theme: 'paper',
    brand: 'Acme',
    accent: 'teal',
  });
  assert.strictEqual(body, '## Section 1\r\n');
});

test('parseFrontMatter returns null values and full body when front matter is missing or empty', () => {
  const empty = parseFrontMatter('');
  assert.deepStrictEqual(empty.fm, { theme: null, brand: null, accent: null });
  assert.strictEqual(empty.body, '');

  const noFrontMatter = '# Just a heading\n\nNo front matter block here.';
  const resNoFm = parseFrontMatter(noFrontMatter);
  assert.deepStrictEqual(resNoFm.fm, { theme: null, brand: null, accent: null });
  assert.strictEqual(resNoFm.body, noFrontMatter);

  const unclosed = '---\ntheme: terminal\n# Unclosed front matter';
  const resUnclosed = parseFrontMatter(unclosed);
  assert.deepStrictEqual(resUnclosed.fm, { theme: null, brand: null, accent: null });
  assert.strictEqual(resUnclosed.body, unclosed);
});
