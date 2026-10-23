const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listAppManifests } = require('../commands/apps');

test('app manifests expose an unquoted true scalar as boolean true', (t) => {
  const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apps-true-'));
  t.after(() => fs.rmSync(packRoot, { recursive: true, force: true }));
  const appDir = path.join(packRoot, 'apps', 'example');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'APP.md'), '---\nenabled: true\n---\n');

  assert.deepStrictEqual(listAppManifests(packRoot), [{
    slug: 'example',
    path: path.join(appDir, 'APP.md'),
    latest_output: path.join(appDir, 'data', 'latest.md'),
    enabled: true,
  }]);
});
