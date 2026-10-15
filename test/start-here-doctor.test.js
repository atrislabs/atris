const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { collectDoctor, renderDoctor } = require('../commands/doctor');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-start-here-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function folder(name, { members = [], git = false } = {}) {
  const root = path.join(scratch, name);
  fs.mkdirSync(path.join(root, 'atris', 'team', '_template'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# atris\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', '_template', 'MEMBER.md'), '# template\n');
  for (const m of members) {
    fs.mkdirSync(path.join(root, 'atris', 'team', m), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', m, 'MEMBER.md'), `# ${m}\n`);
  }
  if (git) fs.mkdirSync(path.join(root, '.git'));
  return root;
}

test('top help shows the first three steps, in order, and still fits one screen', () => {
  const help = runCli(['help'], scratch);
  assert.equal(help.status, 0, help.stderr);
  const lines = help.stdout.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'Start here:');
  assert.ok(start > 0, 'help has a Start here block');
  assert.match(lines[start + 1], /^\s+1\. atris init\b/);
  assert.match(lines[start + 2], /^\s+2\. atris doctor\b/);
  assert.match(lines[start + 3], /^\s+3\. atris "/);
  assert.ok(lines.filter((l) => l.trim()).length <= 16, 'default help still fits one screen');
  assert.doesNotMatch(help.stdout, /—/);
});

test('doctor says members are ready when team, git, and a coding tool are all there', () => {
  const root = folder('ready', { members: ['builder'], git: true });
  const payload = collectDoctor({ cwd: root, binInstalled: (bin) => bin === 'git' || bin === 'codex' });
  assert.equal(payload.members.ready, true);
  assert.equal(payload.members.members, 1);
  assert.deepEqual(payload.members.member_names, ['builder']);
  assert.deepEqual(payload.members.tools, ['codex']);
  assert.equal(payload.members.next, null);
  const text = renderDoctor(payload);
  assert.match(text, /members: ready/);
  assert.match(text, /coding tool: codex/);
});

test('doctor names the first missing piece in one plain fix line', () => {
  const noTeam = collectDoctor({ cwd: folder('no-team', { git: true }), binInstalled: () => true });
  assert.equal(noTeam.members.ready, false);
  assert.equal(noTeam.members.members, 0, 'the _template folder is not a member');
  assert.match(noTeam.members.next, /atris init/);

  const noGit = collectDoctor({ cwd: folder('no-git', { members: ['a'] }), binInstalled: () => true });
  assert.match(noGit.members.next, /git init/);

  const noGitBin = collectDoctor({ cwd: folder('no-git-bin', { members: ['a'], git: true }), binInstalled: (b) => b !== 'git' });
  assert.match(noGitBin.members.next, /install git/);

  const noTool = collectDoctor({ cwd: folder('no-tool', { members: ['a'], git: true }), binInstalled: (b) => b === 'git' });
  if (!noTool.auth.signed_in) {
    assert.equal(noTool.members.ready, false);
    assert.match(noTool.members.next, /claude code or codex/);
    assert.match(renderDoctor(noTool), /next: install claude code or codex/);
  } else {
    assert.equal(noTool.members.built_in_tool, true, 'a sign-in unlocks the built-in tool');
    assert.equal(noTool.members.ready, true);
  }
});

test('atris doctor --json carries the members check for agents', () => {
  const root = folder('json', { members: ['builder'], git: true });
  const result = runCli(['doctor', '--json'], root);
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.members.ready, 'boolean');
  assert.equal(payload.members.members, 1);
  assert.equal(payload.members.git_repo, true);
  assert.ok(Array.isArray(payload.members.tools));
});
