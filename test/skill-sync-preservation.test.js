'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const cli = path.join(repo, 'bin', 'atris.js');
const packaged = fs.readFileSync(path.join(repo, 'atris/skills/atris/SKILL.md'));

for (const args of [['init', '--minimal', '--yes', '--no-commit'], ['update', '--yes'], ['sync', '--yes']]) {
  test(`${args[0]} preserves customized project and global skills while installing missing skills`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-preserve-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project'), home = path.join(root, 'home');
    fs.mkdirSync(cwd); fs.mkdirSync(home);
    const owned = [path.join(cwd, 'atris/skills/atris/SKILL.md'), path.join(home, '.codex/skills/atris/SKILL.md'), path.join(home, '.claude/skills/atris/SKILL.md')];
    for (const file of owned) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'custom user text\n', { mode: 0o600 }); }
    const nested = path.join(cwd, 'atris/skills/autopilot/hooks/stop-hook.sh');
    fs.mkdirSync(path.dirname(nested), { recursive: true }); fs.writeFileSync(nested, 'custom hook\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_CAMPAIGN_DB: path.join(root, 'campaign.db'), ATRIS_RSI_STATE: path.join(root, 'rsi') };
    delete env.NODE_TEST_CONTEXT; delete env.ATRIS_TEST_STATE_DIR; delete env.ATRIS_TEST_PROTECTED_HOME;
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr + result.stdout, /existing skill file not replaced/);
    for (const file of owned) { assert.equal(fs.readFileSync(file, 'utf8'), 'custom user text\n'); assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
    assert.equal(fs.readFileSync(nested, 'utf8'), 'custom hook\n');
    assert.ok(fs.existsSync(path.join(cwd, 'atris/skills/aeo/SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.codex/skills/aeo/SKILL.md')));
  });
}

test('sync package skills preserves empty files, symlinks and dangling symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skills = path.join(root, 'atris/skills');
  fs.mkdirSync(path.join(skills, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'atris/SKILL.md'), '');
  fs.mkdirSync(path.join(skills, 'aeo'), { recursive: true });
  const target = path.join(root, 'owned'); fs.writeFileSync(target, 'owned\n');
  fs.symlinkSync(target, path.join(skills, 'aeo/SKILL.md'));
  fs.mkdirSync(path.join(skills, 'autopilot'), { recursive: true });
  fs.symlinkSync(path.join(root, 'missing'), path.join(skills, 'autopilot/SKILL.md'));
  const { syncWorkspaceTemplate } = require('../commands/sync');
  syncWorkspaceTemplate(root, { name: 'Fixture', slug: 'fixture', business_id: 'fixture', workspace_id: 'fixture' }, { templateName: 'business' });
  assert.equal(fs.readFileSync(path.join(skills, 'atris/SKILL.md'), 'utf8'), '');
  assert.equal(fs.readFileSync(target, 'utf8'), 'owned\n');
  assert.ok(fs.lstatSync(path.join(skills, 'aeo/SKILL.md')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(skills, 'autopilot/SKILL.md')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
  assert.notDeepEqual(Buffer.alloc(0), packaged);
});
