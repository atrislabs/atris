require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('template update reports state files only when some are missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-report-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    const { syncWorkspaceTemplate, ensureWorkspaceStateFiles } = require('../commands/sync');
    const metadata = { name: 'Example Studio', slug: 'example-studio' };
    const options = { templateName: 'business', dryRun: true };

    const initial = syncWorkspaceTemplate(root, metadata, options);
    assert.ok(initial.stateAddedList.length > 0);
    assert.ok(lines.some(line => /\bstate files:/i.test(line)),
      'missing state files should be reported in the preview');

    ensureWorkspaceStateFiles(root, metadata);
    lines.length = 0;
    const existing = syncWorkspaceTemplate(root, metadata, options);
    assert.equal(existing.stateAddedList.length, 0);
    assert.equal(lines.some(line => /\bstate files:/i.test(line)), false,
      'existing state files should not produce an empty new-state-files section');
  } finally {
    console.log = log;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
