require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('workspace persona uses the display name rather than the business slug', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-display-name-'));
  const previousEnv = { ...process.env };
  const previousLog = console.log;
  process.env.HOME = root;
  console.log = () => {};
  try {
    const { syncWorkspaceTemplate } = require('../commands/sync');
    syncWorkspaceTemplate(root, { name: 'Cedar Research', slug: 'cedar-lab' }, {
      templateName: 'research', dryRun: false, force: false,
    });
    const persona = fs.readFileSync(path.join(root, 'atris', 'PERSONA.md'), 'utf8');
    const displayName = persona.match(/^# (.*): Persona$/m)?.[1];
    assert.strictEqual(displayName, 'Cedar Research');
  } finally {
    console.log = previousLog;
    process.env = previousEnv;
  }
});
