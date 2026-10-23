const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appCommand } = require('../commands/app');

test('app init external writes the complete external runtime manifest', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-app-external-'));
  const originalCwd = process.cwd();
  const originalLog = console.log;
  t.after(() => {
    console.log = originalLog;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# workspace\n');
  process.chdir(root);
  console.log = () => {};

  await appCommand('init', 'external-app', '--runtime', 'external');

  assert.equal(
    fs.readFileSync(path.join(root, 'apps', 'external-app', 'APP.md'), 'utf8'),
    [
      '---',
      'schema_version: 1',
      'name: external-app',
      'slug: external-app',
      'description: One-line description of what external-app does.',
      'access: business',
      'runtime: external',
      'vault: atris-kms',
      'runtime_auth: jwt',
      'endpoints:',
      '  api: https://api.example.com',
      '  frontend: https://app.example.com',
      '  mcp: https://example.com/mcp',
      'auth:',
      '  type: oauth',
      '  issuer: https://auth.example.com',
      'capabilities: []',
      'secrets: []',
      'surfaces: [web, slack, mcp]',
      'render: inline',
      '---',
      '# external-app',
      '',
      'What this app does, step by step.',
      '',
      '1. First action (reference secrets by name like `MY_API_KEY`).',
      '2. Second action.',
      '3. Where the output goes.',
      '',
      '## Guardrails',
      '',
      '- What this app will never do.',
      '- What happens when a secret is missing.',
      '',
    ].join('\n'),
  );
});
