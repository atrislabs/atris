const test = require('node:test');
const assert = require('node:assert');

const { lessonSlug } = require('../lib/auto-lessons');

test('lessonSlug keeps a slug that is exactly 80 characters', () => {
  const slug = 'a'.repeat(80);
  assert.strictEqual(lessonSlug(slug), slug);
});
