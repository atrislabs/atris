const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePushArgv,
  normalizePushScopePath,
  resolveChangedScopePaths,
  mergePushScopes,
  buildPushChangePlan,
} = require('../commands/push');

test('parsePushArgv keeps business slug and collects positional file paths', () => {
  const parsed = parsePushArgv([
    'node', 'atris', 'push', 'example-co', 'atris/now.md', 'README.md', '--dry-run',
  ]);
  assert.equal(parsed.slug, 'example-co');
  assert.deepEqual(parsed.pathArgs, ['atris/now.md', 'README.md']);
  assert.equal(parsed.changed, false);
  assert.equal(parsed.onlyRaw, null);
});

test('parsePushArgv treats path-like first args as files when business is auto-detected', () => {
  const parsed = parsePushArgv([
    'node', 'atris', 'push', 'atris/wiki/index.md', '--changed', '--only', 'atris/',
  ]);
  assert.equal(parsed.slug, null);
  assert.deepEqual(parsed.pathArgs, ['atris/wiki/index.md']);
  assert.equal(parsed.changed, true);
  assert.equal(parsed.onlyRaw, 'atris/');
});

test('normalizePushScopePath keeps exact files and directory prefixes', () => {
  assert.equal(normalizePushScopePath('atris/now.md'), '/atris/now.md');
  assert.equal(normalizePushScopePath('team/nate'), '/team/nate/');
  assert.equal(normalizePushScopePath('wiki'), '/atris/wiki/');
});

test('resolveChangedScopePaths returns only local hashes that differ from the manifest', () => {
  const paths = resolveChangedScopePaths(
    {
      '/atris/now.md': { hash: 'new', size: 3 },
      '/atris/MAP.md': { hash: 'same', size: 4 },
      '/README.md': { hash: 'fresh', size: 5 },
    },
    {
      '/atris/now.md': { hash: 'old', size: 2 },
      '/atris/MAP.md': { hash: 'same', size: 4 },
    }
  );
  assert.deepEqual(paths, ['/README.md', '/atris/now.md']);
});

test('mergePushScopes turns positional paths into an exact push plan', () => {
  const onlyPrefixes = mergePushScopes({
    pathArgs: ['atris/now.md', 'README.md'],
  });
  const plan = buildPushChangePlan({
    onlyPrefixes,
    baseFiles: {
      '/atris/now.md': { hash: 'old', size: 2 },
      '/atris/MAP.md': { hash: 'map', size: 4 },
      '/README.md': { hash: 'readme-old', size: 5 },
    },
    localFiles: {
      '/atris/now.md': { hash: 'new', size: 3 },
      '/atris/MAP.md': { hash: 'map-changed', size: 6 },
      '/README.md': { hash: 'readme-new', size: 7 },
    },
    readFileContent: (filePath) => `body:${filePath}`,
  });

  assert.deepEqual(onlyPrefixes, ['/atris/now.md', '/README.md']);
  assert.deepEqual(plan.filesToPush.map((f) => f.path).sort(), ['/README.md', '/atris/now.md']);
  assert.deepEqual(plan.deletedPaths, []);
});

test('mergePushScopes --changed scopes the plan to manifest diffs only', () => {
  const localFiles = {
    '/atris/now.md': { hash: 'new', size: 3 },
    '/atris/MAP.md': { hash: 'same', size: 4 },
    '/notes.md': { hash: 'notes', size: 5 },
  };
  const baseFiles = {
    '/atris/now.md': { hash: 'old', size: 2 },
    '/atris/MAP.md': { hash: 'same', size: 4 },
  };
  const onlyPrefixes = mergePushScopes({ changed: true, localFiles, baseFiles });
  const plan = buildPushChangePlan({
    onlyPrefixes,
    localFiles,
    baseFiles,
    readFileContent: (filePath) => `body:${filePath}`,
  });

  assert.deepEqual(onlyPrefixes, ['/atris/now.md', '/notes.md']);
  assert.deepEqual(plan.filesToPush.map((f) => f.path).sort(), ['/atris/now.md', '/notes.md']);
  assert.equal(plan.unchangedCount, 0);
});

test('mergePushScopes --changed with no diffs stays empty instead of widening', () => {
  const localFiles = {
    '/atris/now.md': { hash: 'same', size: 3 },
  };
  const baseFiles = {
    '/atris/now.md': { hash: 'same', size: 3 },
  };
  assert.deepEqual(mergePushScopes({ changed: true, localFiles, baseFiles }), []);
  assert.equal(mergePushScopes({}), null);
});
