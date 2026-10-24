const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { workspaceBrainPresent } = require('../lib/workspace-scaffold');

test('workspaceBrainPresent returns false when only the logs directory is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-missing-logs-'));
  try {
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(path.join(atrisDir, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(atrisDir, 'team'));
    for (const relativePath of ['MAP.md', 'TODO.md', 'now.md', 'atris.md', 'wiki/index.md']) {
      fs.writeFileSync(path.join(atrisDir, relativePath), '');
    }

    assert.strictEqual(workspaceBrainPresent(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
