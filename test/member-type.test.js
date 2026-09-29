'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseFrontmatter } = require('../commands/member');
const { chooseTaskOwner, readTeamMembers } = require('../commands/task');
const { memberTypeOf } = require('../lib/member-type');
const { memberRosterEngine, teamRosterView } = require('../lib/member-engine');
const { memberMarkdown } = require('../lib/member-scaffold');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function workspace(members) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-type-'));
  for (const [name, lines] of Object.entries(members)) {
    const dir = path.join(root, 'atris', 'team', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${name}\nrole: Outbound sales\ndescription: Sales outreach\n${lines}---\n\n# ${name}\n`);
  }
  return root;
}

function atris(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

test('missing type means ai, agent is an alias, human and odd values are not runnable', () => {
  assert.equal(memberTypeOf({}).type, 'ai');
  assert.equal(memberTypeOf(null).runnable, true);
  assert.equal(memberTypeOf({ type: 'ai' }).runnable, true);
  assert.equal(memberTypeOf({ type: 'Agent' }).type, 'ai');
  assert.equal(memberTypeOf({ type: 'human' }).type, 'human');
  assert.equal(memberTypeOf({ type: 'human' }).runnable, false);
  assert.equal(memberTypeOf({ type: 'robot' }).type, 'other');
});

test('both frontmatter readers expose the type with the same rules', () => {
  const root = workspace({ plain: '', agent: 'type: agent\n', bob: 'type: human\n', odd: 'type: robot\n' });
  const types = Object.fromEntries(readTeamMembers(root).map((m) => [m.slug, m.type]));
  assert.deepEqual(types, { plain: 'ai', agent: 'ai', bob: 'human', odd: 'other' });
  const text = fs.readFileSync(path.join(root, 'atris', 'team', 'bob', 'MEMBER.md'), 'utf8');
  assert.equal(memberTypeOf(parseFrontmatter(text)).type, 'human');
});

test('wake refuses a human member with the reason and a non-zero exit', () => {
  const root = workspace({ bob: 'type: human\n' });
  const res = atris(root, 'member', 'wake', 'bob');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /bob is a person, not an AI teammate; Atris can prepare work for them but cannot act as them/);
});

test('wake, tick, loop, and run refuse an odd-typed member', () => {
  const root = workspace({ ann: 'type: robot\n' });
  for (const cmd of ['wake', 'tick', 'loop', 'run']) {
    const res = atris(root, 'member', cmd, 'ann');
    assert.notEqual(res.status, 0, cmd);
    assert.match(res.stderr, /ann has type 'robot', which is neither ai nor human, so Atris won't run it/, cmd);
  }
});

test('an ai member is not refused for its type', () => {
  const root = workspace({ ann: 'type: agent\n' });
  const res = atris(root, 'member', 'wake', 'ann');
  assert.doesNotMatch(res.stderr, /neither ai nor human|is a person/);
});

test('task routing skips human and odd members but honors a named owner', () => {
  const root = workspace({ bob: 'type: human\n', ann: 'type: robot\n' });
  const auto = chooseTaskOwner({ purpose: 'outbound sales outreach', root });
  assert.equal(auto.source, 'fallback');
  const named = chooseTaskOwner({ purpose: 'anything', requestedOwner: 'bob', root });
  assert.equal(named.owner, 'bob');
  assert.equal(named.source, 'requested');
  const withAi = workspace({ bob: 'type: human\n', zed: '' });
  assert.equal(chooseTaskOwner({ purpose: 'outbound sales outreach', root: withAi }).owner, 'zed');
});

test('engine roster leaves out a human member and never picks an engine for one', () => {
  const root = workspace({ bob: 'type: human\n', zed: '' });
  const names = teamRosterView(root).rows.map((r) => r.member);
  assert.ok(names.includes('zed'));
  assert.ok(!names.includes('bob'));
  assert.equal(memberRosterEngine('bob', root), null);
});

test('new member templates carry type: ai with the comment on its own line', () => {
  const text = memberMarkdown({ name: 'x', role: 'Tester', description: 'Tests' });
  assert.match(text, /^# ai or human[^\n]*\ntype: ai\n/m);
  assert.equal(parseFrontmatter(text).type, 'ai');
});
