const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectWorkspaceState } = require('../lib/state-detection');

test('workspace state ignores underscore-prefixed in-progress features', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'state-detection-underscore-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const features = path.join(workspace, 'atris', 'features');
  for (const name of ['_template', 'visible-feature']) {
    const directory = path.join(features, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'idea.md'), '**Status:** in-progress\n');
  }

  assert.deepStrictEqual(detectWorkspaceState(workspace), {
    state: 'in-progress',
    feature: 'visible-feature',
    file: path.join(features, 'visible-feature', 'idea.md'),
  });
});
