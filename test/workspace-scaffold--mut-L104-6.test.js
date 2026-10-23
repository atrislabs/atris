const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { workspaceBrainPresent } = require('../lib/workspace-scaffold');

test('non-markdown file in logs does not satisfy brain presence', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brain-check-'));
  const savedHome = process.env.HOME;
  process.env.HOME = path.join(sandbox, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });

  const projectRoot = path.join(sandbox, 'project');
  const atrisDir = path.join(projectRoot, 'atris');

  try {
    fs.mkdirSync(path.join(atrisDir, 'team'), { recursive: true });
    fs.mkdirSync(path.join(atrisDir, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(atrisDir, 'logs', '2026'), { recursive: true });

    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), '');
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '');
    fs.writeFileSync(path.join(atrisDir, 'now.md'), '');
    fs.writeFileSync(path.join(atrisDir, 'atris.md'), '');
    fs.writeFileSync(path.join(atrisDir, 'wiki', 'index.md'), '');

    fs.writeFileSync(path.join(atrisDir, 'logs', '2026', 'notes.txt'), 'notes\n');

    assert.strictEqual(workspaceBrainPresent(projectRoot), false);
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
