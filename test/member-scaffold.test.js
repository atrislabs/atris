const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnSync } = require('node:child_process');

const { ensureMemberBundle, memberMarkdown, memberBundlePresent } = require('../lib/member-scaffold');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(workspace, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

function withTempMember(run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-scaffold-'));
  try {
    return run(path.join(workspace, 'atris', 'team', 'orb'));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function assertCompleteBundle(memberDir, name) {
  for (const fileName of ['MEMBER.md', 'SOUL.md', 'MISSION.md', 'goals.json', 'goals.md']) {
    assert.ok(fs.statSync(path.join(memberDir, fileName)).isFile(), `${fileName} should exist`);
  }
  for (const dirName of ['skills', 'tools', 'context', 'logs']) {
    assert.ok(fs.statSync(path.join(memberDir, dirName)).isDirectory(), `${dirName}/ should exist`);
  }
  const logs = fs.readdirSync(path.join(memberDir, 'logs')).filter(file => file.endsWith('.md'));
  assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(memberDir, 'SOUL.md'), 'utf8'), /## Beliefs[\s\S]*## Values[\s\S]*## Lessons[\s\S]*## Edges[\s\S]*## Voice/);
  assert.match(fs.readFileSync(path.join(memberDir, 'MISSION.md'), 'utf8'), /## North Star/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(memberDir, 'goals.json'), 'utf8')).goals, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(memberDir, 'goals.json'), 'utf8')).member, name);
}

test('ensureMemberBundle without memberContent creates MEMBER.md plus the full bundle', () => withTempMember(memberDir => {
  const now = new Date('2026-08-20T15:00:00');
  const result = ensureMemberBundle(memberDir, { name: 'orb', now });

  assertCompleteBundle(memberDir, 'orb');
  assert.ok(result.created.includes('MEMBER.md'));
  const memberFile = fs.readFileSync(path.join(memberDir, 'MEMBER.md'), 'utf8');
  assert.equal(memberFile, memberMarkdown({
    name: 'orb',
    role: 'member',
    description: 'Define why this member exists and how it chooses goals.',
  }));
  assert.match(memberFile, /^role: member$/m);
  assert.match(memberFile, /## Mission\n\nDefine why this member exists and how it chooses goals\./);
  assert.ok(fs.existsSync(path.join(memberDir, 'logs', '2026-08-20.md')));
}));

test('ensureMemberBundle with memberContent uses it verbatim', () => withTempMember(memberDir => {
  const memberContent = '---\nname: orb\nrole: Guide\n---\n\n# Custom orb copy\n';
  ensureMemberBundle(memberDir, { name: 'orb', memberContent });

  assertCompleteBundle(memberDir, 'orb');
  assert.equal(fs.readFileSync(path.join(memberDir, 'MEMBER.md'), 'utf8'), memberContent);
}));

test('ensureMemberBundle leaves an existing MEMBER.md untouched', () => withTempMember(memberDir => {
  fs.mkdirSync(memberDir, { recursive: true });
  const original = '---\nname: orb\n---\n\n# Keep this identity\n';
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), original, 'utf8');

  const result = ensureMemberBundle(memberDir, {
    name: 'orb',
    memberContent: '---\nname: overwritten\n---\n\n# Should not land\n',
  });

  assertCompleteBundle(memberDir, 'orb');
  assert.equal(fs.readFileSync(path.join(memberDir, 'MEMBER.md'), 'utf8'), original);
  assert.equal(result.created.includes('MEMBER.md'), false);
  assert.equal(memberBundlePresent(memberDir), true);
}));

function withTempWorkspace(run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-install-verbs-'));
  try {
    return run(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('member install writes the full bundle into a temp dir', () => withTempWorkspace(workspace => {
  const result = runCli(workspace, ['member', 'install', 'orb']);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const memberDir = path.join(workspace, 'atris', 'team', 'orb');
  assertCompleteBundle(memberDir, 'orb');
  assert.match(result.stdout, /^atris\/team\/orb\/MEMBER\.md$/m);
  assert.match(result.stdout, /^atris\/team\/orb\/SOUL\.md$/m);
  assert.match(result.stdout, /^atris\/team\/orb\/MISSION\.md$/m);
  assert.match(result.stdout, /MEMBER installed for orb\.\n$/);
}));

test('member install second run is a no-op', () => withTempWorkspace(workspace => {
  const first = runCli(workspace, ['member', 'install', 'guide']);
  assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  const memberDir = path.join(workspace, 'atris', 'team', 'guide');
  const before = fs.readFileSync(path.join(memberDir, 'MEMBER.md'), 'utf8');

  const second = runCli(workspace, ['member', 'install', 'guide']);
  assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  assert.equal(second.stdout, 'MEMBER already installed for guide\n');
  assert.equal(fs.readFileSync(path.join(memberDir, 'MEMBER.md'), 'utf8'), before);
}));

test('atris install writes the brain files', () => withTempWorkspace(workspace => {
  const result = runCli(workspace, ['install']);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const atrisDir = path.join(workspace, 'atris');
  for (const fileName of ['MAP.md', 'TODO.md', 'now.md', 'atris.md']) {
    assert.ok(fs.statSync(path.join(atrisDir, fileName)).isFile(), `${fileName} should exist`);
  }
  assert.ok(fs.statSync(path.join(atrisDir, 'wiki', 'index.md')).isFile());
  assert.ok(fs.statSync(path.join(atrisDir, 'team')).isDirectory());
  const logsDir = path.join(atrisDir, 'logs');
  const now = new Date();
  const yearDir = path.join(logsDir, String(now.getFullYear()));
  // Local calendar day, matching lib/file-ops getLogPath (UTC drifts a day
  // ahead every evening west of Greenwich).
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.ok(fs.statSync(path.join(yearDir, `${today}.md`)).isFile(), 'first dated log should exist');
  assert.match(result.stdout, /^atris\/MAP\.md$/m);
  assert.doesNotMatch(result.stdout, /Atris already installed/);
}));

test('atris install second run is a no-op', () => withTempWorkspace(workspace => {
  const first = runCli(workspace, ['workspace', 'install']);
  assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  const mapPath = path.join(workspace, 'atris', 'MAP.md');
  const original = fs.readFileSync(mapPath, 'utf8');
  fs.writeFileSync(mapPath, '# keep this map\n', 'utf8');

  const second = runCli(workspace, ['install']);
  assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  assert.equal(second.stdout, 'Atris already installed.\n');
  assert.equal(fs.readFileSync(mapPath, 'utf8'), '# keep this map\n');
  assert.notEqual(fs.readFileSync(mapPath, 'utf8'), original);
}));
