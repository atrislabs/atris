#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const roadmapPath = path.join(root, 'ROADMAP.md');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return result;
}

const roadmapCheck = run(process.execPath, ['scripts/verify-valhalla-roadmap.js']);
assert.equal(roadmapCheck.status, 0, roadmapCheck.stderr || roadmapCheck.stdout);

const proofChecks = [
  ['mission landing', process.execPath, ['scripts/verify-mission-landing.js']],
  ['mission doctor', process.execPath, ['scripts/verify-mission-doctor.js']],
  ['loop front door', process.execPath, ['--test', 'test/loop-front.test.js', 'test/run-roadmap.test.js', 'test/moves.test.js']],
];
for (const [label, command, args] of proofChecks) {
  const check = run(command, args);
  assert.equal(check.status, 0, `${label} failed\n${check.stderr || check.stdout}`);
}

const roadmapText = require('node:fs').readFileSync(roadmapPath, 'utf8');
const unfinishedValhallaItems = roadmapText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^- \[( |~)\]\s+Valhalla gate:/i.test(line))
  .map((line) => line.replace(/^- \[( |~)\]\s+/, '').trim());

assert.equal(
  unfinishedValhallaItems.length,
  0,
  `unfinished Valhalla roadmap items remain:\n${unfinishedValhallaItems.map((title) => `- ${title}`).join('\n')}`,
);

const reviews = run('atris', ['task', 'reviews']);
assert.equal(reviews.status, 0, reviews.stderr || reviews.stdout);
assert.match(reviews.stdout, /0 ready to land \/ 0 need one more check \/ 0 total waiting/);

console.log('VALHALLA FINAL GATE PASSED');
