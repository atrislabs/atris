'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { activateAtris } = require('../commands/activate');

function createWorkspace(root, featureNames) {
  const atrisDir = path.join(root, 'atris');
  const featuresDir = path.join(atrisDir, 'features');
  fs.mkdirSync(featuresDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });

  for (const name of featureNames) {
    const dir = path.join(featuresDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'idea.md'),
      '# Feature\n\n**Status:** in-progress\n',
      'utf8',
    );
  }

  fs.writeFileSync(path.join(atrisDir, 'PERSONA.md'), '# persona\n', 'utf8');
  fs.writeFileSync(path.join(atrisDir, 'MAP.md'), '# map\n', 'utf8');
  fs.writeFileSync(
    path.join(atrisDir, 'TODO.md'),
    '# work\n\n## Backlog\n\n## In Progress\n\n## Completed\n',
    'utf8',
  );
}

test('narrates single in-progress feature with singular subject', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-feat-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-home-'));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  const origLog = console.log;
  const origExit = process.exit;
  const lines = [];

  try {
    process.env.HOME = home;
    createWorkspace(root, ['alpha-feature']);
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => {
      throw new Error(`process.exit: ${code}`);
    };

    activateAtris();

    const output = lines.join('\n');
    assert.match(output, /\bone feature is in progress\b/);
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(prevCwd);
    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('narrates multiple in-progress features with plural subject', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-feat-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-home-'));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  const origLog = console.log;
  const origExit = process.exit;
  const lines = [];

  try {
    process.env.HOME = home;
    createWorkspace(root, ['beta-feature', 'gamma-feature']);
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => {
      throw new Error(`process.exit: ${code}`);
    };

    activateAtris();

    const output = lines.join('\n');
    assert.match(output, /\btwo features are in progress\b/);
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(prevCwd);
    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
