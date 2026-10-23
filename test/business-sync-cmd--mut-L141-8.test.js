const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('push preview is allowed without a recorded workspace root', () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'business-sync-preview-'));
  const keys = ['HOME', 'ATRIS_TEST_STATE_DIR', 'ATRIS_TEST_REAL_HOME'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.HOME = temporaryHome;
    process.env.ATRIS_TEST_STATE_DIR = temporaryHome;
    delete process.env.ATRIS_TEST_REAL_HOME;

    const { canPreviewPush } = require('../commands/business-sync');
    const slug = 'preview-fixture';
    assert.strictEqual(canPreviewPush(temporaryHome, slug), true,
      'a first sync without a manifest permits a push preview');

    const manifestDir = path.join(temporaryHome, '.atris', 'businesses', slug);
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({ files: {} }));
    assert.strictEqual(canPreviewPush(temporaryHome, slug), true,
      'a manifest without workspace_root permits a push preview');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});
