const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureMemberBundle, memberMarkdown } = require('../lib/member-scaffold');

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
}));
