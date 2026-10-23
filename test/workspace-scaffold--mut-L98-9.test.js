const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspaceBrainPresent } = require('../lib/workspace-scaffold');

test('workspaceBrainPresent rejects a logs path that is a regular file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-invalid-logs-'));
  try {
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(path.join(atrisDir, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(atrisDir, 'team'));
    for (const name of ['MAP.md', 'TODO.md', 'now.md', 'atris.md', 'wiki/index.md']) {
      fs.writeFileSync(path.join(atrisDir, name), '# fixture\n');
    }
    // The path exists, but reading it as a directory fails with ENOTDIR.
    fs.writeFileSync(path.join(atrisDir, 'logs'), '# not a journal directory\n');

    assert.strictEqual(workspaceBrainPresent(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
