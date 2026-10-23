'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { findAllSkills } = require('../commands/skill');

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-find-all-skills-'));
  process.env.HOME = root;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  return root;
}

function writeSkill(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

test('findAllSkills reads a top-level skill and a nested skill', () => {
  const root = tempRoot();
  const skillsDir = path.join(root, 'skills');
  const topBody = [
    '---',
    'name: demo-skill',
    'description: Use when the fixture is present',
    '---',
    'Top body.',
    ''
  ].join('\n');
  const nestedBody = [
    '---',
    'name: inner-skill',
    'description: Use when nested',
    '---',
    'Nested body.',
    ''
  ].join('\n');

  try {
    writeSkill(path.join(skillsDir, 'demo-skill'), topBody);
    writeSkill(path.join(skillsDir, 'group', 'inner-skill'), nestedBody);
    fs.writeFileSync(path.join(skillsDir, 'notes.txt'), 'ignore me\n');

    const found = findAllSkills(skillsDir);
    const byFolder = new Map(found.map((skill) => [skill.folder, skill]));

    assert.equal(found.length, 2);
    assert.equal(byFolder.size, 2);

    const top = byFolder.get('demo-skill');
    assert.equal(top.leafFolder, 'demo-skill');
    assert.equal(top.path, path.join(skillsDir, 'demo-skill', 'SKILL.md'));
    assert.equal(top.content, topBody);
    assert.deepStrictEqual(top.frontmatter, {
      name: 'demo-skill',
      description: 'Use when the fixture is present'
    });

    const nested = byFolder.get('group/inner-skill');
    assert.equal(nested.leafFolder, 'inner-skill');
    assert.equal(nested.path, path.join(skillsDir, 'group', 'inner-skill', 'SKILL.md'));
    assert.equal(nested.content, nestedBody);
    assert.deepStrictEqual(nested.frontmatter, {
      name: 'inner-skill',
      description: 'Use when nested'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findAllSkills ignores loose files and does not walk inside a skill folder', () => {
  const root = tempRoot();
  const skillsDir = path.join(root, 'skills');
  const parentBody = '# no frontmatter\n';

  try {
    fs.mkdirSync(skillsDir);
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '---\nname: root-skill\n---\n');
    fs.writeFileSync(path.join(skillsDir, 'readme.txt'), 'not a skill\n');
    writeSkill(path.join(skillsDir, 'parent'), parentBody);
    writeSkill(path.join(skillsDir, 'parent', 'child'), '---\nname: child\n---\n');
    fs.mkdirSync(path.join(skillsDir, 'empty-group', 'still-empty'), { recursive: true });

    const found = findAllSkills(skillsDir);

    assert.equal(found.length, 1);
    assert.equal(found[0].folder, 'parent');
    assert.equal(found[0].leafFolder, 'parent');
    assert.equal(found[0].path, path.join(skillsDir, 'parent', 'SKILL.md'));
    assert.equal(found[0].content, parentBody);
    assert.equal(found[0].frontmatter, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findAllSkills returns nothing for a missing or empty directory and throws on a file', () => {
  const root = tempRoot();

  try {
    assert.deepStrictEqual(findAllSkills(path.join(root, 'does-not-exist')), []);

    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    assert.deepStrictEqual(findAllSkills(empty), []);

    const filePath = path.join(root, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'hello\n');
    assert.throws(
      () => findAllSkills(filePath),
      (err) => {
        assert.equal(err.code, 'ENOTDIR');
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
