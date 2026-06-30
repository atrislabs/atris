#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const artifactDir = path.join(root, 'atris', 'runs', 'mission-readable-artifact-demo');

function fail(message) {
  console.error(`HUMAN MISSION ARTIFACT VERIFY FAILED: ${message}`);
  process.exit(1);
}

const required = ['index.md', 'index.html', 'blocks.json'];
for (const name of required) {
  const filePath = path.join(artifactDir, name);
  if (!fs.existsSync(filePath)) fail(`missing ${name}`);
}

const markdown = fs.readFileSync(path.join(artifactDir, 'index.md'), 'utf8');
for (const phrase of [
  'Mission Landing',
  'Task Plan Preview',
  'Blocks',
  'Raw source stays available',
  'index.html',
]) {
  if (!markdown.includes(phrase)) fail(`index.md missing ${phrase}`);
}

const html = fs.readFileSync(path.join(artifactDir, 'index.html'), 'utf8');
for (const phrase of [
  '<title>Mission Landing</title>',
  'Human view over raw JSON',
  'Task Plan Preview',
  'Build this into mission completion',
]) {
  if (!html.includes(phrase)) fail(`index.html missing ${phrase}`);
}

let blocks;
try {
  blocks = JSON.parse(fs.readFileSync(path.join(artifactDir, 'blocks.json'), 'utf8'));
} catch (error) {
  fail(`blocks.json invalid JSON: ${error.message}`);
}

const blockTypes = Array.isArray(blocks.blocks) ? blocks.blocks.map((block) => block.type) : [];
for (const type of ['landing', 'mission_preview', 'timeline', 'next_action']) {
  if (!blockTypes.includes(type)) fail(`blocks.json missing ${type}`);
}

console.log('HUMAN MISSION ARTIFACT VERIFIED');
console.log('artifact=atris/runs/mission-readable-artifact-demo/index.html');
console.log(`blocks=${blockTypes.join(' -> ')}`);
