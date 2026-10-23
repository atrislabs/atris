'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand } = require('../commands/skill');

test('list excludes a missing root even if it appears before discovery finishes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-root-race-'));
  let skillsDir;
  let realRoot;
  const previousCwd = process.cwd();
  const existsSync = fs.existsSync;
  const output = [];
  let checkedLocalRoot = false;

  try {
    process.chdir(root);
    realRoot = process.cwd();
    skillsDir = path.join(realRoot, 'atris', 'skills');
    t.mock.method(console, 'log', (line) => output.push(line));
    t.mock.method(fs, 'existsSync', (candidate) => {
      if (candidate === skillsDir && !checkedLocalRoot) {
        checkedLocalRoot = true;
        const existed = existsSync(candidate);
        // Reproduce a directory appearing immediately after the existence check.
        const skillDir = path.join(skillsDir, 'appeared');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
          '---',
          'name: appeared',
          'description: Use when testing root discovery.',
          'version: 1.0.0',
          'tags: [fixture]',
          '---',
          '1. Run the fixture.',
          ''
        ].join('\n'));
        return existed;
      }
      // Keep bundled skills independent of the checkout's installed content.
      if (!path.isAbsolute(candidate) || !candidate.startsWith(realRoot + path.sep)) return false;
      return existsSync(candidate);
    });

    skillCommand('list', '--json');

    assert.equal(checkedLocalRoot, true);
    assert.deepEqual(output, [JSON.stringify({ ok: true, count: 0, skills: [] }, null, 2)]);
  } finally {
    t.mock.restoreAll();
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
