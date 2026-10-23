const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncWorkspaceTemplate } = require('../commands/sync');

test('workspace template preview reports the supplied business slug', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-slug-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = t.mock.method(console, 'log', () => {});

  syncWorkspaceTemplate(root, { name: 'Sample Studio', slug: 'sample-studio' }, {
    dryRun: true,
    force: false,
  });

  const heading = log.mock.calls.map(call => call.arguments[0])
    .find(line => typeof line === 'string' && line.startsWith('Updating '));
  assert.equal(heading, 'Updating Sample Studio (sample-studio) from business environment templates...');
  assert.deepEqual(fs.readdirSync(root), []);
});
