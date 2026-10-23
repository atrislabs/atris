const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncWorkspaceTemplate } = require('../commands/sync');

test('business template selection reports the business environment', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-template-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const messages = [];
  const originalLog = console.log;
  console.log = (...args) => messages.push(args);
  try {
    syncWorkspaceTemplate(root, { name: 'Sample', slug: 'sample' }, {
      templateName: 'business',
      dryRun: true,
      force: false,
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(messages[1], [
    'Updating Sample (sample) from business environment templates...',
  ]);
  assert.deepEqual(fs.readdirSync(root), []);
});
