'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listWorkspaceMemberSlugs } = require('../lib/functional-owner');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-owner-slugs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function addMember(root, name, contents = '# Member\n') {
  const directory = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'MEMBER.md'), contents);
}

test('lists member folders and excludes templates, files, and folders without MEMBER.md', (t) => {
  const root = workspace(t);
  addMember(root, 'architect');
  addMember(root, 'validator');
  addMember(root, '_template');
  const team = path.join(root, 'atris', 'team');
  fs.mkdirSync(path.join(team, 'unfinished'));
  fs.mkdirSync(path.join(team, 'lowercase-card'));
  fs.writeFileSync(path.join(team, 'lowercase-card', 'member.txt'), '# Member\n');
  fs.writeFileSync(path.join(team, 'README.md'), '# Team\n');

  const result = listWorkspaceMemberSlugs(root);
  assert.ok(result instanceof Set);
  assert.deepStrictEqual(result, new Set(['architect', 'validator']));
});

test('normalizes folder names, deduplicates slugs, and includes parked members', (t) => {
  const root = workspace(t);
  addMember(root, ' Task Planner! ');
  addMember(root, 'task_planner');
  addMember(root, 'Wiki...Miner');
  addMember(root, 'researcher', '---\nstatus: parked\n---\n');

  assert.deepStrictEqual(
    listWorkspaceMemberSlugs(root),
    new Set(['task-planner', 'wiki-miner', 'researcher'])
  );
});

test('returns an empty set for missing, empty, or non-directory team paths', (t) => {
  const root = workspace(t);
  assert.deepStrictEqual(listWorkspaceMemberSlugs(root), new Set());

  const team = path.join(root, 'atris', 'team');
  fs.mkdirSync(team, { recursive: true });
  assert.deepStrictEqual(listWorkspaceMemberSlugs(root), new Set());

  fs.rmdirSync(team);
  fs.writeFileSync(team, 'not a directory\n');
  assert.deepStrictEqual(listWorkspaceMemberSlugs(root), new Set());
});
