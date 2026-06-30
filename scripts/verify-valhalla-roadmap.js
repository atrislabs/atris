#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const roadmapPath = path.join(root, 'ROADMAP.md');
const valhallaPath = path.join(root, 'atris', 'VALHALLA.md');
const roadmap = fs.readFileSync(roadmapPath, 'utf8');
const valhalla = fs.readFileSync(valhallaPath, 'utf8');
const nextMoves = require(path.join(root, 'lib', 'next-moves'));
const expected = [
  'Valhalla gate: make `atris mission run` print one dream-product landing from intent to proof to next move, with no internal runner plumbing',
  'Valhalla gate: add a mission doctor that flags no-verifier missions, accidental help missions, stale ready receipts, and blocked always-on loops',
  'Valhalla gate: make review acceptance update XP, brain scorecards, and next mission routing in one visible receipt',
  'Valhalla gate: collapse ROADMAP, Endgame, and active missions into one ranked next-move source for `atris loop`',
  'Valhalla gate: write the remote-computer acceptance test for mission parity between local and cloud execution',
];

assert.match(roadmap, /# Atris roadmap: mission run to Valhalla/);
assert.match(roadmap, /## Valhalla gates/);
assert.match(roadmap, /One command, zero confusion/);
assert.match(roadmap, /Proof economy/);
assert.match(roadmap, /Durable cloud loop/);

const valhallaRows = roadmap
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^- \[( |~|x)\]\s+Valhalla gate:/i.test(line))
  .map((line) => line.replace(/^- \[( |~|x)\]\s+/, '').trim());
assert.ok(valhallaRows.length >= expected.length, 'expected Valhalla roadmap rows');
for (const title of expected) assert.ok(valhallaRows.includes(title), `missing roadmap row: ${title}`);

const open = nextMoves.readRoadmapOpenItems(root)
  .map((item) => item.title)
  .filter((title) => /^Valhalla gate:/i.test(title));

assert.match(valhalla, /## Valhalla Gate 1/);
assert.match(valhalla, /## Valhalla Gate 6/);
assert.match(valhalla, /nothing untrue enters durable state/);

console.log('VALHALLA ROADMAP VERIFIED');
console.log(`open_valhalla_items=${open.length}`);
if (open[0]) console.log(`next="${open[0]}"`);
