const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { listAppManifests } = require('../commands/apps');

function makeTempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('listAppManifests parses a plain key that follows a front matter list', (t) => {
  const root = makeTempDir(t, 'atris-apps-list-end-');
  const pack = path.join(root, 'pack');
  const app = path.join(pack, 'apps', 'demo-app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'APP.md'), `---
schema_version: 1
name: Demo App
slug: demo-app
description: Demo metadata.
runtime: local
secrets:
  - api-key
surfaces:
  - cli
note: kept-as-key
---

# Demo App
`);

  const [manifest] = listAppManifests(pack);
  assert.deepEqual(manifest.secrets, ['api-key']);
  assert.deepEqual(manifest.surfaces, ['cli']);
  assert.equal(manifest.note, 'kept-as-key');
});
