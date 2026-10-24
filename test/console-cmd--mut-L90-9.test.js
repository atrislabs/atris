'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('workspace skills override a same-named personal skill without duplicates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-dedup-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    for (const folder of ['atris/skills/writer', '.claude/skills/writer', '.codex/skills/writer']) {
      const dir = path.join(root, folder);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: writer\ndescription: draft prose\n---\nWrite clearly.\n');
    }
    const { gatherAtrisContext } = require('../commands/console');
    const context = gatherAtrisContext(root);
    assert.equal(context.skills.filter(skill => skill.name === 'writer').length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
