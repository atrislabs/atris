const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function withTempWorkspace(run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-create-'));
  try {
    return run(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function runMember(workspace, args) {
  return spawnSync(process.execPath, [cliPath, 'member', ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
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

test('member create writes the complete Atris identity bundle', () => withTempWorkspace(workspace => {
  const result = runMember(workspace, [
    'create',
    'customer-guide',
    '--role=Customer Guide',
    '--description=Keep customers moving with clear answers',
  ]);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const memberDir = path.join(workspace, 'atris', 'team', 'customer-guide');
  assertCompleteBundle(memberDir, 'customer-guide');
  assert.match(fs.readFileSync(path.join(memberDir, 'MEMBER.md'), 'utf8'), /role: Customer Guide/);
  assert.match(fs.readFileSync(path.join(memberDir, 'logs', fs.readdirSync(path.join(memberDir, 'logs'))[0]), 'utf8'), /source: cli/);
}));

test('member upgrade preserves MEMBER.md and backfills the complete bundle', () => withTempWorkspace(workspace => {
  const teamDir = path.join(workspace, 'atris', 'team');
  fs.mkdirSync(teamDir, { recursive: true });
  const original = '---\nname: scout\n---\n\n# Scout\n';
  fs.writeFileSync(path.join(teamDir, 'scout.md'), original, 'utf8');

  const result = runMember(workspace, ['upgrade', 'scout']);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const memberDir = path.join(teamDir, 'scout');
  assertCompleteBundle(memberDir, 'scout');
  assert.equal(fs.readFileSync(path.join(memberDir, 'MEMBER.md'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(teamDir, 'scout.md')), false);
}));
