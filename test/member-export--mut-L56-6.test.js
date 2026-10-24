'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportMembers } = require('../lib/member-export');

test('blank skill entries do not become skill links in agent instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-member-skills-'));
  const memberDir = path.join(root, 'atris', 'team', 'validator');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'),
    '---\nname: validator\nrole: Reviewer\nskills:\n  - ""\n  - test-runner\n---\n# Validator\n');

  exportMembers(root);

  const instructions = fs.readFileSync(path.join(root, '.claude', 'agents', 'validator.md'), 'utf8');
  assert.doesNotMatch(instructions, /skills\/\/SKILL\.md/);
});
