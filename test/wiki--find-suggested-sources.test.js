const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findSuggestedSources } = require('../lib/wiki');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-suggested-sources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relativePath, content = '') {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    },
  };
}

test('suggests existing candidates in priority order and respects the limit', (t) => {
  const { root, write } = fixture(t);
  // Create files in a different order from their suggestion priority.
  for (const file of ['commands/wiki.js', 'package.json', 'atris.md', 'README.md', 'unlisted.md']) {
    write(file);
  }

  assert.deepStrictEqual(findSuggestedSources(root), ['README.md', 'atris.md', 'package.json']);
  assert.deepStrictEqual(findSuggestedSources(root, 1), ['README.md']);
  assert.deepStrictEqual(findSuggestedSources(root, 20), [
    'README.md', 'atris.md', 'package.json', 'commands/wiki.js',
  ]);
});

test('excludes normalized sources from nested wiki pages and ignores non-list sources', (t) => {
  const { root, write } = fixture(t);
  for (const file of ['README.md', 'atris/CLAUDE.md', 'package.json', 'commands/init.js']) {
    write(file);
  }
  write('atris/wiki/concepts/nested/relative.md',
    '---\nsources: [./README.md, commands/../commands/init.js]\n---\n# Relative sources\n');
  write('atris/wiki/people/absolute.md',
    `---\nsources:\n  - "${path.join(root, 'atris/CLAUDE.md')}"\n  - https://example.com/source\n  - hubspot\n---\n# Absolute source\n`);
  write('atris/wiki/systems/scalar.md', '---\nsources: package.json\n---\n');
  write('atris/wiki/briefs/no-frontmatter.md', '# No source receipts\n');

  assert.deepStrictEqual(findSuggestedSources(root), ['package.json']);
});

test('returns no suggestions for empty, missing, or fully ingested projects', (t) => {
  const { root, write } = fixture(t);
  assert.deepStrictEqual(findSuggestedSources(root), []);
  assert.deepStrictEqual(findSuggestedSources(path.join(root, 'missing')), []);

  write('README.md');
  write('atris/wiki/briefs/complete.md', '---\nsources: [README.md]\n---\n');
  assert.deepStrictEqual(findSuggestedSources(root), []);
});
