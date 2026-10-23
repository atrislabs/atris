'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findStaleWikiPages } = require('../lib/wiki');

// Source mtimes are set by hand so no result depends on the clock or the
// local time zone. OLD and NEW sit years either side of last_compiled.
const COMPILED = '2020-06-15';
const OLD = new Date(Date.UTC(2010, 0, 1, 12));
const NEW = new Date(Date.UTC(2030, 0, 1, 12));

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stale-wiki-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeAt(root, rel, content, mtime) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  if (mtime) fs.utimesSync(full, mtime, mtime);
  return full;
}

function writePage(root, rel, frontmatterLines, body = 'page body') {
  const fm = frontmatterLines === null ? '' : `---\n${frontmatterLines.join('\n')}\n---\n\n`;
  return writeAt(root, rel, `${fm}${body}\n`);
}

function byPage(items) {
  return items.slice().sort((a, b) => a.page.localeCompare(b.page));
}

test('returns an empty list when there is no wiki or the wiki has no pages', (t) => {
  const root = makeRoot(t);
  assert.deepStrictEqual(findStaleWikiPages(root), []);

  fs.mkdirSync(path.join(root, 'atris', 'wiki', 'concepts'), { recursive: true });
  assert.deepStrictEqual(findStaleWikiPages(root), []);
  assert.deepStrictEqual(findStaleWikiPages(root, 'private'), []);
});

test('pages with no usable sources are never stale', (t) => {
  const root = makeRoot(t);
  writePage(root, 'atris/wiki/concepts/no-frontmatter.md', null);
  writePage(root, 'atris/wiki/concepts/no-sources.md', ['type: concept', `last_compiled: ${COMPILED}`]);
  writePage(root, 'atris/wiki/concepts/empty-sources.md', ['sources:', `last_compiled: ${COMPILED}`]);
  // A bare string is not an array, so it counts as no sources.
  writePage(root, 'atris/wiki/concepts/string-sources.md', ['sources: ghost/missing.md', `last_compiled: ${COMPILED}`]);

  assert.deepStrictEqual(findStaleWikiPages(root), []);
});

test('reports a page with sources but no last_compiled, naming the first source', (t) => {
  const root = makeRoot(t);
  writeAt(root, 'notes/a.md', 'a', OLD);
  writeAt(root, 'notes/b.md', 'b', OLD);
  writePage(root, 'atris/wiki/systems/uncompiled.md', ['sources:', '  - notes/a.md', '  - notes/b.md']);

  assert.deepStrictEqual(findStaleWikiPages(root), [
    {
      page: 'atris/wiki/systems/uncompiled.md',
      staleSource: 'notes/a.md',
      reason: 'missing last_compiled',
    },
  ]);
});

test('reports a source file that no longer exists', (t) => {
  const root = makeRoot(t);
  writeAt(root, 'notes/kept.md', 'kept', OLD);
  writePage(root, 'atris/wiki/people/ada.md', [
    'sources: [notes/kept.md, notes/gone.md]',
    `last_compiled: ${COMPILED}`,
  ]);

  assert.deepStrictEqual(findStaleWikiPages(root), [
    {
      page: 'atris/wiki/people/ada.md',
      staleSource: 'notes/gone.md',
      reason: 'missing source',
    },
  ]);
});

test('reports the source that changed after last_compiled and skips fresh ones', (t) => {
  const root = makeRoot(t);
  writeAt(root, 'notes/fresh.md', 'fresh', OLD);
  writeAt(root, 'notes/changed.md', 'changed', NEW);
  writeAt(root, 'notes/untouched.md', 'untouched', OLD);

  writePage(root, 'atris/wiki/concepts/stale.md', [
    'sources:',
    '  - notes/fresh.md',
    '  - notes/changed.md',
    `last_compiled: ${COMPILED}`,
  ]);
  writePage(root, 'atris/wiki/concepts/current.md', [
    'sources:',
    '  - notes/fresh.md',
    '  - notes/untouched.md',
    `last_compiled: ${COMPILED}`,
  ]);

  assert.deepStrictEqual(findStaleWikiPages(root), [
    {
      page: 'atris/wiki/concepts/stale.md',
      staleSource: 'notes/changed.md',
      reason: 'source newer than last_compiled',
    },
  ]);
});

test('a page gets at most one entry even when several sources are stale', (t) => {
  const root = makeRoot(t);
  writeAt(root, 'notes/one.md', 'one', NEW);
  writeAt(root, 'notes/two.md', 'two', NEW);
  writePage(root, 'atris/wiki/concepts/double.md', [
    'sources: [notes/one.md, notes/two.md, notes/never-checked.md]',
    `last_compiled: ${COMPILED}`,
  ]);

  const result = findStaleWikiPages(root);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].staleSource, 'notes/one.md');
  assert.strictEqual(result[0].reason, 'source newer than last_compiled');
});

test('last_compiled covers the whole local day it names', (t) => {
  const root = makeRoot(t);
  writePage(root, 'atris/wiki/concepts/edge.md', ['sources: [notes/edge.md]', `last_compiled: ${COMPILED}`]);

  // Local-time constructors keep the comparison the same in every time zone.
  writeAt(root, 'notes/edge.md', 'x', new Date(2020, 5, 15, 12, 0, 0));
  assert.deepStrictEqual(findStaleWikiPages(root), []);

  writeAt(root, 'notes/edge.md', 'x', new Date(2020, 5, 15, 23, 59, 0));
  assert.deepStrictEqual(findStaleWikiPages(root), []);

  writeAt(root, 'notes/edge.md', 'x', new Date(2020, 5, 16, 0, 0, 30));
  const result = findStaleWikiPages(root);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].reason, 'source newer than last_compiled');
});

test('urls and external system labels are not treated as local files', (t) => {
  const root = makeRoot(t);
  writePage(root, 'atris/wiki/systems/external.md', [
    'sources:',
    '  - https://example.com/spec.md',
    '  - hubspot',
    '  - chorus',
    '  - chorus/calls/123',
    '  - greenhouse/jobs.md',
    `last_compiled: ${COMPILED}`,
  ]);

  assert.deepStrictEqual(findStaleWikiPages(root), []);
});

test('context/ and team/ sources resolve under atris/ when the file is there', (t) => {
  const root = makeRoot(t);
  writeAt(root, 'atris/context/old-brief.md', 'old', OLD);
  writeAt(root, 'atris/context/new-brief.md', 'new', NEW);
  writeAt(root, 'atris/team/lead/MEMBER.md', 'member', NEW);

  writePage(root, 'atris/wiki/briefs/fresh.md', ['sources: [context/old-brief.md]', `last_compiled: ${COMPILED}`]);
  writePage(root, 'atris/wiki/briefs/stale-context.md', ['sources: [context/new-brief.md]', `last_compiled: ${COMPILED}`]);
  writePage(root, 'atris/wiki/briefs/stale-team.md', ['sources: [team/lead/MEMBER.md]', `last_compiled: ${COMPILED}`]);
  // Not under atris/context, so it falls back to <root>/context/... which is absent.
  writePage(root, 'atris/wiki/briefs/absent.md', ['sources: [context/nowhere.md]', `last_compiled: ${COMPILED}`]);

  const result = byPage(findStaleWikiPages(root));
  assert.deepStrictEqual(result, [
    { page: 'atris/wiki/briefs/absent.md', staleSource: 'context/nowhere.md', reason: 'missing source' },
    { page: 'atris/wiki/briefs/stale-context.md', staleSource: 'context/new-brief.md', reason: 'source newer than last_compiled' },
    { page: 'atris/wiki/briefs/stale-team.md', staleSource: 'team/lead/MEMBER.md', reason: 'source newer than last_compiled' },
  ]);
});

test('absolute source paths are checked as given', (t) => {
  const root = makeRoot(t);
  const fresh = writeAt(root, 'elsewhere/fresh.md', 'fresh', OLD);
  const changed = writeAt(root, 'elsewhere/changed.md', 'changed', NEW);
  const missing = path.join(root, 'elsewhere', 'missing.md');

  writePage(root, 'atris/wiki/people/abs-fresh.md', [`sources: [${fresh}]`, `last_compiled: ${COMPILED}`]);
  writePage(root, 'atris/wiki/people/abs-changed.md', [`sources: [${changed}]`, `last_compiled: ${COMPILED}`]);
  writePage(root, 'atris/wiki/people/abs-missing.md', [`sources: [${missing}]`, `last_compiled: ${COMPILED}`]);

  assert.deepStrictEqual(byPage(findStaleWikiPages(root)), [
    { page: 'atris/wiki/people/abs-changed.md', staleSource: changed, reason: 'source newer than last_compiled' },
    { page: 'atris/wiki/people/abs-missing.md', staleSource: missing, reason: 'missing source' },
  ]);
});

test('only pages in the four content folders are scanned, and nested pages keep their path', (t) => {
  const root = makeRoot(t);
  writeAt(root, 'notes/changed.md', 'changed', NEW);
  const fm = ['sources: [notes/changed.md]', `last_compiled: ${COMPILED}`];

  writePage(root, 'atris/wiki/people/top.md', fm);
  writePage(root, 'atris/wiki/systems/deep/er/nested.md', fm);
  // Ignored: wrong folder, wiki root file, and a non-markdown file.
  writePage(root, 'atris/wiki/index.md', fm);
  writePage(root, 'atris/wiki/other/stray.md', fm);
  writeAt(root, 'atris/wiki/concepts/notes.txt', `---\n${fm.join('\n')}\n---\n`);

  assert.deepStrictEqual(byPage(findStaleWikiPages(root)), [
    { page: 'atris/wiki/people/top.md', staleSource: 'notes/changed.md', reason: 'source newer than last_compiled' },
    { page: 'atris/wiki/systems/deep/er/nested.md', staleSource: 'notes/changed.md', reason: 'source newer than last_compiled' },
  ]);
});

test('private mode reads .atris/presidio and public mode does not see it', (t) => {
  const root = makeRoot(t);
  writeAt(root, 'notes/changed.md', 'changed', NEW);
  const fm = ['sources: [notes/changed.md]', `last_compiled: ${COMPILED}`];
  writePage(root, '.atris/presidio/concepts/secret.md', fm);
  writePage(root, 'atris/wiki/concepts/shared.md', fm);

  assert.deepStrictEqual(findStaleWikiPages(root, 'private'), [
    { page: '.atris/presidio/concepts/secret.md', staleSource: 'notes/changed.md', reason: 'source newer than last_compiled' },
  ]);
  assert.deepStrictEqual(findStaleWikiPages(root), [
    { page: 'atris/wiki/concepts/shared.md', staleSource: 'notes/changed.md', reason: 'source newer than last_compiled' },
  ]);
  assert.deepStrictEqual(findStaleWikiPages(root, 'public'), findStaleWikiPages(root));
});
