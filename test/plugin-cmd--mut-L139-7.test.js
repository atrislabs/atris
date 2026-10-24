const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('published README uses the declared skill name instead of its folder', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-readme-name-'));
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Stop publishing at the first Git operation, after the README is written.
  t.mock.method(childProcess, 'execSync', () => {
    throw new Error('Git operations are disabled in this test');
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const { pluginCommand } = require('../commands/plugin');

  const skillDir = path.join(root, 'atris', 'skills', 'mail-folder');
  const marketplace = path.join(root, 'marketplace');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(marketplace);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: inbox-helper\ndescription: Organize mail. More details.\n---\n\n# Mail\n');
  process.chdir(root);

  pluginCommand('publish', `--repo=${marketplace}`);

  const readme = fs.readFileSync(
    path.join(marketplace, 'plugins', 'atris-workspace', 'README.md'), 'utf8');
  assert.deepEqual(readme.split('\n').filter(line => line.startsWith('- **')),
    ['- **inbox-helper**: Organize mail']);
});
