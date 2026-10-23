const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reviewCommand } = require('../commands/review');

test('an empty service audit prints no findings table', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-empty-'));
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const logs = [];

  try {
    fs.mkdirSync(path.join(root, 'backend', 'services'), { recursive: true });
    // Discovery needs this marker, but with no services it is never executed.
    fs.writeFileSync(path.join(root, 'review_engine.py'), '');
    process.chdir(root);
    console.log = (...parts) => logs.push(parts.join(' '));

    await reviewCommand('--all');

    assert.deepStrictEqual(logs, [
      'Auditing all Python services...\n',
      'AUDIT: 0 services | 0 clean | 0 with findings\n',
      '',
    ]);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
