const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan, loadRegistry } = require('../commands/strings');

test('scan excludes labels in hidden project folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hidden-labels-'));
  const cwd = process.cwd();
  const log = console.log;
  try {
    fs.mkdirSync(path.join(root, '.drafts'));
    fs.writeFileSync(path.join(root, '.drafts', 'page.jsx'), '<button>Publish draft</button>\n');
    fs.writeFileSync(path.join(root, 'page.jsx'), '<button>Save changes</button>\n');
    process.chdir(root);
    console.log = () => {};
    scan(['.']);
    const labels = loadRegistry().strings.map((entry) => entry.text);
    assert.equal(labels.includes('Publish draft'), false);
    assert.equal(labels.includes('Save changes'), true);
  } finally {
    console.log = log;
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
