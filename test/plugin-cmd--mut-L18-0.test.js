const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('publish copies skill files and nested assets while excluding metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-copy-test-'));
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const project = path.join(root, 'project');
  const marketplace = path.join(root, 'marketplace');
  const skill = path.join(project, 'atris', 'skills', 'example');
  fs.mkdirSync(path.join(skill, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(skill, '.git'), { recursive: true });
  fs.mkdirSync(marketplace);
  const markdown = '---\nname: example\ndescription: A local fixture\n---\n\n# Example\n';
  fs.writeFileSync(path.join(skill, 'SKILL.md'), markdown);
  fs.writeFileSync(path.join(skill, 'assets', 'example.txt'), 'copied asset\n');
  fs.writeFileSync(path.join(skill, '.DS_Store'), 'excluded metadata');
  fs.writeFileSync(path.join(skill, '.git', 'config'), 'excluded git data');

  // Keep publishing local: simulate an unchanged git status so no commit or push runs.
  const commands = [];
  t.mock.method(childProcess, 'execSync', (command) => {
    commands.push(command);
    assert.ok(command === 'git add -A' || command === 'git status --porcelain');
    return '';
  });
  t.mock.method(console, 'log', () => {});
  const { pluginCommand } = require('../commands/plugin');
  process.chdir(project);
  pluginCommand('publish', `--repo=${marketplace}`);

  const copied = path.join(marketplace, 'plugins', 'atris-workspace', 'skills', 'example');
  assert.deepEqual(fs.readdirSync(copied).sort(), ['SKILL.md', 'assets']);
  assert.equal(fs.readFileSync(path.join(copied, 'SKILL.md'), 'utf8'), markdown);
  assert.deepEqual(fs.readdirSync(path.join(copied, 'assets')), ['example.txt']);
  assert.equal(fs.readFileSync(path.join(copied, 'assets', 'example.txt'), 'utf8'), 'copied asset\n');
  assert.deepEqual(commands, ['git add -A', 'git status --porcelain']);
});
