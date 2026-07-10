'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LOCAL_FALLBACK_ARGS,
  isBareVitalsArgs,
} = require('../commands/improve');

const skillPath = path.join(__dirname, '..', 'atris', 'skills', 'improve', 'SKILL.md');

test('improve skill matches the live tick, vitals, receipt, and fallback contract', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');

  assert.match(skill, /`atris improve tick`/);
  assert.match(skill, /`atris improve` alone shows .*vitals/i);
  assert.match(skill, /\.atris\/state\/scorecards\.jsonl/);
  assert.match(skill, new RegExp(LOCAL_FALLBACK_ARGS.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(skill, /exactly one (?:mission )?tick/i);
  assert.match(skill, /verifier.*pass/i);
  assert.doesNotMatch(skill, /atris autopilot --auto --iterations=1/);

  assert.equal(isBareVitalsArgs([]), true);
  assert.equal(isBareVitalsArgs(['--json']), true);
  assert.equal(isBareVitalsArgs(['tick']), false);
});
