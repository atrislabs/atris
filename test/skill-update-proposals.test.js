'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');

test('real CLI proposes package transitions without replacing originals or existing proposals', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-proposal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'package'), cwd = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(pkg); fs.mkdirSync(cwd); fs.mkdirSync(home);
  const globalSkill = path.join(home, '.codex/skills/atris/SKILL.md');
  fs.mkdirSync(path.dirname(globalSkill), { recursive: true }); fs.writeFileSync(globalSkill, 'global custom content\n');
  for (const name of ['bin', 'commands', 'lib', 'utils', 'atris', 'templates', 'package.json', 'atris.md']) fs.cpSync(path.join(repo, name), path.join(pkg, name), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_CAMPAIGN_DB: path.join(root, 'campaign.db') };
  delete env.NODE_TEST_CONTEXT; delete env.ATRIS_TEST_STATE_DIR; delete env.ATRIS_TEST_PROTECTED_HOME;
  const run = (...args) => spawnSync(process.execPath, [path.join(pkg, 'bin/atris.js'), ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
  const init = run('init', '--minimal', '--yes', '--no-commit'); assert.equal(init.status, 0, init.stderr);
  const install = run('update', '--yes'); assert.equal(install.status, 0, install.stderr);
  const skill = path.join(cwd, 'atris/skills/atris/SKILL.md');
  const packaged = path.join(pkg, 'atris/skills/atris/SKILL.md');
  const original = fs.readFileSync(skill, 'utf8'), proposal = skill + '.atris-proposal', pending = proposal + '.pending';
  const v2 = original + '\n# Version 2\n'; fs.writeFileSync(packaged, v2);
  for (const args of [['init', '--minimal', '--yes', '--no-commit'], ['update', '--yes'], ['sync', '--yes']]) {
    const normal = run(...args); assert.equal(normal.status, 0, normal.stderr);
    assert.equal(fs.existsSync(proposal), false); assert.equal(fs.existsSync(pending), false);
  }
  const preview = run('update', '--dry-run', '--propose-skills'); assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stderr, /Would propose/); assert.equal(fs.existsSync(proposal), false); assert.equal(fs.existsSync(pending), false);
  const update = run('update', '--yes', '--propose-skills'); assert.equal(update.status, 0, update.stderr); assert.match(update.stderr, /Proposed.*sha256/);
  assert.equal(fs.readFileSync(globalSkill, 'utf8'), 'global custom content\n');
  assert.equal(fs.existsSync(globalSkill + '.atris-proposal'), false);
  assert.equal(fs.readFileSync(skill, 'utf8'), original); assert.equal(fs.readFileSync(proposal, 'utf8'), v2); assert.equal(fs.readFileSync(pending, 'utf8'), v2);
  const v3 = original + '\n# Version 3\n'; fs.writeFileSync(packaged, v3);
  const repeat = run('sync', '--yes', '--propose-skills'); assert.equal(repeat.status, 0, repeat.stderr); assert.match(repeat.stderr, /Kept existing proposal/);
  assert.equal(fs.readFileSync(skill, 'utf8'), original); assert.equal(fs.readFileSync(proposal, 'utf8'), v2); assert.equal(fs.readFileSync(pending, 'utf8'), v2);
  assert.deepEqual(fs.readdirSync(path.dirname(skill)).filter(x => x.includes('atris-proposal')).sort(), ['SKILL.md.atris-proposal', 'SKILL.md.atris-proposal.pending']);
  assert.equal(fs.statSync(proposal).ino, fs.statSync(pending).ino);
  fs.appendFileSync(proposal, 'review note\n');
  assert.equal(fs.readFileSync(pending, 'utf8'), v2 + 'review note\n');
  assert.equal(fs.readFileSync(skill, 'utf8'), original);
});

test('interrupted staging and existing proposal links are preserved', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-proposal-block-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), home = path.join(root, 'home'); fs.mkdirSync(cwd); fs.mkdirSync(home);
  const skill = path.join(cwd, 'atris/skills/atris/SKILL.md'); fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, 'user content\n');
  const proposal = skill + '.atris-proposal', pending = proposal + '.pending'; fs.writeFileSync(pending, 'interrupted content');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_CAMPAIGN_DB: path.join(root, 'campaign.db') };
  delete env.NODE_TEST_CONTEXT; delete env.ATRIS_TEST_STATE_DIR; delete env.ATRIS_TEST_PROTECTED_HOME;
  const run = () => spawnSync(process.execPath, [path.join(repo, 'bin/atris.js'), 'update', '--yes', '--propose-skills'], { cwd, env, encoding: 'utf8', timeout: 30000 });
  let result = run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /Kept existing staging file/);
  assert.equal(fs.readFileSync(pending, 'utf8'), 'interrupted content'); assert.equal(fs.existsSync(proposal), false);
  fs.unlinkSync(pending); const target = path.join(root, 'outside'); fs.writeFileSync(target, 'outside data'); fs.symlinkSync(target, proposal);
  result = run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /Kept existing proposal/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside data'); assert.equal(fs.readFileSync(skill, 'utf8'), 'user content\n');
});

test('failed publication leaves original and bounded staging file intact', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-proposal-linkfail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), home = path.join(root, 'home'); fs.mkdirSync(cwd); fs.mkdirSync(home);
  const skill = path.join(cwd, 'atris/skills/atris/SKILL.md'); fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, 'user content\n');
  const hook = path.join(root, 'link-failure.js');
  fs.writeFileSync(hook, `const fs = require('fs'); const link = fs.linkSync; fs.linkSync = function(a, b) { if (String(b).endsWith('.atris-proposal')) { const e = new Error('injected link failure'); e.code = 'EIO'; throw e; } return link.apply(this, arguments); };`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: `--require=${hook}`, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_CAMPAIGN_DB: path.join(root, 'campaign.db') };
  delete env.NODE_TEST_CONTEXT; delete env.ATRIS_TEST_STATE_DIR; delete env.ATRIS_TEST_PROTECTED_HOME;
  const result = spawnSync(process.execPath, [path.join(repo, 'bin/atris.js'), 'update', '--yes', '--propose-skills'], { cwd, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /Could not propose.*injected link failure/);
  assert.equal(fs.readFileSync(skill, 'utf8'), 'user content\n');
  assert.equal(fs.existsSync(skill + '.atris-proposal'), false);
  assert.ok(fs.readFileSync(skill + '.atris-proposal.pending', 'utf8').length > 0);
});
