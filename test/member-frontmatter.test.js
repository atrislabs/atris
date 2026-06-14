'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter } = require('../commands/member');

const LF = [
  '---',
  'name: navigator',
  'role: Planner',
  'skills: [plan, route]',
  'permissions:',
  '  can-read: true',
  '  can-write: false',
  '---',
  '',
  '# Body',
  '',
].join('\n');

test('parseFrontmatter reads scalars, inline arrays, and nested maps (LF)', () => {
  const fm = parseFrontmatter(LF);
  assert.ok(fm);
  assert.equal(fm.name, 'navigator');
  assert.equal(fm.role, 'Planner');
  assert.deepEqual(fm.skills, ['plan', 'route']);
  assert.equal(fm.permissions['can-read'], true);
  assert.equal(fm.permissions['can-write'], false);
});

test('parseFrontmatter returns null when there is no frontmatter block', () => {
  assert.equal(parseFrontmatter('# Just a heading\n\nbody\n'), null);
});

// --- CRLF regression: a Windows-edited MEMBER.md must not lose its identity ---

test('parseFrontmatter parses a CRLF MEMBER.md identically to LF', () => {
  const crlf = LF.replace(/\n/g, '\r\n');
  assert.deepEqual(parseFrontmatter(crlf), parseFrontmatter(LF));
});

test('parseFrontmatter does not drop frontmatter on CRLF (was returning null)', () => {
  const crlf = LF.replace(/\n/g, '\r\n');
  const fm = parseFrontmatter(crlf);
  assert.ok(fm, 'CRLF frontmatter must parse, not return null');
  assert.equal(fm.role, 'Planner');
  assert.deepEqual(fm.skills, ['plan', 'route']);
  assert.equal(fm.permissions['can-read'], true);
});
