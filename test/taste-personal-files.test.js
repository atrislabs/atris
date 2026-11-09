'use strict';

// Taste is personal. The shipped skill only says how taste files work; the
// taste itself lives in the project's atris/taste/ and the person's
// ~/.atris/taste/, and an update must never touch either.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncAtris } = require('../commands/sync');
const { ensureProjectTasteFile } = require('../lib/taste-notes');

const repoRoot = path.join(__dirname, '..');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-files-test-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  t.after(() => {
    console.log = log;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME);
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'atris'), { recursive: true });
  process.chdir(project);
  console.log = () => {};
  return { project, home: process.env.HOME };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('an update leaves both personal taste locations exactly as they were', (t) => {
  const { project, home } = workspace(t);
  const personal = path.join(home, '.atris/taste/TASTE.md');
  const personalNote = path.join(home, '.atris/taste/copy.md');
  const projectTaste = path.join(project, 'atris/taste/TASTE.md');
  const projectNote = path.join(project, 'atris/taste/buttons.md');
  write(personal, '# My taste\n\n- Short sentences. [copy](copy.md)\n');
  write(personalNote, '# Copy\n\n- I said keep it short.\n');
  write(projectTaste, '# Project taste\n\n- Our green, never blue. [buttons](buttons.md)\n');
  write(projectNote, '# Buttons\n\n- One green button.\n');
  const before = [personal, personalNote, projectTaste, projectNote].map(file => fs.readFileSync(file, 'utf8'));

  syncAtris({ dryRun: false, yes: true, force: false });
  syncAtris({ dryRun: false, yes: true, force: false });

  assert.deepStrictEqual([personal, personalNote, projectTaste, projectNote].map(file => fs.readFileSync(file, 'utf8')), before);
  assert.ok(fs.existsSync(path.join(project, 'atris/skills/taste/SKILL.md')), 'the shipped skill still lands');
  assert.deepStrictEqual(fs.readdirSync(path.join(project, 'atris/skills/taste')).sort(), ['SKILL.md', 'notes.md', 'principles.md']);
});

test('a project with no taste files gets a starter once and keeps working', (t) => {
  const { project, home } = workspace(t);
  syncAtris({ dryRun: false, yes: true, force: false });
  const starter = path.join(project, 'atris/taste/TASTE.md');
  assert.match(fs.readFileSync(starter, 'utf8'), /^# Taste/);
  assert.strictEqual(fs.existsSync(path.join(home, '.atris/taste')), false, 'nothing is written to the home folder');

  fs.writeFileSync(starter, '# Taste\n\n- Edited by the project.\n');
  syncAtris({ dryRun: false, yes: true, force: false });
  assert.strictEqual(fs.readFileSync(starter, 'utf8'), '# Taste\n\n- Edited by the project.\n');
  assert.strictEqual(ensureProjectTasteFile(path.join(project, 'atris')), false);
});

test('a dry run does not create the starter', (t) => {
  const { project } = workspace(t);
  syncAtris({ dryRun: true, yes: false, force: false });
  assert.strictEqual(fs.existsSync(path.join(project, 'atris/taste')), false);
});

test('the shipped taste skill holds no one person\'s picks', () => {
  const dir = path.join(repoRoot, 'atris/skills/taste');
  const text = fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
  assert.doesNotMatch(text, /the owner|Keshav|loves\.md|beat "|2026-11-07/);
});
