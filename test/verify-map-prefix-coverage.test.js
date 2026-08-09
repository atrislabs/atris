const test = require('node:test');
const assert = require('node:assert/strict');

const { mapCoverage, isPathCovered, normalizeMapPath } = require('../commands/verify');

const COMPACT_MAP = `
# MAP

| Area | Where |
|------|-------|
| Routers | \`backend/routers/\` |
| Services | \`backend/services\` |
| Entry point | \`backend/main.py\` |

Frontend work lives in web/src/components/.
`;

// The map names backend/services without a slash, so the repo decides it is a directory.
const isDirectory = (p) => p === 'backend/services' || p === 'web/src/components';

test('exact file paths in the map count as documented', () => {
  const coverage = mapCoverage(COMPACT_MAP, isDirectory);
  assert.equal(isPathCovered('backend/main.py', coverage), true);
});

test('a directory named in the map covers the files under it', () => {
  const coverage = mapCoverage(COMPACT_MAP, isDirectory);
  assert.equal(isPathCovered('backend/routers/event_tickets_router.py', coverage), true);
});

test('coverage reaches nested subdirectories too', () => {
  const coverage = mapCoverage(COMPACT_MAP, isDirectory);
  assert.equal(isPathCovered('backend/routers/admin/billing_router.py', coverage), true);
});

test('files in an unmapped area are still flagged', () => {
  const coverage = mapCoverage(COMPACT_MAP, isDirectory);
  assert.equal(isPathCovered('workers/queue_drain.py', coverage), false);
  assert.equal(isPathCovered('backend_extras/thing.py', coverage), false);
});

test('directory entries work with or without a trailing slash', () => {
  const coverage = mapCoverage(COMPACT_MAP, isDirectory);
  // backend/routers/ carries the slash; backend/services relies on the repo check.
  assert.equal(isPathCovered('backend/routers/tickets.py', coverage), true);
  assert.equal(isPathCovered('backend/services/billing.py', coverage), true);
  // Plain prose paths are picked up as well.
  assert.equal(isPathCovered('web/src/components/Button.tsx', coverage), true);
});

test('a mapped file never acts as a directory prefix', () => {
  const coverage = mapCoverage(COMPACT_MAP, isDirectory);
  assert.equal(isPathCovered('backend/main_extra.py', coverage), false);
  assert.equal(isPathCovered('backend/main.pyc', coverage), false);
});

test('a directory only covers what is beneath it, not itself as a file', () => {
  const coverage = mapCoverage('`backend/routers/`', () => false);
  assert.equal(isPathCovered('backend/routers/', coverage), false);
  assert.equal(isPathCovered('backend/routers', coverage), false);
});

test('non-path noise in the map is ignored', () => {
  const coverage = mapCoverage('run `atris task claim <id>` and see https://example.com/docs/x.py', () => false);
  assert.equal(coverage.dirs.length, 0);
  assert.equal(isPathCovered('docs/x.py', coverage), false);
});

test('leading ./ and trailing prose punctuation are trimmed', () => {
  assert.equal(normalizeMapPath('./backend/routers/'), 'backend/routers/');
  assert.equal(normalizeMapPath('atris/MAP.md.'), 'atris/MAP.md');
  assert.equal(normalizeMapPath('  '), null);
  assert.equal(normalizeMapPath('two words'), null);
});
