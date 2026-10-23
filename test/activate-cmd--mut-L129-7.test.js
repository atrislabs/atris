'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { activateAtris } = require('../commands/activate');

test('activation counts every in-progress feature, including ones it does not name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-activate-feature-count-'));
  const featuresDir = path.join(root, 'atris', 'features');
  for (const name of ['birch', 'cedar', 'maple']) {
    fs.mkdirSync(path.join(featuresDir, name), { recursive: true });
    fs.writeFileSync(
      path.join(featuresDir, name, 'idea.md'),
      '**Status:** in-progress\n',
      'utf8',
    );
  }
  fs.writeFileSync(path.join(root, 'atris', 'PERSONA.md'), '# persona\n', 'utf8');
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# map\n', 'utf8');

  const focus = fs.readdirSync(featuresDir)
    .filter((name) => {
      if (name.startsWith('_')) return false;
      try {
        return fs.statSync(path.join(featuresDir, name)).isDirectory();
      } catch {
        return false;
      }
    })[0]
    .replace(/[-_]+/g, ' ');

  const previousCwd = process.cwd();
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    process.chdir(root);
    activateAtris();
    const rightNow = lines.find((line) => line.startsWith('right now:'));
    assert.equal(
      rightNow,
      `right now: three features are in progress; the focus is ${focus}.`,
    );
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
