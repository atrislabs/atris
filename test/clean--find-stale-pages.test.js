const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findStalePages } = require('../commands/clean');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-find-stale-pages-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const atrisDir = path.join(cwd, 'atris');
  function write(relative, content) {
    const file = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }
  return { cwd, atrisDir, write };
}

function page(source) {
  return `---\nlast_compiled: 2001-02-03\nsources:\n  - ${source}\n---\n# Page\n`;
}

test('findStalePages recursively reports missing sources with their original annotation', (t) => {
  const { cwd, atrisDir, write } = fixture(t);
  const source = 'src/missing.js:10-20 (example function)';
  const file = write('atris/wiki/concepts/example.md', page(source));
  assert.deepStrictEqual(findStalePages(cwd, atrisDir), [{
    page: file,
    staleSource: `${source} (missing)`,
    compiledDate: '2001-02-03',
    sourceDate: 'N/A',
  }]);
});

test('findStalePages resolves page-relative sources and ignores unchanged or non-file sources', (t) => {
  const { cwd, atrisDir, write } = fixture(t);
  const source = write('atris/wiki/source.txt', 'unchanged source\n');
  // Earlier than the compilation day in every time zone, so git is never needed.
  const modified = new Date('2000-01-01T12:00:00Z');
  fs.utimesSync(source, modified, modified);
  write('atris/wiki/page.md', page('source.txt:1 (local source)'));
  write('atris/wiki/external.md', page('https://example.com/docs.md'));
  write('atris/wiki/prose.md', page('Reference documentation'));
  assert.deepStrictEqual(findStalePages(cwd, atrisDir), []);
});

test('findStalePages skips excluded directories, non-markdown files, and incomplete frontmatter', (t) => {
  const { cwd, atrisDir, write } = fixture(t);
  for (const directory of ['archive', 'runs', 'qa', 'node_modules', '.git']) {
    write(`atris/wiki/${directory}/ignored.md`, page('missing.txt'));
  }
  write('atris/wiki/ignored.txt', page('missing.txt'));
  write('atris/wiki/plain.md', '# No frontmatter\n');
  write('atris/wiki/unclosed.md', '---\nlast_compiled: 2001-02-03\nsources:\n  - missing.txt\n');
  write('atris/wiki/no-date.md', '---\nsources:\n  - missing.txt\n---\n');
  write('atris/wiki/no-sources.md', '---\nlast_compiled: 2001-02-03\n---\n');
  assert.deepStrictEqual(findStalePages(cwd, atrisDir), []);
});

test('findStalePages returns an empty list for missing and empty directories', (t) => {
  const { cwd, atrisDir } = fixture(t);
  assert.deepStrictEqual(findStalePages(cwd, atrisDir), []);
  fs.mkdirSync(atrisDir);
  assert.deepStrictEqual(findStalePages(cwd, atrisDir), []);
});
