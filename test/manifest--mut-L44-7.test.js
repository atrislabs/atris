const test = require('node:test');
const assert = require('node:assert/strict');
const { buildManifest } = require('../lib/manifest');

test('buildManifest preserves the supplied commit hash', () => {
  const commitHash = '0123456789abcdef0123456789abcdef01234567';

  const manifest = buildManifest({}, commitHash);

  assert.strictEqual(manifest.last_commit, commitHash);
});
