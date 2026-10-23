'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zenCommand } = require('../commands/zen');

test('singular team file in check output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-test-'));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;

  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'notes\n');

    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      zenCommand(['--check', '--no-fetch'], dir);
    } finally {
      console.log = origLog;
    }

    assert.ok(lines.some((line) => line.trim() === '1 unsaved team file left in place'));
  } finally {
    process.env.HOME = savedHome || os.tmpdir();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
