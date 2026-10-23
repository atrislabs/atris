const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncWorkspaceTemplate } = require('../commands/sync');

test('research workspace documentation retains its selected template', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-template-value-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    syncWorkspaceTemplate(root, {
      name: 'Research Lab',
      slug: 'research-lab',
      business_id: 'biz-research-lab',
      workspace_id: 'ws-research-lab',
      workspace_template: 'research',
    }, { templateName: 'research' });
    const content = fs.readFileSync(path.join(root, 'atris', 'context', 'live-workspace.md'), 'utf8');
    assert.match(content, /Template:\s*`research`/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
