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
const compactCoverage = mapCoverage(COMPACT_MAP, isDirectory);

test('exact file paths in the map count as documented', () => {
  assert.equal(isPathCovered('backend/main.py', compactCoverage), true);
});

test('a directory named in the map covers the files under it', () => {
  assert.equal(isPathCovered('backend/routers/event_tickets_router.py', compactCoverage), true);
});

test('coverage reaches nested subdirectories too', () => {
  assert.equal(isPathCovered('backend/routers/admin/billing_router.py', compactCoverage), true);
});

test('files in an unmapped area are still flagged', () => {
  assert.equal(isPathCovered('workers/queue_drain.py', compactCoverage), false);
  assert.equal(isPathCovered('backend_extras/thing.py', compactCoverage), false);
});

test('directory entries work with or without a trailing slash', () => {
  // backend/routers/ carries the slash; backend/services relies on the repo check.
  assert.equal(isPathCovered('backend/routers/tickets.py', compactCoverage), true);
  assert.equal(isPathCovered('backend/services/billing.py', compactCoverage), true);
  // Plain prose paths are picked up as well.
  assert.equal(isPathCovered('web/src/components/Button.tsx', compactCoverage), true);
});

test('a mapped file never acts as a directory prefix', () => {
  assert.equal(isPathCovered('backend/main_extra.py', compactCoverage), false);
  assert.equal(isPathCovered('backend/main.pyc', compactCoverage), false);
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
