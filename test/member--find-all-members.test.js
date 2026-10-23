'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-find-all-members-'));
process.env.HOME = sandbox;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { findAllMembers } = require('../commands/member');

test.after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let counter = 0;
function makeTeamDir() {
  counter += 1;
  const dir = path.join(sandbox, `team-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function byName(members) {
  return [...members].sort((a, b) => a.name.localeCompare(b.name));
}

test('findAllMembers reads a directory member with frontmatter, skills, context, and tools', () => {
  const teamDir = makeTeamDir();
  const memberDir = path.join(teamDir, 'navigator');
  write(path.join(memberDir, 'MEMBER.md'), [
    '---',
    'name: navigator',
    'role: Route planner',
    'description: Finds the right file',
    'version: 1.2.0',
    'skills: [plan, route]',
    'permissions:',
    '  can-read: true',
    '  can-write: false',
    '---',
    '',
    '# Navigator',
    '',
  ].join('\n'));
  write(path.join(memberDir, 'skills', 'plan', 'SKILL.md'), '# plan\n');
  write(path.join(memberDir, 'skills', 'route', 'SKILL.md'), '# route\n');
  // A skills subfolder without SKILL.md must not be counted.
  fs.mkdirSync(path.join(memberDir, 'skills', 'empty'), { recursive: true });
  write(path.join(memberDir, 'context', 'one.md'), '# one\n');
  write(path.join(memberDir, 'context', 'two.md'), '# two\n');
  // Only .md files count as context.
  write(path.join(memberDir, 'context', 'notes.txt'), 'not markdown\n');
  fs.mkdirSync(path.join(memberDir, 'tools'), { recursive: true });

  const members = findAllMembers(teamDir);
  assert.equal(members.length, 1);

  const m = members[0];
  assert.equal(m.name, 'navigator');
  assert.equal(m.role, 'Route planner');
  assert.equal(m.description, 'Finds the right file');
  assert.equal(m.version, '1.2.0');
  assert.equal(m.format, 'directory');
  assert.equal(m.path, path.join(memberDir, 'MEMBER.md'));
  assert.equal(m.dir, memberDir);
  assert.equal(m.skillCount, 2);
  assert.equal(m.contextCount, 2);
  assert.equal(m.hasTools, true);
  assert.deepEqual(m.skills, ['plan', 'route']);
  assert.deepEqual(m.permissions, { 'can-read': true, 'can-write': false });
  assert.equal(m.frontmatter.role, 'Route planner');
});

test('findAllMembers falls back to folder name and defaults when a directory member has no frontmatter', () => {
  const teamDir = makeTeamDir();
  write(path.join(teamDir, 'scribe', 'MEMBER.md'), '# Scribe\n\nJust a body, no frontmatter.\n');

  const members = findAllMembers(teamDir);
  assert.equal(members.length, 1);

  const m = members[0];
  assert.equal(m.name, 'scribe');
  assert.equal(m.role, '(no role)');
  assert.equal(m.description, '');
  assert.equal(m.version, '');
  assert.equal(m.format, 'directory');
  assert.equal(m.skillCount, 0);
  assert.equal(m.contextCount, 0);
  assert.equal(m.hasTools, false);
  assert.deepEqual(m.skills, []);
  assert.deepEqual(m.permissions, {});
  assert.deepEqual(m.frontmatter, {});
});

test('findAllMembers lets the frontmatter name override the folder name', () => {
  const teamDir = makeTeamDir();
  write(path.join(teamDir, 'folder-name', 'MEMBER.md'), '---\nname: display-name\nrole: Tester\n---\n\nBody\n');

  const members = findAllMembers(teamDir);
  assert.equal(members.length, 1);
  assert.equal(members[0].name, 'display-name');
  assert.equal(members[0].dir, path.join(teamDir, 'folder-name'));
});

test('findAllMembers parses a CRLF MEMBER.md instead of dropping its frontmatter', () => {
  const teamDir = makeTeamDir();
  const crlf = ['---', 'name: winner', 'role: Windows author', 'skills: [a, b]', '---', '', '# Body', ''].join('\r\n');
  write(path.join(teamDir, 'winner', 'MEMBER.md'), crlf);

  const members = findAllMembers(teamDir);
  assert.equal(members.length, 1);
  assert.equal(members[0].name, 'winner');
  assert.equal(members[0].role, 'Windows author');
  assert.deepEqual(members[0].skills, ['a', 'b']);
});

test('findAllMembers reads flat .md members and skips flat files that are not members', () => {
  const teamDir = makeTeamDir();
  write(path.join(teamDir, 'flat-one.md'), '---\nrole: Flat role\ndescription: A flat member\nskills: [x]\n---\n\nBody\n');
  write(path.join(teamDir, 'flat-typed.md'), '---\nname: typed-member\ntype: member\n---\n\nBody\n');
  // No frontmatter at all: not a member.
  write(path.join(teamDir, 'README.md'), '# Team readme\n\nNo frontmatter here.\n');
  // Frontmatter with a non-member type: an index/doc file.
  write(path.join(teamDir, 'ASSIGNMENTS.md'), '---\ntype: index\n---\n\n# Assignments\n');
  // Not markdown.
  write(path.join(teamDir, 'notes.txt'), '---\nname: nope\n---\n');

  const members = byName(findAllMembers(teamDir));
  assert.deepEqual(members.map((m) => m.name), ['flat-one', 'typed-member']);

  const flat = members[0];
  assert.equal(flat.format, 'flat');
  assert.equal(flat.role, 'Flat role');
  assert.equal(flat.description, 'A flat member');
  assert.equal(flat.path, path.join(teamDir, 'flat-one.md'));
  assert.equal(flat.dir, teamDir);
  assert.equal(flat.skillCount, 0);
  assert.equal(flat.contextCount, 0);
  assert.equal(flat.hasTools, false);
  assert.deepEqual(flat.skills, ['x']);

  assert.equal(members[1].role, '(no role)');
});

test('findAllMembers skips template, archive, hidden entries and folders without MEMBER.md', () => {
  const teamDir = makeTeamDir();
  write(path.join(teamDir, 'keeper', 'MEMBER.md'), '---\nname: keeper\nrole: Stays\n---\n');
  write(path.join(teamDir, '_template', 'MEMBER.md'), '---\nname: template\n---\n');
  write(path.join(teamDir, '_archive', 'MEMBER.md'), '---\nname: archived-a\n---\n');
  write(path.join(teamDir, '_archived', 'MEMBER.md'), '---\nname: archived-b\n---\n');
  write(path.join(teamDir, '.hidden', 'MEMBER.md'), '---\nname: hidden\n---\n');
  write(path.join(teamDir, '.hidden-flat.md'), '---\nname: hidden-flat\n---\n');
  // A folder with no MEMBER.md is not a member.
  write(path.join(teamDir, 'not-a-member', 'README.md'), '# nothing\n');

  const members = findAllMembers(teamDir);
  assert.deepEqual(members.map((m) => m.name), ['keeper']);
});

test('findAllMembers mixes directory and flat members in one team folder', () => {
  const teamDir = makeTeamDir();
  write(path.join(teamDir, 'alpha', 'MEMBER.md'), '---\nname: alpha\nrole: Dir member\n---\n');
  write(path.join(teamDir, 'beta.md'), '---\nname: beta\nrole: Flat member\n---\n');

  const members = byName(findAllMembers(teamDir));
  assert.deepEqual(
    members.map((m) => [m.name, m.format]),
    [['alpha', 'directory'], ['beta', 'flat']],
  );
});

test('findAllMembers returns an empty list for a missing team folder', () => {
  const missing = path.join(sandbox, 'does-not-exist');
  assert.equal(fs.existsSync(missing), false);
  assert.deepEqual(findAllMembers(missing), []);
});

test('findAllMembers returns an empty list for an empty team folder', () => {
  assert.deepEqual(findAllMembers(makeTeamDir()), []);
});
