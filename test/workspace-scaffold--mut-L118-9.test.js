const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspaceBrainPresent } = require('../lib/workspace-scaffold');

test('a regular file in place of the team directory is not a complete brain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-team-file-'));
  try {
    const atris = path.join(root, 'atris');
    fs.mkdirSync(path.join(atris, 'wiki'), { recursive: true });
    for (const file of ['MAP.md', 'TODO.md', 'atris.md', 'now.md', 'wiki/index.md']) {
      fs.writeFileSync(path.join(atris, file), '# workspace\n');
    }
    fs.writeFileSync(path.join(atris, 'team'), 'team notes\n');
    assert.strictEqual(workspaceBrainPresent(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
