const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspaceBrainPresent } = require('../lib/workspace-scaffold');

test('a brain with an empty journal directory is incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-journals-'));
  try {
    const brain = path.join(root, 'atris');
    fs.mkdirSync(path.join(brain, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(brain, 'team'));
    fs.mkdirSync(path.join(brain, 'logs', '2026'), { recursive: true });
    for (const name of ['MAP.md', 'TODO.md', 'now.md', 'atris.md', 'wiki/index.md']) {
      fs.writeFileSync(path.join(brain, name), '# workspace\n');
    }
    assert.strictEqual(workspaceBrainPresent(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
