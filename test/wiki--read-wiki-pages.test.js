const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWikiPages } = require('../lib/wiki');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-read-wiki-pages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('reads recursive markdown pages in all content folders with parsed metadata', (t) => {
  const root = fixture(t);
  const content = '---\ntitle: "Ada"\ntags: [person, "engineer"]\nsources:\n  - "context/interview.md"\nlast_compiled: 2024-01-15\n---\n# Ada\nCafé notes.\n';
  const filePath = write(root, 'atris/wiki/people/team/ada.md', content);
  write(root, 'atris/wiki/systems/service.md', '# Service\n');
  write(root, 'atris/wiki/concepts/pattern.md', '# Pattern\n');
  write(root, 'atris/wiki/briefs/overview.md', '# Overview\n');
  write(root, 'atris/wiki/index.md', '# Index\n');
  write(root, 'atris/wiki/people/notes.txt', 'not a page');
  write(root, 'atris/wiki/other/ignored.md', '# Outside content folders\n');

  const pages = readWikiPages(root);
  assert.deepStrictEqual(pages.map((page) => page.relativePath).sort(), [
    'atris/wiki/briefs/overview.md',
    'atris/wiki/concepts/pattern.md',
    'atris/wiki/people/team/ada.md',
    'atris/wiki/systems/service.md',
  ]);
  assert.deepStrictEqual(pages.find((page) => page.relativePath.endsWith('/ada.md')), {
    filePath,
    relativePath: 'atris/wiki/people/team/ada.md',
    content,
    frontmatter: {
      title: 'Ada',
      tags: ['person', 'engineer'],
      sources: ['context/interview.md'],
      last_compiled: '2024-01-15',
    },
  });
  assert.deepStrictEqual(pages.find((page) => page.relativePath.endsWith('/service.md')).frontmatter, {});
});

test('private mode reads only private pages and preserves empty or malformed content', (t) => {
  const root = fixture(t);
  write(root, 'atris/wiki/people/public.md', '# Public\n');
  const emptyPath = write(root, '.atris/presidio/concepts/empty.md', '');
  const malformed = '---\ntitle: Unclosed\n# Body\n';
  const malformedPath = write(root, '.atris/presidio/briefs/unclosed.md', malformed);

  assert.deepStrictEqual(readWikiPages(root, 'private'), [
    {
      filePath: emptyPath,
      relativePath: '.atris/presidio/concepts/empty.md',
      content: '',
      frontmatter: {},
    },
    {
      filePath: malformedPath,
      relativePath: '.atris/presidio/briefs/unclosed.md',
      content: malformed,
      frontmatter: {},
    },
  ]);
});

test('missing or empty wiki directories return no pages without creating files', (t) => {
  const root = fixture(t);
  assert.deepStrictEqual(readWikiPages(root), []);
  assert.deepStrictEqual(readWikiPages(root, 'private'), []);
  assert.deepStrictEqual(fs.readdirSync(root), []);

  fs.mkdirSync(path.join(root, 'atris/wiki/people'), { recursive: true });
  assert.deepStrictEqual(readWikiPages(root), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'atris/wiki')), ['people']);
});
