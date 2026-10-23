const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appCommand } = require('../commands/app');

test('app init with ios runtime writes the exact mobile manifest', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-app-ios-'));
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

  await appCommand('init', 'mobile-app', '--runtime', 'ios');

  assert.equal(
    fs.readFileSync(path.join(root, 'apps', 'mobile-app', 'APP.md'), 'utf8'),
    [
      '---',
      'schema_version: 1',
      'name: mobile-app',
      'slug: mobile-app',
      'description: One-line description of what mobile-app does.',
      'access: business',
      'runtime: ios',
      'vault: atris-kms',
      'runtime_auth: jwt',
      'endpoints:',
      '  bundle_id: com.example.app',
      '  deep_link_scheme: example',
      'capabilities: []',
      'secrets: []',
      'surfaces: [mobile]',
      'render: fullscreen',
      '---',
      '# mobile-app',
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
