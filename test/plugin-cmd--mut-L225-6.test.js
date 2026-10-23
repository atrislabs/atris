const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const discovery = require('../commands/skill');

test('build still packages the workspace if a discovered skill is removed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-removed-skill-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  process.env.HOME = root;
  process.chdir(root);
  const skillDir = path.join(root, 'atris', 'skills', 'mail');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: mail\ndescription: Organize mail\n---\n# Mail\n');

  // Model a user removing a skill after discovery, before packaging it.
  const findAllSkills = discovery.findAllSkills;
  t.mock.method(discovery, 'findAllSkills', (...args) => {
    const skills = findAllSkills(...args);
    fs.rmSync(skillDir, { recursive: true, force: true });
    return skills;
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', () => { throw new Error('command exited'); });
  const { pluginCommand } = require('../commands/plugin');
  try {
    pluginCommand('build');
  } catch {
    // Check the user-visible result even if packaging throws.
  }
  assert.equal(fs.existsSync(path.join(root, 'atris-workspace.plugin')), true);
});
